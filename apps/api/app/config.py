"""Application configuration.

Reads env vars with sensible dev defaults. Kept tiny on purpose — this is a
demo, not a full 12-factor service.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _asyncpg_dsn(url: str) -> str:
    """Normalise DATABASE_URL to the form asyncpg expects.

    docker-compose sets `postgresql+asyncpg://...` (SQLAlchemy-style). asyncpg
    itself only understands `postgresql://`. Strip the `+asyncpg` suffix if
    present.
    """
    if url.startswith("postgresql+asyncpg://"):
        return "postgresql://" + url[len("postgresql+asyncpg://") :]
    return url


@dataclass(frozen=True)
class Settings:
    database_url: str
    redis_url: str
    image_dir: str
    cors_origins: tuple[str, ...]
    api_base_url: str
    log_level: str


def load_settings() -> Settings:
    return Settings(
        database_url=_asyncpg_dsn(
            os.environ.get(
                "DATABASE_URL",
                "postgresql://blockdocs:blockdocs@localhost:5432/blockdocs",
            )
        ),
        redis_url=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
        image_dir=os.environ.get("IMAGE_DIR", "/data/images"),
        # Demo uses two web instances on 3001 and 3002.
        cors_origins=tuple(
            os.environ.get(
                "CORS_ORIGINS",
                "http://localhost:3001,http://localhost:3002",
            ).split(",")
        ),
        api_base_url=os.environ.get("API_BASE_URL", "http://localhost:8000"),
        log_level=os.environ.get("LOG_LEVEL", "INFO"),
    )


settings = load_settings()
