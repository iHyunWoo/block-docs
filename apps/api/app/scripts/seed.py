"""Seed a minimal document so the demo page isn't empty.

Usage (from inside the api container, for example):
    python -m app.scripts.seed

Inserts a single root paragraph block into doc_id=1 if the doc has no
blocks yet. Safe to re-run — idempotent.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid

from app.config import settings
from app.db import create_pool
from app import lexorank


log = logging.getLogger(__name__)

SEED_DOC_ID = 1


async def main() -> None:
    pool = await create_pool(settings.database_url)
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                # Make sure the document row exists — init.sql seeds it but
                # a fresh developer DB may have been wiped.
                await conn.execute(
                    """
                    INSERT INTO documents (id, title, created_by)
                    VALUES ($1, 'Demo Document',
                            (SELECT id FROM users ORDER BY id LIMIT 1))
                    ON CONFLICT (id) DO NOTHING
                    """,
                    SEED_DOC_ID,
                )
                await conn.execute(
                    """
                    SELECT setval(pg_get_serial_sequence('documents', 'id'),
                                  GREATEST((SELECT COALESCE(MAX(id), 1)
                                             FROM documents), 1))
                    """
                )

                existing = await conn.fetchval(
                    "SELECT COUNT(*) FROM doc_blocks WHERE doc_id = $1",
                    SEED_DOC_ID,
                )
                if existing and int(existing) > 0:
                    print(f"doc {SEED_DOC_ID} already has {existing} blocks, skipping")
                    return

                first_user = await conn.fetchval(
                    "SELECT id FROM users ORDER BY id LIMIT 1"
                )
                block_id = uuid.uuid4()
                await conn.execute(
                    """
                    INSERT INTO doc_blocks
                        (block_id, doc_id, parent_id, position, depth, type,
                         content, version, created_by, updated_by)
                    VALUES ($1, $2, NULL, $3, 0, 'paragraph', $4::jsonb, 1,
                            $5, $5)
                    """,
                    block_id,
                    SEED_DOC_ID,
                    lexorank.DEFAULT_SEED,
                    json.dumps(
                        {
                            "children": [
                                {
                                    "type": "text",
                                    "text": "Welcome to block-docs. Start typing…",
                                }
                            ]
                        }
                    ),
                    first_user,
                )
                print(f"seeded paragraph {block_id} into doc {SEED_DOC_ID}")
    finally:
        await pool.close()


if __name__ == "__main__":  # pragma: no cover
    asyncio.run(main())
