"""End-to-end tests for the REST routes.

Uses httpx.AsyncClient with an ASGI transport so we never bind a port.
Requires TEST_DATABASE_URL + a reachable Redis (both tests skip otherwise).
"""

from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio

pytest.importorskip("asyncpg")
pytest.importorskip("redis")
pytest.importorskip("fastapi")

pytestmark = pytest.mark.asyncio


def _env_ready() -> bool:
    return bool(os.environ.get("TEST_DATABASE_URL")) and bool(
        os.environ.get("TEST_REDIS_URL") or os.environ.get("REDIS_URL")
    )


@pytest_asyncio.fixture
async def client():
    if not _env_ready():
        pytest.skip("TEST_DATABASE_URL + REDIS_URL required for API tests")

    # Point app config at the test URLs.
    os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
    if "TEST_REDIS_URL" in os.environ:
        os.environ["REDIS_URL"] = os.environ["TEST_REDIS_URL"]
    os.environ["DISABLE_CONSUMER"] = "1"  # don't background-run the worker
    # Reload settings module because it caches at import time.
    import importlib

    import app.config as cfg
    importlib.reload(cfg)
    import app.main as main
    importlib.reload(main)

    # Wipe blocks table before the test.
    from app.db import create_pool

    pool = await create_pool(
        os.environ["TEST_DATABASE_URL"].replace(
            "postgresql+asyncpg://", "postgresql://"
        )
    )
    async with pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE doc_operations, doc_blocks RESTART IDENTITY CASCADE"
        )
    await pool.close()

    # Wipe redis streams.
    import redis.asyncio as aioredis

    r = aioredis.from_url(os.environ["REDIS_URL"], decode_responses=False)
    async for key in r.scan_iter(match="doc:*:stream"):
        await r.delete(key)
    await r.aclose()

    import httpx

    transport = httpx.ASGITransport(app=main.app)
    async with main.app.router.lifespan_context(main.app):
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


async def test_get_empty_doc_returns_no_blocks(client):
    r = await client.get("/api/v1/docs/1/blocks")
    assert r.status_code == 200
    body = r.json()
    assert body["docId"] == 1
    assert body["blocks"] == []
    assert "lastStreamId" in body


async def test_insert_block_then_get_returns_it(client):
    block_id = str(uuid.uuid4())
    payload = {
        "clientSeq": 1,
        "ops": [
            {
                "op": "insert_block",
                "blockId": block_id,
                "payload": {
                    "type": "paragraph",
                    "content": {"children": [{"type": "text", "text": "hi"}]},
                },
            }
        ],
    }
    r = await client.post("/api/v1/docs/1/operations", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["results"]) == 1
    assert body["results"][0]["status"] == "applied"
    assert body["results"][0]["blockId"] == block_id

    r = await client.get("/api/v1/docs/1/blocks")
    blocks = r.json()["blocks"]
    assert len(blocks) == 1
    assert blocks[0]["blockId"] == block_id
    assert blocks[0]["type"] == "paragraph"
    assert blocks[0]["version"] == 1
