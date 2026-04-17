"""Postgres connection pool, bootstrapped at FastAPI startup.

We use asyncpg directly (no SQLAlchemy) because the whole backend is <1k
LOC and the operations are all hand-written SQL anyway. Keeping the ORM
out also avoids overhead during the hot op-path.
"""

from __future__ import annotations

import json
from typing import Any

import asyncpg


async def create_pool(dsn: str) -> asyncpg.Pool:
    """Create an asyncpg pool with JSONB <-> dict translation wired in.

    Without the init function every JSONB round-trip would come back as a
    string and we'd have to json.loads everywhere.
    """

    async def _init(conn: asyncpg.Connection) -> None:
        await conn.set_type_codec(
            "jsonb",
            encoder=json.dumps,
            decoder=json.loads,
            schema="pg_catalog",
        )
        await conn.set_type_codec(
            "json",
            encoder=json.dumps,
            decoder=json.loads,
            schema="pg_catalog",
        )

    return await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=10, init=_init)


async def fetchrow_dict(conn: asyncpg.Connection, sql: str, *args: Any) -> dict[str, Any] | None:
    row = await conn.fetchrow(sql, *args)
    return dict(row) if row is not None else None


async def fetch_dicts(conn: asyncpg.Connection, sql: str, *args: Any) -> list[dict[str, Any]]:
    rows = await conn.fetch(sql, *args)
    return [dict(r) for r in rows]
