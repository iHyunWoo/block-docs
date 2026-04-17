-- Block-Based Document System — Schema
-- Reflects docs/block-based-document.md §3

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --------------------------------------------------------------------
-- users (demo only — real system uses an auth provider)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id          SERIAL PRIMARY KEY,
    handle      VARCHAR(64) UNIQUE NOT NULL,
    name        VARCHAR(128) NOT NULL,
    color       VARCHAR(16) NOT NULL,          -- presence color
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------
-- documents
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
    id          SERIAL PRIMARY KEY,
    title       VARCHAR(256) NOT NULL DEFAULT 'Untitled',
    created_by  INT REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------
-- doc_blocks (§3.1)
--   content   JSONB     derived view (display + search)
--   yjs_state BYTEA     CRDT source of truth (per block)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doc_blocks (
    block_id                UUID PRIMARY KEY,
    doc_id                  INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

    parent_id               UUID REFERENCES doc_blocks(block_id) ON DELETE CASCADE,
    position                VARCHAR(64) NOT NULL,          -- LexoRank
    depth                   SMALLINT NOT NULL DEFAULT 0,

    type                    VARCHAR(50) NOT NULL,
    content                 JSONB NOT NULL DEFAULT '{}'::jsonb,
    yjs_state               BYTEA,

    last_applied_stream_id  VARCHAR(64),
    version                 BIGINT NOT NULL DEFAULT 1,

    created_by              INT REFERENCES users(id),
    updated_by              INT REFERENCES users(id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_block_position UNIQUE (doc_id, parent_id, position)
);

CREATE INDEX IF NOT EXISTS idx_blocks_doc_id        ON doc_blocks(doc_id);
CREATE INDEX IF NOT EXISTS idx_blocks_parent        ON doc_blocks(parent_id);
CREATE INDEX IF NOT EXISTS idx_blocks_doc_position  ON doc_blocks(doc_id, parent_id, position);

-- Full-text search on derived content
CREATE INDEX IF NOT EXISTS idx_blocks_content_gin
    ON doc_blocks USING GIN (content);

-- --------------------------------------------------------------------
-- doc_operations (§3.4) — append-only log, also Stream archive
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doc_operations (
    op_id       BIGSERIAL PRIMARY KEY,
    doc_id      INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    block_id    UUID,

    op_type     VARCHAR(20) NOT NULL,
    payload     JSONB NOT NULL,

    user_id     INT REFERENCES users(id),
    client_seq  BIGINT,
    stream_id   VARCHAR(64),                -- matches Redis Stream entry id
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_doc_stream ON doc_operations(doc_id, stream_id);
CREATE INDEX IF NOT EXISTS idx_ops_doc_block  ON doc_operations(doc_id, block_id);

-- --------------------------------------------------------------------
-- block_comments (§3.5)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS block_comments (
    comment_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id              INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    block_id            UUID NOT NULL REFERENCES doc_blocks(block_id) ON DELETE CASCADE,
    parent_comment_id   UUID REFERENCES block_comments(comment_id) ON DELETE CASCADE,

    anchor_type         VARCHAR(20) NOT NULL,       -- 'block' | 'range' | 'inline_mark'
    anchor_mark_id      UUID,

    body                JSONB NOT NULL,

    author_id           INT NOT NULL REFERENCES users(id),
    resolved_at         TIMESTAMPTZ,
    resolved_by         INT REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comments_doc    ON block_comments(doc_id, resolved_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_comments_block  ON block_comments(block_id);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON block_comments(parent_comment_id);

-- --------------------------------------------------------------------
-- Seed demo users + a document (only when table is empty)
-- --------------------------------------------------------------------
INSERT INTO users (handle, name, color)
SELECT * FROM (VALUES
    ('alice', 'Alice',  '#f97316'),
    ('bob',   'Bob',    '#3b82f6'),
    ('carol', 'Carol',  '#10b981')
) AS v(handle, name, color)
WHERE NOT EXISTS (SELECT 1 FROM users);

INSERT INTO documents (id, title, created_by)
SELECT 1, 'Demo Document', (SELECT id FROM users WHERE handle = 'alice')
WHERE NOT EXISTS (SELECT 1 FROM documents WHERE id = 1);

-- Keep sequence in sync if we explicitly inserted id=1
SELECT setval(pg_get_serial_sequence('documents', 'id'),
              GREATEST((SELECT COALESCE(MAX(id), 1) FROM documents), 1));
