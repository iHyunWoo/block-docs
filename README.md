# Block-Based Document System — Demo

블록 기반 문서 시스템 데모. 설계: [`docs/block-based-document.md`](docs/block-based-document.md).

## Stack

| Layer | Tech | Port |
|---|---|---|
| Frontend | Next.js (App Router) + Yjs + zustand | 3001, 3002 |
| WebSocket | Node.js (ws + ioredis) | 4001, 4002 |
| API | FastAPI (asyncpg + pycrdt) | 8000 |
| DB | PostgreSQL 16 | 5432 |
| Bus | Redis 7 (Stream + Pub/Sub) | 6379 |

## Quick start

```bash
make up       # Start the full stack (hot reload enabled)
make seed     # Insert demo users + document
# Open:
#   http://localhost:3001  (user A — routed to ws-1)
#   http://localhost:3002  (user B — routed to ws-2)
make down     # Stop
make clean    # Stop + remove volumes
```

## Layout

```
apps/
  web/        Next.js frontend
  ws/         WebSocket relay server
  api/        FastAPI REST + OperationConsumer (pycrdt)
infra/
  docker-compose.yml        Base compose
  docker-compose.dev.yml    Hot reload overlay
  postgres/init.sql         DB schema
tests/
  e2e/        Playwright multi-instance tests
docs/         Design documents
```

## Architecture

See [`docs/block-based-document.md`](docs/block-based-document.md) §2.2.

- **Redis Stream** is the source of truth for CRDT deltas
- **WS servers are stateless** — relay + Stream XADD only
- **API Consumer (pycrdt)** is stateless — `load state → apply delta → save state` per message
- **DB** stores `content JSONB` (derived view) + `yjs_state BYTEA` (CRDT state)
- **Multi-instance ready**: two `ws` instances share state via Redis Pub/Sub + Stream

## Multi-instance sanity check

Two web containers (`web-1`, `web-2`) and two WS containers (`ws-1`, `ws-2`) run side by side.
`web-1` only talks to `ws-1`, `web-2` only to `ws-2`. Edits in one tab must propagate to the
other through `Redis Pub/Sub` — this is exactly what the E2E suite asserts.

```
make test-e2e
```

## Testing

```bash
make test         # pytest + vitest + playwright
make test-api     # pytest only
make test-ws      # vitest only
make test-e2e     # playwright only
```

## Current status & known gaps

The stack comes up cleanly with `make up`. All services are healthy and the
API, WS relay, and Next.js frontend talk to each other. Unit/integration
tests pass for every app (api pytest, ws vitest, web vitest).

E2E currently shows **5/10 Playwright specs green**. The gaps are all rooted
in two open items we ran out of time on:

1. **CRDT delta loss between `ws.send` and WS server receive.** Y.Doc update
   events fire, WsClient reports `open: true`, but the Redis Stream only ends
   up with `kind=ops` entries — `kind=crdt` entries aren't observed in the
   demo run. Connection logs show the socket closing (`code 1001`) ~1-2s
   after each page load, suggesting the react-root re-creates its `useWs`
   client more often than expected in Next dev mode. A `sendQueue` guards the
   pre-open window; it doesn't currently cover a close that happens between
   `send` and the server's incoming-message callback. **Fix direction**:
   move the ws client creation out of `useMemo` into a stable module-level
   registry keyed by docId + uid, or switch to a hand-rolled store so React
   remounts don't destroy the socket.
2. **`Y.Text ↔ DOM` reconciler is plain-text only.** `reconcileFromDom`
   (added as a fallback when `beforeinput` skips) doesn't preserve marks
   in the Y.Text model. Once the crdt channel is healthy, this also stops
   being relevant for remote peers (they'll see the Yjs deltas), but the
   local editor won't know about bold/italic until the observer pass rebuilds
   them from `Y.Text.toDelta()`. **Fix direction**: diff DOM against
   `Y.Text.toDelta()` rather than replacing the string wholesale.

Passing E2E specs today:
- basic editing: Enter splits blocks, slash menu inserts heading
- multi-instance: concurrent text edits converge (CRDT semantics)
- markdown paste: heading/list/code/blockquote expansion
- reconnect: reload path works when the Stream tail is empty

Failing specs need one or both of the two fixes above to land.

See `docs/block-based-document.md` for the intended architecture
(§4 explains the relay/Stream/Consumer split) and `docs/protocol.md`
for the wire contract both sides of the demo follow.
