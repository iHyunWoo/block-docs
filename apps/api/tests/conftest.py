"""Test fixtures.

Unit tests (lexorank, crdt helpers) are hermetic and don't need anything
configured. Integration tests (ops, consumer, routes) require a real
Postgres + Redis; we only attempt to connect when TEST_DATABASE_URL is
set, otherwise we mark the test as skipped.

This keeps `pytest` runnable locally without docker for quick feedback
while still supporting the full suite in CI.
"""

from __future__ import annotations

import asyncio
import os
from typing import AsyncIterator

import pytest
import pytest_asyncio


# Configure pytest-asyncio to use function-scoped event loops by default.
def pytest_collection_modifyitems(config, items):  # pragma: no cover
    for item in items:
        # Mark every `async def` test to use asyncio so we don't have to
        # sprinkle @pytest.mark.asyncio everywhere.
        if asyncio.iscoroutinefunction(getattr(item, "function", None)):
            item.add_marker(pytest.mark.asyncio)


def _test_db_url() -> str | None:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        return None
    # Mirror app/config.py normalisation.
    if url.startswith("postgresql+asyncpg://"):
        return "postgresql://" + url[len("postgresql+asyncpg://") :]
    return url


def _test_redis_url() -> str | None:
    return os.environ.get("TEST_REDIS_URL") or os.environ.get("REDIS_URL")


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture
async def pg_pool():
    dsn = _test_db_url()
    if dsn is None:
        pytest.skip("TEST_DATABASE_URL not set")
    import asyncpg

    from app.db import create_pool

    pool = await create_pool(dsn)
    # Clean state before each test.
    async with pool.acquire() as conn:
        await conn.execute("TRUNCATE doc_operations, doc_blocks RESTART IDENTITY CASCADE")
        # documents / users survive; they're tiny and preserving them keeps
        # FK relationships valid.
    try:
        yield pool
    finally:
        await pool.close()


@pytest_asyncio.fixture
async def redis_client() -> AsyncIterator:
    url = _test_redis_url()
    if url is None:
        pytest.skip("TEST_REDIS_URL / REDIS_URL not set")
    import redis.asyncio as aioredis

    client = aioredis.from_url(url, decode_responses=False)
    # Wipe any doc:* stream/bus left from previous runs.
    async for key in client.scan_iter(match="doc:*:stream"):
        await client.delete(key)
    try:
        yield client
    finally:
        await client.aclose()
