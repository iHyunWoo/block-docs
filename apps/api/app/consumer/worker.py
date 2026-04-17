"""OperationConsumer — the Redis Stream → DB worker.

Responsibilities:
  * For `kind=crdt` entries, apply the Yjs delta to the owning block's
    persisted state, recompute the JSON content view, write both back
    atomically, and XACK the entry.
  * For `kind=ops` entries, XACK only — the REST route already wrote the
    DB + doc_operations rows before publishing.

This worker is stateless: no in-memory Y.Doc is ever kept across messages.
Each delta is handled in a fresh Doc built from DB state, applied, and
discarded.

Horizontal scaling works out-of-the-box because the consumer group name
is shared (`block-ops`) and the consumer name is unique per process
(hostname + pid). Redis hands each entry to exactly one consumer.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
from typing import Any

import asyncpg
import redis.asyncio as aioredis

from app.consumer.crdt import (
    apply_delta,
    encode_state,
    extract_content,
    make_doc,
)
from app.redis_bus import (
    STREAM_CONSUMER_GROUP,
    STREAM_SCAN_PATTERN,
)


log = logging.getLogger(__name__)


# How often to re-scan SCAN MATCH doc:*:stream to pick up new docs. Fast
# enough that a newly-created doc starts getting consumed within a few
# seconds.
DISCOVERY_INTERVAL_SECONDS = 5
XREAD_COUNT = 50
XREAD_BLOCK_MS = 2000


class OperationConsumer:
    def __init__(self, pool: asyncpg.Pool, redis: aioredis.Redis) -> None:
        self.pool = pool
        self.redis = redis
        self.consumer_name = f"{socket.gethostname()}-{os.getpid()}"
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._known_streams: set[str] = set()
        self._last_scan_at: float = 0.0

    # ------------------------------------------------------------------ run

    def start(self) -> None:
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._run(), name="operation-consumer")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            await asyncio.wait_for(self._task, timeout=5)

    async def _run(self) -> None:
        log.info("OperationConsumer started as %s", self.consumer_name)
        try:
            while not self._stop.is_set():
                try:
                    await self._discover_streams_if_needed()
                    if not self._known_streams:
                        # No docs yet; sleep briefly before rescanning.
                        await asyncio.sleep(1)
                        continue
                    await self._read_once()
                except Exception:
                    # Never let a single iteration take the worker down.
                    log.exception("OperationConsumer iteration failed")
                    await asyncio.sleep(1)
        finally:
            log.info("OperationConsumer stopped")

    # ------------------------------------------------------------ discovery

    async def _discover_streams_if_needed(self) -> None:
        now = asyncio.get_event_loop().time()
        if now - self._last_scan_at < DISCOVERY_INTERVAL_SECONDS and self._known_streams:
            return
        self._last_scan_at = now

        new_streams: set[str] = set()
        async for raw_key in self.redis.scan_iter(match=STREAM_SCAN_PATTERN, count=100):
            key = raw_key.decode() if isinstance(raw_key, bytes) else raw_key
            new_streams.add(key)

        for key in new_streams - self._known_streams:
            # Create the consumer group lazily on first sight. MKSTREAM lets
            # us create the group even if the stream doesn't yet exist.
            try:
                await self.redis.xgroup_create(
                    key, STREAM_CONSUMER_GROUP, id="0", mkstream=True
                )
                log.info("Created consumer group on %s", key)
            except aioredis.ResponseError as e:
                if "BUSYGROUP" not in str(e):
                    raise
        self._known_streams = new_streams

    # --------------------------------------------------------------- reading

    async def _read_once(self) -> None:
        streams = {key: ">" for key in self._known_streams}
        if not streams:
            return
        try:
            batches = await self.redis.xreadgroup(
                groupname=STREAM_CONSUMER_GROUP,
                consumername=self.consumer_name,
                streams=streams,
                count=XREAD_COUNT,
                block=XREAD_BLOCK_MS,
            )
        except aioredis.ResponseError as e:
            # A stream might have been deleted between SCAN and XREADGROUP.
            # Forget it and move on.
            log.warning("XREADGROUP error, re-discovering streams: %s", e)
            self._known_streams.clear()
            return

        if not batches:
            return

        for raw_key, entries in batches:
            stream_key = raw_key.decode() if isinstance(raw_key, bytes) else raw_key
            doc_id = self._doc_id_from_key(stream_key)
            for entry_id_raw, fields_raw in entries:
                entry_id = (
                    entry_id_raw.decode() if isinstance(entry_id_raw, bytes) else entry_id_raw
                )
                fields = self._decode_fields(fields_raw)
                try:
                    await self._handle_entry(doc_id, stream_key, entry_id, fields)
                except Exception:
                    log.exception(
                        "Failed to handle entry %s on %s — leaving unacked",
                        entry_id,
                        stream_key,
                    )
                    continue
                await self.redis.xack(stream_key, STREAM_CONSUMER_GROUP, entry_id)

    # --------------------------------------------------------------- helpers

    @staticmethod
    def _doc_id_from_key(key: str) -> int:
        # doc:{id}:stream
        parts = key.split(":")
        try:
            return int(parts[1])
        except (IndexError, ValueError):
            raise ValueError(f"unexpected stream key: {key!r}")

    @staticmethod
    def _decode_fields(fields: Any) -> dict[str, Any]:
        """Redis returns `{b'k': b'v'}` with bytes; normalise to `str` keys.

        Values are left as bytes when they look binary (delta), decoded to
        str otherwise. The only binary field we expect is `delta`.
        """
        out: dict[str, Any] = {}
        for k, v in fields.items():
            key = k.decode() if isinstance(k, bytes) else k
            if key == "delta":
                out[key] = v if isinstance(v, (bytes, bytearray)) else v.encode()
            else:
                out[key] = v.decode() if isinstance(v, bytes) else v
        return out

    # --------------------------------------------------------- entry handling

    async def _handle_entry(
        self, doc_id: int, stream_key: str, entry_id: str, fields: dict[str, Any]
    ) -> None:
        kind = fields.get("kind")
        if kind == "ops":
            # Already persisted by the REST route. Nothing to do.
            return
        if kind != "crdt":
            log.warning("Unknown kind %r on %s, skipping", kind, stream_key)
            return

        block_id = fields.get("blockId")
        delta = fields.get("delta")
        if not block_id or not delta:
            log.warning("Malformed crdt entry %s on %s", entry_id, stream_key)
            return

        await self._apply_crdt_delta(doc_id, block_id, delta, entry_id)

    async def _apply_crdt_delta(
        self, doc_id: int, block_id: str, delta: bytes, entry_id: str
    ) -> None:
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    SELECT yjs_state, last_applied_stream_id
                      FROM doc_blocks
                     WHERE doc_id = $1 AND block_id = $2
                     FOR UPDATE
                    """,
                    doc_id,
                    block_id,
                )
                if row is None:
                    # Block doesn't exist yet. This is a race: the crdt delta
                    # arrived before the insert_block op was applied. We
                    # leave the entry unacked by raising — the next consume
                    # cycle will retry. In practice the WS server enforces
                    # "insert before delta" client-side, so this should be
                    # rare.
                    raise RuntimeError(
                        f"crdt delta for missing block {block_id} on doc {doc_id}"
                    )

                last_applied: str | None = row["last_applied_stream_id"]
                if last_applied is not None and _stream_id_le(entry_id, last_applied):
                    # Already applied (idempotency).
                    return

                state: bytes | None = (
                    bytes(row["yjs_state"]) if row["yjs_state"] is not None else None
                )
                doc, text = make_doc(state)
                apply_delta(doc, delta)
                new_state = encode_state(doc)
                new_content = extract_content(text)

                await conn.execute(
                    """
                    UPDATE doc_blocks
                       SET yjs_state              = $3,
                           content                = $4::jsonb,
                           last_applied_stream_id = $5,
                           updated_at             = now()
                     WHERE doc_id = $1 AND block_id = $2
                    """,
                    doc_id,
                    block_id,
                    new_state,
                    json.dumps(new_content),
                    entry_id,
                )


def _stream_id_le(a: str, b: str) -> bool:
    """`a <= b` treating Redis stream ids (`ms-seq`) as a pair of ints.

    Redis guarantees strictly increasing ids per stream, so comparing the
    two integer halves is the correct ordering. Lexicographic comparison
    works too (because Redis pads / monotonically increases) but we spell
    the intent out to avoid surprises on edge cases.
    """

    def split(s: str) -> tuple[int, int]:
        if "-" not in s:
            return int(s), 0
        ms, seq = s.split("-", 1)
        return int(ms), int(seq)

    return split(a) <= split(b)
