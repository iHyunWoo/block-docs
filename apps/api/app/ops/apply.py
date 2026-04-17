"""Server-authoritative block operation applier.

Each public function accepts an open asyncpg transaction and a parsed op
payload and returns an `AppliedOp` on success or an `OpConflict` describing
the stale state on failure. The caller (the /operations route) decides how
to surface the result on the wire and whether to XADD to the Stream.

Key invariants (docs §4.7):

- insert_block: blockId is client-generated (UUIDv7). Conflict if a row with
  that id already exists for a different doc, or if the parent doesn't
  belong to the target document.
- delete_block: version check. Stale version -> conflict. CASCADE children
  via FK.
- move_block: version check + advisory lock on the new parent (so LexoRank
  position generation doesn't race).
- update_attrs: version check, JSON merge into content.attrs. Version bumps.
- update_content: LWW (no version check). In practice the CRDT consumer
  writes this, not the REST endpoint — included here for completeness.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import asyncpg

from app import lexorank


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AppliedOp:
    block_id: str
    new_version: int
    # The server's view of the block *after* applying the op. Streamed to
    # peers so they don't have to re-fetch.
    block: dict[str, Any]
    # The original op, normalised. We'll write this into doc_operations and
    # include it in the Redis Stream payload.
    op_type: str
    payload: dict[str, Any]


@dataclass(frozen=True)
class OpConflict:
    block_id: str
    current_block: dict[str, Any] | None
    reason: str


OpOutcome = AppliedOp | OpConflict


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _row_to_block(row: dict[str, Any] | asyncpg.Record | None) -> dict[str, Any] | None:
    """Normalise a DB row into the wire Block shape (camelCase)."""
    if row is None:
        return None
    return {
        "blockId": str(row["block_id"]),
        "parentId": str(row["parent_id"]) if row["parent_id"] is not None else None,
        "position": row["position"],
        "depth": row["depth"],
        "type": row["type"],
        "content": row["content"] if isinstance(row["content"], dict) else json.loads(row["content"]),
        "version": int(row["version"]),
    }


async def _fetch_block(
    conn: asyncpg.Connection, doc_id: int, block_id: UUID
) -> dict[str, Any] | None:
    row = await conn.fetchrow(
        """
        SELECT block_id, parent_id, position, depth, type, content, version
          FROM doc_blocks
         WHERE doc_id = $1 AND block_id = $2
        """,
        doc_id,
        block_id,
    )
    return _row_to_block(dict(row)) if row is not None else None


async def _parent_depth(
    conn: asyncpg.Connection, doc_id: int, parent_id: UUID | None
) -> int:
    if parent_id is None:
        return 0
    row = await conn.fetchrow(
        "SELECT depth FROM doc_blocks WHERE doc_id = $1 AND block_id = $2",
        doc_id,
        parent_id,
    )
    if row is None:
        raise ValueError(f"parent {parent_id} not found")
    return int(row["depth"]) + 1


async def _compute_position(
    conn: asyncpg.Connection,
    doc_id: int,
    parent_id: UUID | None,
    after_id: UUID | None,
) -> str:
    """Pick a LexoRank between `after_id` and the next sibling.

    `after_id == None` means "insert at the start of the parent's child list".
    If after_id is the last child (or there are none), append at the end.
    """
    # Left bound — the `position` of after_id, or None for head insert.
    left: str | None = None
    if after_id is not None:
        row = await conn.fetchrow(
            """
            SELECT position FROM doc_blocks
             WHERE doc_id = $1 AND block_id = $2
            """,
            doc_id,
            after_id,
        )
        if row is None:
            raise ValueError(f"afterId {after_id} not found")
        left = row["position"]

    # Right bound — the next sibling's position. NULL parent_id needs IS NULL.
    if left is None:
        # Head of the list — smallest existing position, or None if empty.
        if parent_id is None:
            right_row = await conn.fetchrow(
                """
                SELECT position FROM doc_blocks
                 WHERE doc_id = $1 AND parent_id IS NULL
                 ORDER BY position ASC
                 LIMIT 1
                """,
                doc_id,
            )
        else:
            right_row = await conn.fetchrow(
                """
                SELECT position FROM doc_blocks
                 WHERE doc_id = $1 AND parent_id = $2
                 ORDER BY position ASC
                 LIMIT 1
                """,
                doc_id,
                parent_id,
            )
    else:
        if parent_id is None:
            right_row = await conn.fetchrow(
                """
                SELECT position FROM doc_blocks
                 WHERE doc_id = $1 AND parent_id IS NULL AND position > $2
                 ORDER BY position ASC
                 LIMIT 1
                """,
                doc_id,
                left,
            )
        else:
            right_row = await conn.fetchrow(
                """
                SELECT position FROM doc_blocks
                 WHERE doc_id = $1 AND parent_id = $2 AND position > $3
                 ORDER BY position ASC
                 LIMIT 1
                """,
                doc_id,
                parent_id,
                left,
            )

    right = right_row["position"] if right_row else None
    return lexorank.midpoint(left, right)


def _merge_attrs(
    existing: dict[str, Any], patch: dict[str, Any]
) -> dict[str, Any]:
    """Shallow-merge `patch` into `existing["attrs"]`.

    `None` values in `patch` delete the corresponding key. Returns a new
    content dict — caller is responsible for re-serialising / writing.
    """
    out = dict(existing) if existing else {}
    attrs = dict(out.get("attrs") or {})
    for k, v in patch.items():
        if v is None:
            attrs.pop(k, None)
        else:
            attrs[k] = v
    out["attrs"] = attrs
    return out


def _advisory_lock_key(doc_id: int, parent_id: UUID | None) -> int:
    """Stable 64-bit int key for pg_advisory_xact_lock(bigint).

    We only need determinism within a doc, so hash `(doc_id, parent_id)`.
    parent_id=None is "root" and needs a distinct key from any real UUID.
    """
    import zlib

    raw = f"{doc_id}|{parent_id or 'root'}".encode()
    # crc32 is 32 bits; shift up so we always occupy the upper half — keeps
    # the lower bits free for future sub-tenant partitioning if needed.
    return (zlib.crc32(raw) & 0xFFFFFFFF) << 1  # always even, positive


# ---------------------------------------------------------------------------
# Operation handlers
# ---------------------------------------------------------------------------


async def insert_block(
    conn: asyncpg.Connection,
    doc_id: int,
    user_id: int,
    op_block_id: str,
    payload: dict[str, Any],
) -> OpOutcome:
    block_id = UUID(op_block_id)
    block_type = payload.get("type", "paragraph")
    parent_raw = payload.get("parentId")
    parent_id: UUID | None = UUID(parent_raw) if parent_raw else None
    after_raw = payload.get("afterId")
    after_id: UUID | None = UUID(after_raw) if after_raw else None
    content = payload.get("content") or {}

    # Reject duplicate block ids inside the doc. The PK already prevents
    # cross-doc collisions but we surface it as a conflict rather than a 500.
    existing = await conn.fetchrow(
        "SELECT doc_id FROM doc_blocks WHERE block_id = $1", block_id
    )
    if existing is not None:
        return OpConflict(op_block_id, None, "block_id already exists")

    try:
        depth = await _parent_depth(conn, doc_id, parent_id)
    except ValueError as e:
        return OpConflict(op_block_id, None, str(e))

    # Serialise concurrent inserts/moves under the same parent so LexoRank
    # midpoint computation sees a consistent sibling set.
    await conn.execute(
        "SELECT pg_advisory_xact_lock($1)",
        _advisory_lock_key(doc_id, parent_id),
    )

    try:
        position = await _compute_position(conn, doc_id, parent_id, after_id)
    except ValueError as e:
        return OpConflict(op_block_id, None, str(e))

    # Insert. Any UNIQUE violation (doc_id, parent_id, position) -> conflict.
    try:
        row = await conn.fetchrow(
            """
            INSERT INTO doc_blocks
                (block_id, doc_id, parent_id, position, depth, type, content,
                 version, created_by, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, $8, $8)
            RETURNING block_id, parent_id, position, depth, type, content, version
            """,
            block_id,
            doc_id,
            parent_id,
            position,
            depth,
            block_type,
            json.dumps(content),
            user_id,
        )
    except asyncpg.UniqueViolationError:
        return OpConflict(op_block_id, None, "position collision")

    block = _row_to_block(dict(row))
    assert block is not None
    return AppliedOp(
        block_id=op_block_id,
        new_version=1,
        block=block,
        op_type="insert_block",
        # Echo the normalised payload so peers see the position/depth the
        # server picked.
        payload={
            "type": block_type,
            "parentId": str(parent_id) if parent_id else None,
            "position": position,
            "depth": depth,
            "content": content,
        },
    )


async def delete_block(
    conn: asyncpg.Connection,
    doc_id: int,
    user_id: int,
    op_block_id: str,
    payload: dict[str, Any],
    expected_version: int | None,
) -> OpOutcome:
    block_id = UUID(op_block_id)
    row = await conn.fetchrow(
        """
        SELECT block_id, parent_id, position, depth, type, content, version
          FROM doc_blocks
         WHERE doc_id = $1 AND block_id = $2
         FOR UPDATE
        """,
        doc_id,
        block_id,
    )
    if row is None:
        # Already gone — treat as idempotent success with version 0.
        return AppliedOp(
            block_id=op_block_id,
            new_version=0,
            block={"blockId": op_block_id, "deleted": True},
            op_type="delete_block",
            payload={},
        )
    if expected_version is not None and int(row["version"]) != expected_version:
        return OpConflict(op_block_id, _row_to_block(dict(row)), "stale version")

    await conn.execute(
        "DELETE FROM doc_blocks WHERE doc_id = $1 AND block_id = $2",
        doc_id,
        block_id,
    )
    return AppliedOp(
        block_id=op_block_id,
        new_version=int(row["version"]) + 1,  # symbolic; row is gone
        block={"blockId": op_block_id, "deleted": True},
        op_type="delete_block",
        payload={},
    )


async def move_block(
    conn: asyncpg.Connection,
    doc_id: int,
    user_id: int,
    op_block_id: str,
    payload: dict[str, Any],
    expected_version: int | None,
) -> OpOutcome:
    block_id = UUID(op_block_id)
    new_parent_raw = payload.get("parentId")
    new_parent_id: UUID | None = UUID(new_parent_raw) if new_parent_raw else None
    after_raw = payload.get("afterId")
    after_id: UUID | None = UUID(after_raw) if after_raw else None

    row = await conn.fetchrow(
        """
        SELECT block_id, parent_id, position, depth, type, content, version
          FROM doc_blocks
         WHERE doc_id = $1 AND block_id = $2
         FOR UPDATE
        """,
        doc_id,
        block_id,
    )
    if row is None:
        return OpConflict(op_block_id, None, "block not found")
    if expected_version is not None and int(row["version"]) != expected_version:
        return OpConflict(op_block_id, _row_to_block(dict(row)), "stale version")

    # Advisory lock on the destination parent so concurrent inserts/moves
    # into the same parent serialise through us.
    await conn.execute(
        "SELECT pg_advisory_xact_lock($1)",
        _advisory_lock_key(doc_id, new_parent_id),
    )

    try:
        new_depth = await _parent_depth(conn, doc_id, new_parent_id)
        new_position = await _compute_position(conn, doc_id, new_parent_id, after_id)
    except ValueError as e:
        return OpConflict(op_block_id, _row_to_block(dict(row)), str(e))

    new_version = int(row["version"]) + 1
    try:
        updated = await conn.fetchrow(
            """
            UPDATE doc_blocks
               SET parent_id = $3,
                   position  = $4,
                   depth     = $5,
                   version   = $6,
                   updated_by = $7,
                   updated_at = now()
             WHERE doc_id = $1 AND block_id = $2
             RETURNING block_id, parent_id, position, depth, type, content, version
            """,
            doc_id,
            block_id,
            new_parent_id,
            new_position,
            new_depth,
            new_version,
            user_id,
        )
    except asyncpg.UniqueViolationError:
        return OpConflict(op_block_id, _row_to_block(dict(row)), "position collision")

    block = _row_to_block(dict(updated))
    assert block is not None
    return AppliedOp(
        block_id=op_block_id,
        new_version=new_version,
        block=block,
        op_type="move_block",
        payload={
            "parentId": str(new_parent_id) if new_parent_id else None,
            "position": new_position,
            "depth": new_depth,
        },
    )


async def update_attrs(
    conn: asyncpg.Connection,
    doc_id: int,
    user_id: int,
    op_block_id: str,
    payload: dict[str, Any],
    expected_version: int | None,
) -> OpOutcome:
    block_id = UUID(op_block_id)
    patch = payload.get("attrs") or {}

    row = await conn.fetchrow(
        """
        SELECT block_id, parent_id, position, depth, type, content, version
          FROM doc_blocks
         WHERE doc_id = $1 AND block_id = $2
         FOR UPDATE
        """,
        doc_id,
        block_id,
    )
    if row is None:
        return OpConflict(op_block_id, None, "block not found")
    if expected_version is not None and int(row["version"]) != expected_version:
        return OpConflict(op_block_id, _row_to_block(dict(row)), "stale version")

    existing_content = row["content"] if isinstance(row["content"], dict) else json.loads(row["content"])
    new_content = _merge_attrs(existing_content, patch)
    new_version = int(row["version"]) + 1

    updated = await conn.fetchrow(
        """
        UPDATE doc_blocks
           SET content = $3::jsonb,
               version = $4,
               updated_by = $5,
               updated_at = now()
         WHERE doc_id = $1 AND block_id = $2
         RETURNING block_id, parent_id, position, depth, type, content, version
        """,
        doc_id,
        block_id,
        json.dumps(new_content),
        new_version,
        user_id,
    )
    block = _row_to_block(dict(updated))
    assert block is not None
    return AppliedOp(
        block_id=op_block_id,
        new_version=new_version,
        block=block,
        op_type="update_attrs",
        payload={"attrs": patch},
    )


async def update_content(
    conn: asyncpg.Connection,
    doc_id: int,
    user_id: int,
    op_block_id: str,
    payload: dict[str, Any],
) -> OpOutcome:
    """LWW content overwrite. Used for non-CRDT blocks (divider, image).

    Text blocks should prefer the `crdt` channel so CRDT convergence handles
    merges; sending update_content for a text block wipes any concurrent
    edit, so call it sparingly.
    """
    block_id = UUID(op_block_id)
    content = payload.get("content") or {}

    row = await conn.fetchrow(
        """
        UPDATE doc_blocks
           SET content = $3::jsonb,
               version = version + 1,
               updated_by = $4,
               updated_at = now()
         WHERE doc_id = $1 AND block_id = $2
         RETURNING block_id, parent_id, position, depth, type, content, version
        """,
        doc_id,
        block_id,
        json.dumps(content),
        user_id,
    )
    if row is None:
        return OpConflict(op_block_id, None, "block not found")
    block = _row_to_block(dict(row))
    assert block is not None
    return AppliedOp(
        block_id=op_block_id,
        new_version=int(row["version"]),
        block=block,
        op_type="update_content",
        payload={"content": content},
    )


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


async def apply_op(
    conn: asyncpg.Connection,
    doc_id: int,
    user_id: int,
    op: dict[str, Any],
) -> OpOutcome:
    """Single-op dispatcher — picks the right handler based on `op.op`."""
    op_type = op["op"]
    block_id = op["blockId"]
    payload = op.get("payload", {}) or {}
    version = op.get("version")

    if op_type == "insert_block":
        return await insert_block(conn, doc_id, user_id, block_id, payload)
    if op_type == "delete_block":
        return await delete_block(conn, doc_id, user_id, block_id, payload, version)
    if op_type == "move_block":
        return await move_block(conn, doc_id, user_id, block_id, payload, version)
    if op_type == "update_attrs":
        return await update_attrs(conn, doc_id, user_id, block_id, payload, version)
    if op_type == "update_content":
        return await update_content(conn, doc_id, user_id, block_id, payload)
    return OpConflict(block_id, None, f"unknown op type: {op_type}")


async def record_operation(
    conn: asyncpg.Connection,
    doc_id: int,
    user_id: int,
    client_seq: int | None,
    stream_id: str,
    outcome: AppliedOp,
) -> None:
    """Persist a successful op to the append-only `doc_operations` log."""
    await conn.execute(
        """
        INSERT INTO doc_operations
            (doc_id, block_id, op_type, payload, user_id, client_seq, stream_id)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
        """,
        doc_id,
        UUID(outcome.block_id) if outcome.block_id else None,
        outcome.op_type,
        json.dumps(outcome.payload),
        user_id,
        client_seq,
        stream_id,
    )
