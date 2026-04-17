"""Integration test for the OperationConsumer delta application path.

Instead of running the full Stream consumer loop, we directly call the
internal `_apply_crdt_delta` to isolate the DB interaction. The end-to-end
XREADGROUP path is exercised via the full docker-compose E2E suite.
"""

from __future__ import annotations

import uuid

import pytest

pytest.importorskip("asyncpg")
pytest.importorskip("redis")

from app.consumer.crdt import make_doc, encode_state  # noqa: E402
from app.consumer.worker import OperationConsumer  # noqa: E402


DOC_ID = 1


async def _insert_blank_block(conn, block_id: uuid.UUID) -> None:
    await conn.execute(
        """
        INSERT INTO doc_blocks
            (block_id, doc_id, parent_id, position, depth, type, content,
             yjs_state, version)
        VALUES ($1, $2, NULL, 'm', 0, 'paragraph', '{}'::jsonb, NULL, 1)
        """,
        block_id,
        DOC_ID,
    )


async def test_consumer_applies_delta_and_updates_content(pg_pool):
    """A delta produced in pycrdt should land in content + yjs_state."""
    # Generate a delta by building a Doc client-side.
    doc, text = make_doc(None)
    text.insert(0, "Hello ")
    text.insert(6, "world")
    delta = encode_state(doc)

    block_id = uuid.uuid4()
    async with pg_pool.acquire() as conn:
        async with conn.transaction():
            await _insert_blank_block(conn, block_id)

    consumer = OperationConsumer(pg_pool, redis=None)  # redis unused in this path
    await consumer._apply_crdt_delta(
        DOC_ID, str(block_id), delta, entry_id="1-0"
    )

    async with pg_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT content, yjs_state, last_applied_stream_id FROM doc_blocks "
            "WHERE block_id = $1",
            block_id,
        )

    assert row is not None
    assert row["last_applied_stream_id"] == "1-0"
    assert row["yjs_state"] is not None and len(row["yjs_state"]) > 0
    children = row["content"]["children"]
    joined = "".join(c["text"] for c in children if c["type"] == "text")
    assert joined == "Hello world"


async def test_consumer_skips_already_applied_stream_id(pg_pool):
    """Re-delivering the same stream id must not double-apply."""
    doc, text = make_doc(None)
    text.insert(0, "ABC")
    delta = encode_state(doc)

    block_id = uuid.uuid4()
    async with pg_pool.acquire() as conn:
        async with conn.transaction():
            await _insert_blank_block(conn, block_id)

    consumer = OperationConsumer(pg_pool, redis=None)
    await consumer._apply_crdt_delta(DOC_ID, str(block_id), delta, entry_id="2-5")

    async with pg_pool.acquire() as conn:
        first_state = await conn.fetchval(
            "SELECT yjs_state FROM doc_blocks WHERE block_id = $1", block_id
        )
        first_updated = await conn.fetchval(
            "SELECT updated_at FROM doc_blocks WHERE block_id = $1", block_id
        )

    # Redeliver: same id, same delta. Should short-circuit on idempotency.
    await consumer._apply_crdt_delta(DOC_ID, str(block_id), delta, entry_id="2-5")

    async with pg_pool.acquire() as conn:
        second_updated = await conn.fetchval(
            "SELECT updated_at FROM doc_blocks WHERE block_id = $1", block_id
        )
        second_state = await conn.fetchval(
            "SELECT yjs_state FROM doc_blocks WHERE block_id = $1", block_id
        )

    assert bytes(first_state) == bytes(second_state)
    # updated_at should not have moved — we returned before the UPDATE.
    assert first_updated == second_updated
