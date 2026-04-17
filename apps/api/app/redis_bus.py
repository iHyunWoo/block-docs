"""Redis helpers — Stream + Pub/Sub wire-level utilities.

Keeps all the string literals for keys / field names in one place so the
consumer and the API route stay in lock-step with docs/protocol.md.
"""

from __future__ import annotations

import json
from typing import Any

import redis.asyncio as aioredis


STREAM_KEY_PATTERN = "doc:{doc_id}:stream"
BUS_KEY_PATTERN = "doc:{doc_id}:bus"
STREAM_CONSUMER_GROUP = "block-ops"
STREAM_SCAN_PATTERN = "doc:*:stream"
STREAM_MAXLEN_APPROX = 100_000


def stream_key(doc_id: int) -> str:
    return STREAM_KEY_PATTERN.format(doc_id=doc_id)


def bus_key(doc_id: int) -> str:
    return BUS_KEY_PATTERN.format(doc_id=doc_id)


async def xadd_ops(
    redis: aioredis.Redis, doc_id: int, ops_json: str, user_id: int
) -> str:
    """Append an `ops` entry to the doc stream. Returns the new stream id."""
    return await redis.xadd(
        stream_key(doc_id),
        {"kind": "ops", "ops": ops_json, "userId": str(user_id)},
        maxlen=STREAM_MAXLEN_APPROX,
        approximate=True,
    )


async def xadd_crdt(
    redis: aioredis.Redis, doc_id: int, block_id: str, delta: bytes, user_id: int
) -> str:
    """Append a `crdt` entry — used by WS, not by API, but kept here for symmetry."""
    return await redis.xadd(
        stream_key(doc_id),
        {
            "kind": "crdt",
            "blockId": block_id,
            "delta": delta,
            "userId": str(user_id),
        },
        maxlen=STREAM_MAXLEN_APPROX,
        approximate=True,
    )


async def publish_bus(
    redis: aioredis.Redis,
    doc_id: int,
    origin_instance: str,
    frame: dict[str, Any],
) -> None:
    """Publish a server-to-client frame to the fan-out bus.

    The payload matches the WS-layer contract: `{ originInstance, frame }`.
    """
    payload = json.dumps({"originInstance": origin_instance, "frame": frame})
    await redis.publish(bus_key(doc_id), payload)


async def stream_last_id(redis: aioredis.Redis, doc_id: int) -> str:
    """Return the last entry id in the doc stream, or "0-0" if empty.

    Used to seed the client's `lastStreamId` at initial load so the
    subsequent WebSocket connection can request a replay from this point
    forward.
    """
    try:
        info = await redis.xinfo_stream(stream_key(doc_id))
    except aioredis.ResponseError:
        # Stream doesn't exist yet
        return "0-0"
    # redis-py returns either a list of key/value pairs or a dict depending on
    # RESP version — normalise.
    if isinstance(info, dict):
        last = info.get("last-generated-id") or info.get(b"last-generated-id") or "0-0"
    else:
        last = "0-0"
        it = iter(info)
        for k, v in zip(it, it, strict=False):
            if k in (b"last-generated-id", "last-generated-id"):
                last = v
                break
    if isinstance(last, bytes):
        last = last.decode()
    return last or "0-0"
