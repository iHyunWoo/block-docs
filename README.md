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
