"""Demo user route.

Reads a `uid` cookie (default 1) to emulate an authenticated user. The
frontend sets the cookie from a dropdown so we can impersonate Alice/Bob/
Carol and verify multi-user behaviour without a real auth system.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.models import User


router = APIRouter()


def resolve_uid(request: Request) -> int:
    """Extract the uid cookie with a safe fallback.

    We intentionally fall back to 1 on any error — the demo is never secure
    on its own, and making the API unusable when the cookie is missing
    would just frustrate debugging.
    """
    raw = request.cookies.get("uid")
    if not raw:
        return 1
    try:
        n = int(raw)
        return n if n > 0 else 1
    except ValueError:
        return 1


@router.get("/api/v1/users/me", response_model=User)
async def get_me(request: Request) -> User:
    uid = resolve_uid(request)
    pool = request.app.state.pg
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, handle, name, color FROM users WHERE id = $1", uid
        )
    if row is None:
        raise HTTPException(status_code=404, detail=f"user {uid} not found")
    return User(
        id=row["id"], handle=row["handle"], name=row["name"], color=row["color"]
    )
