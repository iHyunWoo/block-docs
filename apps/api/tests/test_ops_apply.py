"""Integration tests for app.ops.apply.

Requires TEST_DATABASE_URL pointing at a Postgres that has run
`infra/postgres/init.sql`. The conftest fixture truncates doc_blocks /
doc_operations before every test.
"""

from __future__ import annotations

import uuid
from uuid import UUID

import pytest

asyncpg = pytest.importorskip("asyncpg")

from app.ops.apply import (  # noqa: E402 — imported after importorskip guard
    AppliedOp,
    OpConflict,
    apply_op,
)


DOC_ID = 1


async def _insert_root(conn, user_id: int, block_id: UUID | None = None):
    block_id = block_id or uuid.uuid4()
    outcome = await apply_op(
        conn,
        DOC_ID,
        user_id,
        {
            "op": "insert_block",
            "blockId": str(block_id),
            "payload": {"type": "paragraph", "content": {"children": []}},
        },
    )
    return block_id, outcome


async def test_insert_then_update_attrs_bumps_version(pg_pool):
    async with pg_pool.acquire() as conn:
        async with conn.transaction():
            block_id, insert = await _insert_root(conn, user_id=1)
            assert isinstance(insert, AppliedOp)
            assert insert.new_version == 1

        async with conn.transaction():
            out = await apply_op(
                conn,
                DOC_ID,
                1,
                {
                    "op": "update_attrs",
                    "blockId": str(block_id),
                    "version": 1,
                    "payload": {"attrs": {"level": 2}},
                },
            )
    assert isinstance(out, AppliedOp), f"expected AppliedOp, got {out!r}"
    assert out.new_version == 2
    assert out.block["content"]["attrs"] == {"level": 2}


async def test_update_attrs_with_stale_version_conflicts(pg_pool):
    async with pg_pool.acquire() as conn:
        async with conn.transaction():
            block_id, _ = await _insert_root(conn, user_id=1)

        async with conn.transaction():
            # First update succeeds.
            out = await apply_op(
                conn,
                DOC_ID,
                1,
                {
                    "op": "update_attrs",
                    "blockId": str(block_id),
                    "version": 1,
                    "payload": {"attrs": {"checked": True}},
                },
            )
            assert isinstance(out, AppliedOp)

        async with conn.transaction():
            # Second update with the original (now stale) version.
            stale = await apply_op(
                conn,
                DOC_ID,
                1,
                {
                    "op": "update_attrs",
                    "blockId": str(block_id),
                    "version": 1,  # stale
                    "payload": {"attrs": {"checked": False}},
                },
            )
    assert isinstance(stale, OpConflict)
    assert stale.current_block is not None
    assert stale.current_block["version"] == 2


async def test_delete_block_is_idempotent(pg_pool):
    async with pg_pool.acquire() as conn:
        async with conn.transaction():
            block_id, _ = await _insert_root(conn, user_id=1)

        async with conn.transaction():
            out1 = await apply_op(
                conn,
                DOC_ID,
                1,
                {
                    "op": "delete_block",
                    "blockId": str(block_id),
                    "version": 1,
                },
            )
        async with conn.transaction():
            out2 = await apply_op(
                conn,
                DOC_ID,
                1,
                {
                    "op": "delete_block",
                    "blockId": str(block_id),
                    "version": 1,
                },
            )
    assert isinstance(out1, AppliedOp)
    # Second delete: row already gone. Treated as idempotent success.
    assert isinstance(out2, AppliedOp)


async def test_insert_with_after_id_picks_midpoint(pg_pool):
    async with pg_pool.acquire() as conn:
        async with conn.transaction():
            a_id, a_out = await _insert_root(conn, user_id=1)
            b_id, b_out = await _insert_root(conn, user_id=1)  # appended after a

        assert isinstance(a_out, AppliedOp) and isinstance(b_out, AppliedOp)
        a_pos = a_out.block["position"]
        b_pos = b_out.block["position"]
        assert a_pos < b_pos

        async with conn.transaction():
            c_id = uuid.uuid4()
            c_out = await apply_op(
                conn,
                DOC_ID,
                1,
                {
                    "op": "insert_block",
                    "blockId": str(c_id),
                    "payload": {
                        "type": "paragraph",
                        "afterId": str(a_id),
                        "content": {"children": []},
                    },
                },
            )
    assert isinstance(c_out, AppliedOp)
    assert a_pos < c_out.block["position"] < b_pos


async def test_insert_with_duplicate_block_id_conflicts(pg_pool):
    async with pg_pool.acquire() as conn:
        async with conn.transaction():
            block_id, first = await _insert_root(conn, user_id=1)
            assert isinstance(first, AppliedOp)

        async with conn.transaction():
            dup = await apply_op(
                conn,
                DOC_ID,
                1,
                {
                    "op": "insert_block",
                    "blockId": str(block_id),
                    "payload": {"type": "paragraph", "content": {}},
                },
            )
    assert isinstance(dup, OpConflict)


async def test_move_block_between_parents(pg_pool):
    async with pg_pool.acquire() as conn:
        async with conn.transaction():
            parent_a_id, _ = await _insert_root(conn, user_id=1)
            parent_b_id, _ = await _insert_root(conn, user_id=1)
            # Insert child under parent_a.
            child_id = uuid.uuid4()
            child_out = await apply_op(
                conn,
                DOC_ID,
                1,
                {
                    "op": "insert_block",
                    "blockId": str(child_id),
                    "payload": {
                        "type": "paragraph",
                        "parentId": str(parent_a_id),
                        "content": {},
                    },
                },
            )
            assert isinstance(child_out, AppliedOp)
            assert child_out.block["parentId"] == str(parent_a_id)

        async with conn.transaction():
            moved = await apply_op(
                conn,
                DOC_ID,
                1,
                {
                    "op": "move_block",
                    "blockId": str(child_id),
                    "version": 1,
                    "payload": {
                        "parentId": str(parent_b_id),
                    },
                },
            )
    assert isinstance(moved, AppliedOp)
    assert moved.block["parentId"] == str(parent_b_id)
    assert moved.new_version == 2
