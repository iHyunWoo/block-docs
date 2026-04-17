# -----------------------------------------------------------------------------
# apps/api — FastAPI backend for block-docs
# -----------------------------------------------------------------------------
# Two-stage layout: `base` is used for production-style runs without reload.
# `dev` adds watchfiles and runs uvicorn with --reload.
# -----------------------------------------------------------------------------

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# System deps needed by asyncpg / pycrdt wheels. Most wheels are manylinux so
# we install a minimal set; keep the list small so image size stays down.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

# Image storage volume (demo uses local disk mount)
RUN mkdir -p /data/images

COPY app ./app
COPY tests ./tests

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]


# ----- dev stage ------------------------------------------------------------
FROM base AS dev

RUN pip install watchfiles

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
