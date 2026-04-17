"""Test-only helpers.

These endpoints are guarded by the `X-Test-Mode: 1` header. They let the
Playwright suite reset a demo document to a known empty state between tests.

In a real deployment you'd either delete this file or put it behind a network
allowlist — it's intentionally dangerous (TRUNCATE + Stream DEL) so we require
the explicit header.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Header, HTTPException, Request

log = logging.getLogger(__name__)

router = APIRouter()


@router.post("/api/v1/docs/{doc_id}/_reset")
async def reset_doc(
    doc_id: int,
    request: Request,
    x_test_mode: str | None = Header(default=None, alias="X-Test-Mode"),
) -> dict[str, str]:
    """Wipe the document's blocks, ops log, comments, and Redis stream.

    The `documents` row itself is left intact so the demo always has doc_id=1.
    The seed paragraph from `app.scripts.seed` is re-inserted so the editor
    has a starting block to focus on.
    """
    if x_test_mode != "1":
        raise HTTPException(status_code=403, detail="Test mode header required")

    pool = request.app.state.pg
    redis = request.app.state.redis

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Cascades clean doc_blocks, doc_operations, block_comments.
            await conn.execute(
                "DELETE FROM doc_blocks WHERE doc_id = $1", doc_id
            )
            await conn.execute(
                "DELETE FROM doc_operations WHERE doc_id = $1", doc_id
            )
            await conn.execute(
                "DELETE FROM block_comments WHERE doc_id = $1", doc_id
            )

    # Drop the Stream entirely so lastStreamId starts fresh.
    try:
        await redis.delete(f"doc:{doc_id}:stream")
    except Exception:  # pragma: no cover - best effort
        log.exception("Failed to delete stream for doc %s", doc_id)

    # Seed one empty paragraph so the editor has a starting block.
    from uuid import uuid4

    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO doc_blocks
                (block_id, doc_id, parent_id, position, depth, type, content, version,
                 created_by, updated_by)
            VALUES
                ($1, $2, NULL, 'm', 0, 'paragraph',
                 $3::jsonb, 1,
                 (SELECT id FROM users WHERE handle='alice'),
                 (SELECT id FROM users WHERE handle='alice'))
            """,
            uuid4(),
            doc_id,
            '{"children": [{"type": "text", "text": ""}]}',
        )

    return {"status": "reset", "doc_id": str(doc_id)}
