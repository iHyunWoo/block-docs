"""FastAPI application wiring.

Responsibilities:
  * Create the Postgres pool and Redis client at startup, tear them down
    cleanly at shutdown.
  * Start the OperationConsumer as a background task bound to the app's
    lifespan.
  * Mount the REST routers and configure CORS for the two demo frontends
    (localhost:3001 and 3002).

Keeping this module tiny makes it easy to spin up alternative entry points
for tests (see tests/conftest.py, which imports `create_app`).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import redis.asyncio as aioredis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.consumer.worker import OperationConsumer
from app.db import create_pool
from app.routes import blocks as blocks_routes
from app.routes import images as images_routes
from app.routes import test_helpers as test_helpers_routes
from app.routes import users as users_routes


def configure_logging() -> None:
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    log = logging.getLogger(__name__)

    log.info("Starting API. db=%s redis=%s", settings.database_url, settings.redis_url)
    app.state.pg = await create_pool(settings.database_url)
    app.state.redis = aioredis.from_url(settings.redis_url, decode_responses=False)

    # OperationConsumer is optional in tests — flip via env var.
    app.state.consumer = None
    if _consumer_enabled():
        consumer = OperationConsumer(app.state.pg, app.state.redis)
        consumer.start()
        app.state.consumer = consumer

    try:
        yield
    finally:
        log.info("Shutting down API")
        if app.state.consumer is not None:
            try:
                await app.state.consumer.stop()
            except Exception:
                log.exception("Consumer shutdown failed")
        await app.state.redis.aclose()
        await app.state.pg.close()


def _consumer_enabled() -> bool:
    import os

    return os.environ.get("DISABLE_CONSUMER", "").lower() not in ("1", "true", "yes")


def create_app() -> FastAPI:
    app = FastAPI(
        title="block-docs API",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(users_routes.router)
    app.include_router(blocks_routes.router)
    app.include_router(images_routes.router)
    app.include_router(test_helpers_routes.router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
