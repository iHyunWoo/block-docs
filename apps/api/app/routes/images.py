"""Image presign / upload / serve routes — demo-mode S3 replacement.

Real deployment would swap this for an S3 presigned URL. For the self-
contained demo we sign a URL on this same API; the handler writes the raw
bytes to a mounted volume and serves them back on GET.

The presigned id embeds the uploader's userId so the protocol requirement
"different users produce distinct URLs" is trivially satisfied (and it
helps the E2E test verify per-user isolation).
"""

from __future__ import annotations

import mimetypes
import os
import re
import secrets
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response

from app.config import settings
from app.models import PresignRequest, PresignResponse
from app.routes.users import resolve_uid


router = APIRouter()


MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MiB — generous for demo
ALLOWED_CONTENT_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/avif",
    "image/svg+xml",
}

# Accepts either "abc.png" or "uid-1-abc.png" — basically our own format,
# rejects anything with path traversal or invalid chars.
_IMAGE_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")


def _image_path(image_id: str) -> Path:
    if not _IMAGE_ID_RE.match(image_id):
        raise HTTPException(status_code=400, detail="invalid image id")
    base = Path(settings.image_dir)
    base.mkdir(parents=True, exist_ok=True)
    return base / image_id


def _ext_for(content_type: str) -> str:
    # Prefer a deterministic mapping over mimetypes.guess_extension, which
    # returns `.jpe` for image/jpeg on some systems.
    mapping = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/avif": ".avif",
        "image/svg+xml": ".svg",
    }
    return mapping.get(content_type) or (mimetypes.guess_extension(content_type) or ".bin")


@router.post("/api/v1/images/presign", response_model=PresignResponse)
async def presign(body: PresignRequest, request: Request) -> PresignResponse:
    if body.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail="unsupported content type")
    if body.size <= 0 or body.size > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="invalid size")

    uid = resolve_uid(request)
    token = secrets.token_urlsafe(12)
    ext = _ext_for(body.content_type)
    # uid-<n>-<token><ext> — the "uid-<n>-" prefix is the per-user tag the
    # protocol asks for.
    image_id = f"uid-{uid}-{token}{ext}"

    base = settings.api_base_url.rstrip("/")
    return PresignResponse(
        upload_url=f"{base}/api/v1/images/upload/{image_id}",
        public_url=f"{base}/api/v1/images/{image_id}",
        image_id=image_id,
    )


@router.put("/api/v1/images/upload/{image_id}")
async def upload(image_id: str, request: Request) -> dict[str, str]:
    """Accept the raw body and write it to disk.

    We only trust size; content-type validation happened at presign time.
    Refuse to overwrite an existing file so a cancelled upload can't stomp
    on someone else's image.
    """
    path = _image_path(image_id)
    if path.exists():
        raise HTTPException(status_code=409, detail="image already uploaded")

    body = await request.body()
    if len(body) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="image too large")

    # Write atomically: temp file + rename, so half-written uploads don't
    # serve partial content.
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(body)
    os.replace(tmp, path)

    return {"imageId": image_id, "size": str(len(body))}


@router.get("/api/v1/images/{image_id}")
async def serve(image_id: str) -> Response:
    path = _image_path(image_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="not found")
    # Let FileResponse pick content-type from filename extension.
    return FileResponse(path)
