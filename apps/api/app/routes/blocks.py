"""Block snapshot + operations routes."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from app.models import (
    Block,
    BlocksResponse,
    OperationsRequest,
    OperationsResponse,
    OpResult,
)
from app.ops.apply import AppliedOp, apply_op, record_operation
from app.redis_bus import stream_last_id, xadd_ops, publish_bus
from app.routes.users import resolve_uid

log = logging.getLogger(__name__)


router = APIRouter()


INSTANCE_ID = os.environ.get("INSTANCE_ID", f"api-{os.getpid()}")


@router.get("/api/v1/docs/{doc_id}/blocks", response_model=BlocksResponse)
async def get_blocks(doc_id: int, request: Request) -> BlocksResponse:
    """Return the full block tree + the current Stream cursor.

    Blocks are returned flat but sorted so a naive tree build (group-by
    parent) produces stable results. The client is expected to do the
    tree-ification; keeping server-side logic simple makes debugging easier.
    """
    pool = request.app.state.pg
    redis = request.app.state.redis

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT block_id, parent_id, position, depth, type, content, version
              FROM doc_blocks
             WHERE doc_id = $1
             ORDER BY depth ASC, parent_id NULLS FIRST, position ASC
            """,
            doc_id,
        )

    blocks = [
        Block(
            block_id=str(r["block_id"]),
            parent_id=str(r["parent_id"]) if r["parent_id"] is not None else None,
            position=r["position"],
            depth=r["depth"],
            type=r["type"],
            content=r["content"] if isinstance(r["content"], dict) else json.loads(r["content"]),
            version=int(r["version"]),
        )
        for r in rows
    ]

    last_id = await stream_last_id(redis, doc_id)

    return BlocksResponse(doc_id=doc_id, blocks=blocks, last_stream_id=last_id)


@router.post(
    "/api/v1/docs/{doc_id}/operations", response_model=OperationsResponse
)
async def post_operations(
    doc_id: int, body: OperationsRequest, request: Request
) -> OperationsResponse:
    """Apply block ops server-authoritatively.

    Strategy:
      1) Run all ops in a single DB transaction. Each op returns either
         AppliedOp (success) or OpConflict (stale version / bad input).
         Conflicts are kept in the results but do NOT propagate to Redis —
         only applied ops go to the Stream / bus.
      2) If any op applied, XADD a single `kind=ops` entry and PUBLISH
         a `remote_ops` frame to the bus.
      3) Record applied ops into `doc_operations` with the returned stream_id.

    We commit the DB transaction *before* publishing. A crash between commit
    and publish would leave the DB ahead of the Stream; peers would pick up
    the change on their next GET /blocks. This trade-off is documented in
    docs/block-based-document.md §4.7 "ACID 경계".
    """
    uid = resolve_uid(request)
    pool = request.app.state.pg
    redis = request.app.state.redis

    outcomes: list[tuple[dict, Any]] = []  # (raw_op, outcome)
    applied: list[AppliedOp] = []

    async with pool.acquire() as conn:
        async with conn.transaction():
            for op in body.ops:
                raw = op.model_dump(by_alias=True)
                outcome = await apply_op(conn, doc_id, uid, raw)
                outcomes.append((raw, outcome))
                if isinstance(outcome, AppliedOp):
                    applied.append(outcome)

    # Build wire-level results — blockId / newVersion / status / current
    from app.ops.apply import AppliedOp as _Applied, OpConflict as _Conflict

    results: list[OpResult] = []
    for raw, outcome in outcomes:
        if isinstance(outcome, _Applied):
            results.append(
                OpResult(
                    block_id=outcome.block_id,
                    new_version=outcome.new_version,
                    status="applied",
                )
            )
        elif isinstance(outcome, _Conflict):
            current_block = None
            if outcome.current_block is not None:
                current_block = Block(**outcome.current_block)
            results.append(
                OpResult(
                    block_id=outcome.block_id,
                    new_version=0,
                    status="conflict",
                    current=current_block,
                )
            )

    stream_id: str | None = None
    if applied:
        # Serialise applied ops for the Stream / bus. We include the server's
        # computed position / depth so clients can reconcile without another
        # round-trip.
        wire_ops = []
        for a in applied:
            wire_ops.append(
                {
                    "op": a.op_type,
                    "blockId": a.block_id,
                    "payload": a.payload,
                    "version": a.new_version,
                    "block": a.block,  # full server view, convenience for peers
                }
            )

        ops_json = json.dumps(wire_ops)
        try:
            stream_id = await xadd_ops(redis, doc_id, ops_json, uid)
        except Exception:  # pragma: no cover - defensive
            log.exception("Failed XADD for doc %s", doc_id)
            stream_id = None

        # Persist applied ops into the append-only log with the Stream id.
        if stream_id is not None:
            async with pool.acquire() as conn:
                async with conn.transaction():
                    for a in applied:
                        await record_operation(
                            conn, doc_id, uid, body.client_seq, stream_id, a
                        )

        # Fan out via Pub/Sub so both ws instances see it. The ws layer
        # filters on `originInstance` to avoid echoing back to the sender.
        frame = {
            "ch": "remote_ops",
            "ops": wire_ops,
            "userId": uid,
            "streamId": stream_id,
        }
        try:
            await publish_bus(redis, doc_id, INSTANCE_ID, frame)
        except Exception:  # pragma: no cover
            log.exception("Failed PUBLISH for doc %s", doc_id)

    return OperationsResponse(results=results, stream_id=stream_id)
