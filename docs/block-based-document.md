# Block-Based Document System 설계

---

## 1. 현재 아키텍처 분석 및 문제점

### 1.1 현재 구조 (Yjs + Tiptap + Snapshot)

```
[Client A] ──WebSocket──┐
                         ├── Relay Server (stateless) ── Redis Pub/Sub
[Client B] ──WebSocket──┘         │
                                  ▼
                          Redis Stream (deltas)
                                  │
                          SnapshotWorker (30초 주기)
                                  │
                                  ▼
                          PostgreSQL (doc_snapshots)
                          ┌──────────────────────┐
                          │ yjs_state_bytes BYTEA │  ← 문서 전체 바이너리
                          │ snapshot_seq   BIGINT │
                          └──────────────────────┘
```

### 1.2 핵심 문제점

| 문제 | 설명 |
|------|------|
| **DB 부하** | 30초마다 문서 전체 Yjs 바이너리(수십KB~수MB)를 통째로 UPSERT. 동시 편집 문서가 늘어나면 write 폭증 |
| **확장성 한계** | 문서 크기가 커질수록 스냅샷 크기가 선형 증가. 100명이 편집해도 1명이 편집해도 같은 크기 |
| **기능 확장 어려움** | Yjs CRDT 위에 커스텀 블록 타입 추가 시 Yjs 스키마와 Tiptap 스키마를 동시에 맞춰야 함 |
| **검색 불가** | 바이너리 스냅샷이라 DB 레벨 full-text search 불가. 별도 파싱 필요 |
| **블록 단위 권한/잠금 불가** | 문서 전체가 하나의 CRDT 상태이므로 블록 단위 lock, 권한, 히스토리 불가 |
| **서버 사이드 렌더링 어려움** | SSR/OG 미리보기 등에서 Yjs 바이너리를 파싱해야 함 |

---

## 2. 목표 아키텍처: Block-Based Document System

### 2.1 핵심 원칙

1. **Block이 1급 시민**: 모든 콘텐츠는 독립적인 Block 단위로 저장/전송/동기화
2. **Operation 기반 동기화**: 전체 상태 스냅샷이 아닌, 블록 단위 Operation(생성/수정/삭제/이동)을 전파
3. **서버 권위(Server-Authoritative)**: 서버가 최종 상태의 권위자. 클라이언트는 낙관적 업데이트 후 서버 확인
4. **점진적 저장**: 변경된 블록만 DB에 쓴다. 문서 전체를 덮어쓰지 않는다

### 2.2 전체 아키텍처

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Frontend (Next.js)                            │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ BlockEditor                                                    │  │
│  │  ├─ BlockStore (zustand): 블록 트리 상태 관리                   │  │
│  │  ├─ ContentEditableBlock: 자체 에디터 (Tiptap 없음)             │  │
│  │  ├─ Y.Text (블록당 1개): 텍스트 동시 편집 CRDT                  │  │
│  │  ├─ OperationQueue: 블록 구조 변경 optimistic update            │  │
│  │  └─ lastStreamId: DB lag 보정용 Stream 커서                     │  │
│  └──────────────────────────────────┬─────────────────────────────┘  │
│                                     │ 1개 WebSocket (문서당)          │
└─────────────────────────────────────┼────────────────────────────────┘
                                      │
┌─────────────────────────────────────┼────────────────────────────────┐
│          WebSocket Server (Node.js, stateless)                        │
│                                     ▼                                │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Room: doc-{docId}                                              │  │
│  │  ├─ crdt delta (blockId별) → Room relay (해석 안 함)            │  │
│  │  │                         → Redis Stream 적재 (event log)      │  │
│  │  ├─ block ops (구조 변경) → 서버 검증 → broadcast + Stream       │  │
│  │  └─ awareness (커서/프레즌스) → relay                           │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                          │                                           │
│                    Redis Pub/Sub (room broadcast)                     │
│                    Redis Stream  (delta event log, source of truth)   │
└──────────────────────────┼───────────────────────────────────────────┘
                           │
┌──────────────────────────┼───────────────────────────────────────────┐
│              API Server (FastAPI, stateless)                          │
│                          ▼                                            │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ OperationConsumer (stateless worker, pycrdt)                   │  │
│  │  ├─ Stream 소비: {blockId, delta, streamId}                     │  │
│  │  ├─ SELECT yjs_state FROM doc_blocks WHERE block_id            │  │
│  │  ├─ 임시 Y.Doc 생성 → state bytes 로드 → delta apply            │  │
│  │  ├─ 새 state bytes + content JSON 추출                          │  │
│  │  ├─ UPDATE doc_blocks SET yjs_state, content, last_stream_id  │  │
│  │  └─ Y.Doc 파괴 (인메모리 유지 없음)                             │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────┐  ┌─────────────────────────────────┐  │
│  │ PostgreSQL                 │  │ REST API                        │  │
│  │  ├─ documents              │  │  ├─ GET  /docs/{id}/blocks     │  │
│  │  ├─ doc_blocks             │  │  │   → { blocks, lastStreamId } │  │
│  │  │   (content JSONB        │  │  ├─ POST /docs/{id}/operations │  │
│  │  │    + yjs_state BYTEA)   │  │  ├─ GET  /docs/{id}/history    │  │
│  │  ├─ doc_operations         │  │  └─ GET  /docs/{id}/comments   │  │
│  │  └─ block_comments         │  │                                 │  │
│  └───────────────────────────┘  └─────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘

진실의 원천:
  - 블록 구조 ops  → 서버 검증 후 Stream (서버 권위)
  - 블록 텍스트     → Redis Stream의 delta sequence (CRDT 수렴)
  - DB             → lag 허용 snapshot (state bytes + JSON)
  - 클라이언트 로드 → DB snapshot + WS로 받는 Stream tail delta
```

---

## 3. 데이터 모델

### 3.1 Block 스키마

```sql
CREATE TABLE doc_blocks (
    block_id       UUID PRIMARY KEY,   -- 클라이언트가 생성 (UUIDv7 권장)
    doc_id         INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    
    -- 트리 구조
    parent_id      UUID REFERENCES doc_blocks(block_id) ON DELETE CASCADE,
    position       VARCHAR(64) NOT NULL,  -- LexoRank (정렬용 문자열)
    depth          SMALLINT NOT NULL DEFAULT 0,  -- 캐시용 (parent 탐색 최적화)
    
    -- 콘텐츠 (두 가지 형태를 함께 보관)
    type           VARCHAR(50) NOT NULL,  -- 'paragraph' | 'heading' | ... 
    content        JSONB NOT NULL DEFAULT '{}',    -- 표시/검색용 derived view
    yjs_state      BYTEA,                          -- CRDT 진실. Y.Text.encodeStateAsUpdate() 결과
    
    -- Stream 동기화 커서
    last_applied_stream_id  VARCHAR(64),  -- 이 블록에 반영한 마지막 Stream ID
    
    -- 메타
    version        BIGINT NOT NULL DEFAULT 1,  -- Optimistic Lock (구조 op용: insert/delete/move/attrs)
    created_by     INT,
    updated_by     INT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- 인덱스
    CONSTRAINT uq_block_position UNIQUE (doc_id, parent_id, position)
);

CREATE INDEX idx_blocks_doc_id ON doc_blocks(doc_id);
CREATE INDEX idx_blocks_parent ON doc_blocks(parent_id);
CREATE INDEX idx_blocks_doc_position ON doc_blocks(doc_id, parent_id, position);

-- Full-text search (블록 내용 검색)
CREATE INDEX idx_blocks_content_search ON doc_blocks 
    USING GIN (to_tsvector('simple', content->>'text'));
```

**컬럼 설계 의도**

- `content` (JSONB): DB 레벨 쿼리/검색/표시용 **derived view**. 읽기 경로 (`GET /blocks`, full-text search, mention 스캔)는 모두 이걸 본다.
- `yjs_state` (BYTEA): Y.Text의 `encodeStateAsUpdate()` 바이너리. **CRDT 진실**. Consumer가 delta를 apply할 때 로드-수정-저장한다. 블록당 수백B~2KB.
- `last_applied_stream_id`: Consumer가 마지막으로 반영한 Redis Stream ID. 클라이언트 lag 보정과 idempotent 적용을 위한 커서.
- `version`: **구조 operation 전용** Optimistic Lock. `insert_block`, `delete_block`, `move_block`, `update_attrs`에서 버전 비교. 텍스트 content 변경(`update_content`)은 CRDT가 수렴을 보장하므로 version 검사 없이 LWW (§4.7 참조).

**왜 JSONB를 별도로 두는가 — `yjs_state`만 있으면 안 되나?**

1. **검색**: 바이너리 state에는 GIN 인덱스가 못 붙음. 한국어 like 검색, mention 스캔, 속성 필터가 JSON 없이는 불가능.
2. **읽기 성능**: 블록을 표시만 할 때 Y.Doc을 열 필요 없음. JSON을 그대로 응답.
3. **SSR/외부 시스템**: API 클라이언트(봇, 이메일 알림, OG 렌더)가 바이너리를 다루지 않아도 됨.

두 형태는 Consumer가 항상 **같은 트랜잭션에서 함께 갱신**하므로 불일치하지 않는다.

### 3.2 Block Types

```typescript
// 기본 블록
type BlockType =
  | 'paragraph'       // 일반 텍스트
  | 'heading'         // h1 ~ h3
  | 'code'            // 코드 블록
  | 'blockquote'      // 인용
  | 'divider'         // 구분선
  | 'image'           // 이미지
  | 'callout'         // 강조 박스
  | 'toggle'          // 토글 (접기/펼치기)
  // 리스트 계열
  | 'bulleted_list'   // 불릿 리스트 아이템
  | 'numbered_list'   // 번호 리스트 아이템
  | 'todo'            // 체크박스 아이템
  // 임베드 계열
  | 'table'           // 테이블 컨테이너
  | 'table_row'       // 테이블 행
  | 'embed'           // 외부 콘텐츠 임베드
  // CollabOps 전용
  | 'issue_mention'   // 이슈 참조 블록
  | 'database_view'   // 데이터베이스 뷰 (향후)
```

### 3.3 Block Content 구조 (JSONB)

```typescript
// 공통 구조: 인라인 노드 배열
interface BlockContent {
  // 텍스트 계열 블록
  children?: InlineNode[]
  
  // 블록별 속성
  attrs?: Record<string, unknown>
}

// 예시 - paragraph
{
  "children": [
    { "type": "text", "text": "Hello ", "marks": [] },
    { "type": "text", "text": "world", "marks": [{ "type": "bold" }] },
    { "type": "mention", "attrs": { "userId": 42, "label": "@김철수" } }
  ]
}

// 예시 - heading
{
  "attrs": { "level": 2 },
  "children": [
    { "type": "text", "text": "섹션 제목" }
  ]
}

// 예시 - code
{
  "attrs": { "language": "python" },
  "children": [
    { "type": "text", "text": "print('hello')" }
  ]
}

// 예시 - image
{
  "attrs": {
    "src": "https://cdn.collabops.ai/images/abc123.png",
    "alt": "설명",
    "width": 800,
    "height": 600,
    "caption": "그림 1"
  }
}

// 예시 - todo
{
  "attrs": { "checked": false },
  "children": [
    { "type": "text", "text": "할 일 항목" }
  ]
}

// 예시 - callout
{
  "attrs": { "icon": "💡", "color": "blue" },
  "children": [
    { "type": "text", "text": "참고 사항입니다" }
  ]
}

// 예시 - table
{
  "attrs": { "columns": 3 }
  // children은 table_row 블록들 (parent_id로 연결)
}
```

### 3.4 Operation Log (히스토리 + 실시간 동기화 근거)

```sql
CREATE TABLE doc_operations (
    op_id          BIGSERIAL PRIMARY KEY,
    doc_id         INT NOT NULL REFERENCES documents(id),
    block_id       UUID,  -- NULL이면 문서 레벨 operation
    
    op_type        VARCHAR(20) NOT NULL,
    -- 'insert_block' | 'update_block' | 'delete_block' | 'move_block'
    -- 'update_title' | 'set_metadata'
    
    payload        JSONB NOT NULL,
    -- insert: { block_id, type, content, parent_id, position, after_id }
    -- update: { block_id, content, version }  (delta만)
    -- delete: { block_id }
    -- move:   { block_id, new_parent_id, new_position }
    
    user_id        INT NOT NULL,
    client_seq     BIGINT,       -- 클라이언트 발행 시퀀스 (ack용)
    server_seq     BIGINT,       -- 서버 부여 글로벌 시퀀스
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- 파티셔닝/정리용 (오래된 op는 아카이빙)
    CONSTRAINT pk_op PRIMARY KEY (op_id)
);

CREATE INDEX idx_ops_doc_seq ON doc_operations(doc_id, server_seq);
CREATE INDEX idx_ops_doc_block ON doc_operations(doc_id, block_id);
```

### 3.5 Block Comments

블록이 1급 시민이라 `block_id`를 안정적인 외부 앵커로 쓸 수 있다. 댓글, 멘션, 알림, 공유 링크 모두 동일한 매커니즘으로 해결된다.

```sql
CREATE TABLE block_comments (
    comment_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id              INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    block_id            UUID NOT NULL REFERENCES doc_blocks(block_id) ON DELETE CASCADE,
    parent_comment_id   UUID REFERENCES block_comments(comment_id) ON DELETE CASCADE,  -- 스레드
    
    -- 앵커 방식 (세 종류 중 하나)
    anchor_type         VARCHAR(20) NOT NULL,   -- 'block' | 'range' | 'inline_mark'
    anchor_mark_id      UUID,                   -- inline_mark일 때: content.children의 mark attrs.commentId와 매칭
    
    -- 본문
    body                JSONB NOT NULL,         -- InlineNode[] (댓글 본문도 리치 텍스트)
    
    -- 상태
    author_id           INT NOT NULL,
    resolved_at         TIMESTAMPTZ,
    resolved_by         INT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_comments_doc ON block_comments(doc_id, resolved_at NULLS FIRST);
CREATE INDEX idx_comments_block ON block_comments(block_id);
CREATE INDEX idx_comments_thread ON block_comments(parent_comment_id);
CREATE INDEX idx_comments_mark ON block_comments(anchor_mark_id) WHERE anchor_mark_id IS NOT NULL;
```

**앵커 방식 세 가지**

| anchor_type | 용도 | 앵커 대상 |
|---|---|---|
| `block` | 블록 전체에 댓글 | `block_id`만 |
| `range` | 블록 내 특정 텍스트 범위 (naive offset) | `block_id` + `body.anchor_range` |
| `inline_mark` | **권장**. 텍스트와 함께 이동하는 인라인 comment mark | `block_id` + `anchor_mark_id` |

**`inline_mark` 방식이 핵심** — 텍스트 편집 시 앵커가 자동으로 따라감:

```json
// doc_blocks.content
{
  "children": [
    { "type": "text", "text": "이 부분이 ", "marks": [] },
    { "type": "text", "text": "문제입니다",
      "marks": [{ "type": "comment", "attrs": { "commentId": "c-123" } }] }
  ]
}
```

- Yjs의 `Y.Text.format(index, length, { comment: 'c-123' })` 로 부착.
- 앞에 글자 삽입되거나 중간에 편집이 일어나도 comment mark가 **대상 텍스트를 따라 이동**.
- 댓글 해제는 mark 제거로 처리.
- Notion, Google Docs가 이 방식.

**Range anchor (offset 기반)**의 문제점 — 편집 시 offset이 어긋남. 간단한 읽기 전용 문서가 아니면 `inline_mark`를 기본으로 쓴다.

**블록 삭제 시 정책** — 기본은 CASCADE. 민감한 제품(법무/감사)은 `ON DELETE SET NULL` + soft delete flag로 전환.

---

## 4. 실시간 동기화 프로토콜

### 4.1 기존 vs 신규 비교

| 항목 | 기존 (문서 전체 Yjs + Tiptap) | 신규 (Block 구조 서버 권위 + 블록별 Y.Text) |
|------|-------------------------------|------------------------------------------|
| 블록 구조 동기화 | Yjs CRDT (문서 전체) | 서버 권위 + Optimistic Lock |
| 블록 텍스트 동기화 | Yjs CRDT (문서 전체에 포함) | 블록별 독립 Y.Text. WS는 relay, 워커는 state bytes 관리 |
| Yjs 범위 | 문서 전체 (구조 + 텍스트) | 블록 내부 텍스트만 |
| 서버 역할 (WS) | Stateless relay | Stateless relay + Stream 적재 (delta 해석 안 함) |
| 서버 역할 (워커) | SnapshotWorker: 30초마다 전체 BYTEA UPSERT | OperationConsumer: stateless, 블록별 state bytes load-apply-save |
| 진실의 원천 | DB 스냅샷 (지연된 바이너리) | Redis Stream (delta event log). DB는 lag 허용 snapshot |
| DB 저장 형식 | 문서 전체 Yjs 바이너리 (BYTEA) | 블록별 JSONB(content) + BYTEA(yjs_state) |
| DB 쓰기 | 30초마다 문서 전체 스냅샷 | 변경된 블록만 debounced 저장 (per-block ~0.5KB JSON + ~1KB state) |
| 검색 | 불가 (바이너리) | Full-text search (GIN index on content JSONB) |
| 에디터 | Tiptap (ProseMirror) | Custom contentEditable |
| 백엔드 Yjs 의존 | pycrdt 필요 (SnapshotWorker) | pycrdt 필요 (OperationConsumer 전용). WS/API/프론트 무관 |

### 4.2 두 레이어의 Operation 흐름

블록 구조 변경과 블록 텍스트 편집은 완전히 다른 경로를 탄다.

#### blockId 생성 규약

- **클라이언트가 UUID를 생성**한다 (UUIDv7 권장: 시간 순서 내포).
- 서버는 blockId를 재부여하지 않는다. 임시 ID → 확정 ID 매핑이 없으므로 race 원천 차단.
- 서버는 검증만 수행: `doc_id` 내 중복 여부, `parent_id` 존재, 권한.
- `uuid` 값이 동일 `doc_id` 내에서 중복되면 conflict로 nack (악의적/중복 재전송 방어).

#### Y.Text 생성 순서 규칙 (race 방지)

**원격 `insert_block`을 수신했을 때 반드시 먼저 Y.Text 인스턴스를 생성**한 뒤 같은 blockId에 대한 `crdt` 채널 delta를 처리한다.

```
수신 순서가 crdt 먼저인 경우:
  crdt delta의 blockId에 대응하는 Y.Text가 없음
  → 짧은 버퍼에 delta 보관 (블록당 최대 N개, TTL 1초)
  → insert_block 수신 → Y.Text 생성 → 버퍼된 delta 일괄 apply
  → TTL 경과 시 버퍼 폐기 (해당 블록이 결국 생성되지 않으면 delta도 버림)
```

발신 측 규약: 클라이언트는 **insert_block을 먼저 전송하고, 그 이후에만** 해당 블록에 대한 crdt delta를 전송한다. 동일 WebSocket 연결의 순서 보장과 서버 relay 순서 보장이 결합되면 버퍼가 거의 트리거되지 않는다.

#### 블록 구조 변경 (생성/삭제/이동) — 서버 권위

```
1. Client A가 Enter 키 → 새 블록 생성 요청
   
2. 낙관적 업데이트
   Client A는 즉시 로컬 UI에 빈 블록 추가 (클라이언트 UUID 부여)
   + OperationQueue에 추가
   
3. Operation 전송
   { ch:'ops', ops: [{ op:'insert_block',
                       blockId:'018f...(UUIDv7)',
                       payload: { type:'paragraph', afterId:'block-3' } }],
     clientSeq: 42 }

4. 서버 처리
   ├─ blockId 중복 검증, parent 존재 검증, position(LexoRank) 계산, version=1 부여
   ├─ Room 전체에 broadcast (수신자는 Y.Text 인스턴스 먼저 생성)
   └─ Redis Stream → OperationConsumer → DB INSERT

5. ACK → OperationQueue에서 제거
   NACK (conflict) → 롤백 (블록 제거) + 서버 상태로 재동기화
```

#### 블록 텍스트 편집 — CRDT (Option B)

```
1. Client A가 block-3에 타이핑 "Hello"
   → Y.Text.insert(0, 'Hello')
   → Yjs가 delta 자동 생성 (Uint8Array)

2. delta 전송
   { ch:'crdt', blockId:'block-3', delta: <Uint8Array> }

3. WebSocket 서버 (stateless)
   ├─ Room의 다른 클라이언트에게 그대로 relay (해석 안 함)
   └─ Redis Stream XADD: { blockId, delta, userId, ts } → streamId 반환
      (Stream이 delta event log이자 진실의 원천)

4. Client B 수신:
   → block-3의 Y.Text에 applyUpdate(delta)
   → Y.Text.observe() → DOM 업데이트
   → 편집 중이든 보기만 하든 동일 경로. race condition 없음.

5. DB 반영 (클라이언트 관여 없음, 서버 워커가 담당):
   → OperationConsumer (pycrdt, stateless) Stream XREADGROUP
   → DB SELECT yjs_state, last_applied_stream_id FROM doc_blocks
   → pycrdt 임시 Y.Doc 생성 → state bytes 로드 → delta apply
   → 새 state bytes + content JSON 추출
   → DB UPDATE (yjs_state, content, last_applied_stream_id=streamId)
   → Y.Doc 파괴 (인메모리 유지 없음)

6. DB lag 보정:
   → 클라이언트 접속 시 GET /blocks → { blocks, lastStreamId }
   → WS 연결 → Stream의 lastStreamId 이후 delta를 서버가 replay 전송
   → 클라이언트 Y.Text가 DB보다 앞서더라도 Stream이 정확한 tail 보장
```

### 4.3 블록 내부 텍스트 동시 편집 — 의사결정 필요

같은 블록을 두 명 이상이 동시에 편집하는 경우의 처리 전략.
블록 구조(생성/삭제/이동)는 서버 권위로 확정. 여기서 다루는 것은 **같은 텍스트 블록 내부**의 글자 단위 동시 편집.

#### 전제

- 같은 블록 동시 편집은 전체 편집의 ~1% 미만 (대부분 다른 블록을 편집)
- 하지만 발생했을 때의 UX가 전체 인상을 결정함
- 블록 잠금(Lock)은 UX 최악이므로 채택하지 않음

---

#### Option A: Last-Write-Wins (LWW)

```
Client A: block-3 content = "Hello X world"  ─┐
                                               ├─ version 충돌
Client B: block-3 content = "Hello Y world"  ─┘
  → 늦게 도착한 B가 이김, A의 "X"는 유실
```

| 항목 | 평가 |
|------|------|
| 구현 비용 | **최소**. version 비교 + 서버 상태 반환만 |
| 같은 블록 동시 편집 품질 | **나쁨**. 한쪽 편집 유실. 타이핑 중 글자가 사라지는 경험 |
| 다른 블록 동시 편집 | 영향 없음 (완벽) |
| 추가 의존성 | 없음 |
| Awareness로 완화 가능? | 부분적. "이 블록 편집 중" 표시로 자연 분산. 하지만 강제가 아님 |
| 적합한 경우 | MVP / 동시 편집 빈도가 극히 낮은 내부 도구 / 빠른 출시 우선 |

**장점**: 구현 비용 0에 가까움. 블록 구조 operation만 잘 짜면 됨.
**단점**: 사용자가 쓴 글자가 사라짐. "협업 도구"로서 치명적 결함.

---

#### Option B: 블록별 독립 Y.Text — 문서 로드 시 전체 생성 (권장)

문서를 열 때 **모든 텍스트 블록에 Y.Text 인스턴스를 생성**한다.
편집 여부와 관계없이 모든 클라이언트가 모든 블록의 CRDT delta를 수신·적용한다.

```
문서 로드:
  GET /docs/{id}/blocks → JSON 블록 배열 수신
  → 모든 텍스트 블록에 Y.Text 생성 (JSON → Y.Text 초기화)
  → WebSocket 연결 (문서 room)
  → 이후 모든 원격 변경은 CRDT delta로 수신·자동 머지

편집:
  사용자 키스트로크 → Y.Text.insert/delete
  → Yjs가 delta 자동 생성 → WebSocket으로 room 전체에 relay
  → 다른 클라이언트: Y.Text.observe() → DOM 업데이트

DB 저장:
  변경된 블록만 주기적 (10초 debounce)으로:
  → Y.Text → JSON(InlineNode[]) 변환 → update_block op → 서버 → DB
  → DB에 저장되는 것은 순수 JSONB (Yjs 바이너리 아님)
```

| 항목 | 평가 |
|------|------|
| 구현 비용 | **중간**. Yjs 라이브러리 활용, Y.Text ↔ JSON 변환 필요 |
| 같은 블록 동시 편집 품질 | **최상**. 글자 단위 자동 머지. Google Docs 수준 |
| 다른 블록 동시 편집 | 완벽. 각 블록이 독립 Y.Text이므로 간섭 없음 |
| 추가 의존성 | `yjs` (프론트엔드만. 백엔드 pycrdt 불필요) |
| 메모리 | 100블록 기준 ~200KB. 현재(문서 전체 Y.Doc 수십KB~수MB)와 비슷하거나 가벼움 |
| Race condition | **없음**. 모든 블록이 항상 Y.Text 상태이므로 상태 전환이 없음 |
| 적합한 경우 | 협업 품질이 중요한 제품. Google Docs/Notion급 |

**장점**:
- 검증된 CRDT 라이브러리(Yjs). rich text mark(bold/italic/mention)도 Y.Text가 지원
- **채널이 1개**. 모든 클라이언트가 동일한 경로(crdt delta)로 변경 수신. sub/unsub, JSON snapshot 등 분기 없음
- Race condition 원천 차단 — 블록 상태 전환(JSON ↔ Y.Text)이 없으므로
- diff 계산을 직접 하지 않음 — Yjs가 모든 변경을 delta로 자동 생성
- **서버가 delta를 해석하되 stateful하지 않음** — 워커는 `state bytes load → apply → save` 의 함수형 처리. Y.Doc 인메모리 유지 없음
- **클라이언트가 DB 저장에 관여하지 않음** — 편집자 이탈/크래시 시 유실 위험 없음. 진실은 Stream에, DB는 워커가 갱신

**단점**:
- Yjs 의존성 유지 (프론트 + 워커 pycrdt)
- 초기 로드 시 모든 블록에 Y.Text 생성 비용 (100블록 ~5ms, 1000블록 ~50ms)
- Stream 보존 정책 설계 필요 (compaction 또는 retention)
- 클라이언트 로컬 Y.Text 초기화(JSON → Y.Text)는 로컬 origin으로 transact → 전파 차단. Stream tail replay로 서버 상태에 수렴

**왜 "편집 블록에만 Y.Text"가 아닌가?**

편집 블록에만 Y.Text를 만들면 두 가지 문제가 발생함:

1. **비편집자에게 변경 전파 방법이 없음**: Y.Text가 없는 클라이언트는 CRDT delta를 적용할 곳이 없음. JSON snapshot을 별도로 보내야 하는데, 이는 diff 계산이 아니라 편집자의 Y.Text에서 주기적으로 JSON을 뽑아 통째로 전송하는 것. 두 종류 메시지(delta + JSON snapshot)를 서버가 관리해야 함
2. **상태 전환 시 race condition**: 블록을 클릭하는 순간 JSON → Y.Text 전환이 발생하는데, 이 시점에 원격 JSON snapshot과 CRDT delta가 겹치면 상태 불일치 가능. 해결 가능하지만 상태 머신이 복잡해짐

전체 블록에 Y.Text를 만드는 비용(~200KB, ~5ms)은 현재 방식(문서 전체 Y.Doc)과 비슷하거나 가벼우므로, 이 비용을 지불하고 구조를 극적으로 단순화하는 것이 올바른 트레이드오프임.

**현재 Yjs 사용과의 핵심 차이**:

| | 현재 (문서 전체 Yjs) | Option B (블록별 Y.Text) |
|---|---|---|
| CRDT 범위 | 문서 전체 (블록 구조 + 텍스트 전부) | **텍스트만**. 블록 구조는 서버 권위 |
| Y.Doc 구조 | 하나의 Y.Doc에 전체 문서 | 블록당 독립 Y.Doc + Y.Text |
| DB 저장 | 문서 전체 Yjs 바이너리 (수십KB~수MB) | 블록별 content JSONB + yjs_state BYTEA (블록당 ~0.5KB + ~1KB) |
| 진실의 원천 | DB 스냅샷 | Redis Stream (delta event log). DB는 lag 허용 snapshot |
| 백엔드 Yjs | pycrdt (SnapshotWorker, 문서 전체) | pycrdt (OperationConsumer, stateless 블록 단위) |
| Y.Doc 서버 인메모리 | SnapshotWorker에서 doc당 유지 | **유지 없음**. 매 Stream 이벤트마다 임시 생성/파괴 |
| 스냅샷 관리 | 30초마다 전체 바이너리 저장 | Stream 소비 시마다 해당 블록의 state + JSON 갱신 |
| 검색 | 불가 (바이너리) | 가능 (JSONB GIN index) |
| 클라이언트 저장 책임 | 없음 (서버 주도) | 없음 (서버 주도). 편집자 이탈과 무관 |

---

#### Option C: OT (Operational Transformation) 직접 구현

```
Client A: insert('X', pos=5)  ─┐
                                ├─ Server: transform(A, B) → 위치 보정 후 둘 다 적용
Client B: insert('Y', pos=5)  ─┘
```

| 항목 | 평가 |
|------|------|
| 구현 비용 | **매우 높음**. rich text transform 함수를 직접 구현해야 함 |
| 같은 블록 동시 편집 품질 | **최상**. 정확한 위치 변환 |
| 다른 블록 동시 편집 | 영향 없음 |
| 추가 의존성 | 없음 (전부 자체 구현) |
| 서버 부하 | 서버가 transform 연산 수행. 상태 유지 필요 |
| 적합한 경우 | Google 규모 팀이 수년간 투자 가능할 때 |

**장점**: 외부 의존성 없음. 서버가 완전한 제어권 보유.
**단점**: rich text OT는 구현 난이도 최상. bold/italic/link/mention 같은 mark가 끼면 transform 함수가 조합 폭발. Google Docs 팀이 수년간 고생한 영역. 실질적으로 소규모 팀에서는 비현실적. 오픈소스 rich text OT 라이브러리도 거의 없음.

---

#### Option D: 키스트로크 단위 LWW (세밀한 LWW)

```
Client A: 매 키스트로크마다 block-3의 전체 content 전송
Client B: 수신 즉시 반영, 본인 편집 중이면 커서 위치 보정 시도
```

| 항목 | 평가 |
|------|------|
| 구현 비용 | **낮음**. 매 키스트로크마다 content 전체를 전송/수신 |
| 같은 블록 동시 편집 품질 | **보통~나쁨**. 빠른 전송으로 유실 범위는 줄지만, 동시 타이핑 시 커서 점프/글자 유실 여전 |
| 네트워크 | 키스트로크마다 블록 전체 content 전송. 블록이 크면 비효율 |
| 적합한 경우 | 저지연 환경 + 짧은 블록 위주 |

**장점**: CRDT/OT 없이 단순 구현. 블록이 짧으면(1~2줄) 실용적.
**단점**: 동시 타이핑 시 여전히 글자 유실/커서 점프 발생. diff 기반 패치가 아니라 전체 교체이므로 커서 위치 복원이 불완전. 블록 길이에 비례해 네트워크 비용 증가.

---

#### 옵션 비교 요약

| 기준 | A: LWW | B: 블록 CRDT | C: OT | D: 키스트로크 LWW |
|------|--------|-------------|-------|------------------|
| 구현 비용 | 최소 | 중간 | 매우 높음 | 낮음 |
| 동시 편집 품질 | 나쁨 | 최상 | 최상 | 보통 |
| 추가 의존성 | 없음 | yjs (FE only) | 없음 | 없음 |
| 서버 복잡도 | 최소 | 최소 (relay만) | 높음 | 최소 |
| 네트워크 효율 | 좋음 | 좋음 (delta) | 좋음 | 나쁨 |
| 편집 유실 위험 | 있음 | 없음 | 없음 | 부분적 |
| 실현 가능성 | 즉시 | 2~3주 | 수개월 | 즉시 |

> **참고**: Option A나 D로 시작하고 나중에 B로 전환하는 것도 가능.
> 블록 구조 레이어는 동일하므로, 블록 내부 텍스트 동기화 전략만 교체하면 됨.

---

### 4.4 WebSocket 연결 구조 — 문서 단위 Room + blockId별 delta relay

문서당 1개 WebSocket. WS 서버는 stateless이며 delta를 해석하지 않는다. 
**블록마다 연결을 따로 열지 않는다.** 하나의 Room에서 blockId를 태그로 달아 relay하고 동시에 Redis Stream에 적재한다.

#### 4.4.1 연결 구조

```
┌─ Client A ─────────────────────────────────────────────┐
│                                                         │
│  WebSocket: ws://socket-server/v3/docs/{docId}          │
│  + query param: ?sinceStreamId=<last>                   │
│                                                         │
│  문서 로드 시:                                            │
│    1) GET /blocks → { blocks, lastStreamId }            │
│    2) 모든 텍스트 블록에 Y.Text 생성                       │
│       (content JSON → Y.Text.applyDelta,                │
│        로컬 origin으로 transact → 네트워크 전파 차단)       │
│    3) WS 연결 (sinceStreamId=lastStreamId)               │
│       → 서버가 Stream replay로 DB lag 보정                │
│                                                         │
│  편집 시 (block-3에 타이핑):                               │
│    Y.Text.insert() → Yjs가 delta 자동 생성                │
│    → { ch:'crdt', blockId:'block-3', delta } 전송         │
│                                                         │
│  원격 변경 수신 (block-7이 변경됨):                         │
│    { ch:'crdt', blockId:'block-7', delta,                 │
│      streamId:'17045...' } 수신                            │
│    → 해당 블록의 Y.Text에 applyUpdate                      │
│    → Y.Text.observe() → DOM 업데이트                       │
│    → lastStreamId = streamId 로 갱신                      │
│                                                         │
└────────────────────┬────────────────────────────────────┘
                     │ 1개 WebSocket
                     ▼
┌─ WebSocket Server (stateless) ──────────────────────────┐
│                                                          │
│  Room: doc-{docId}                                       │
│  ├─ User A (ws conn)                                     │
│  ├─ User B (ws conn)                                     │
│  └─ User C (ws conn)                                     │
│                                                          │
│  메시지 처리:                                              │
│  ├─ ch:'crdt'                                            │
│  │    ├─ Room broadcastExcept (peer 수렴용)               │
│  │    └─ Redis XADD doc:{docId}:stream                   │
│  │       → streamId 획득 → 메시지에 부여해 재브로드캐스트   │
│  ├─ ch:'ops'   → 서버 검증(version) → broadcast + Stream  │
│  ├─ ch:'awareness' → relay (Stream 안 들어감)             │
│  └─ 연결 직후 sinceStreamId가 있으면                       │
│      Redis XRANGE doc:{docId}:stream sinceId + → 개별 전송│
│                                                          │
│  서버는 Y.Text 상태를 모른다. delta를 해석하지 않는다.       │
│                                                          │
└──────────────────────────────────────────────────────────┘

Redis 구조:
  doc:{docId}:stream  — delta event log (MAXLEN 또는 MINID 기반 retention)
    entry: { blockId, delta (bytes), userId, ts, opType:'crdt'|'ops' }
  
  PubSub 채널은 WS 서버 multi-node 운영 시 room fan-out에만 사용.
```

#### 4.4.2 서버 핸들러

```typescript
// WebSocket Server V3 — stateless
ws.on('message', async (raw) => {
  const msg = decode(raw)
  
  switch (msg.ch) {
    case 'crdt': {
      // Stream 적재 (진실의 원천)
      const streamId = await redis.xadd(
        `doc:${docId}:stream`, '*',
        'kind', 'crdt',
        'blockId', msg.blockId,
        'delta', msg.delta,
        'userId', ws.userId,
      )
      // streamId를 부여해서 Room relay — 클라이언트가 lastStreamId를 추적
      room.broadcastExcept(ws, encode({ ...msg, streamId, userId: ws.userId }))
      break
    }
    
    case 'ops': {
      // 블록 구조 변경 — 서버 검증 후 broadcast + Stream 적재
      const results = await applyBlockOps(docId, msg.ops, ws.userId)
      ws.send(encode({ ch: 'ack', seq: msg.clientSeq, results }))
      
      const appliedOps = results.filter(r => r.status === 'applied')
      if (appliedOps.length > 0) {
        const streamId = await redis.xadd(
          `doc:${docId}:stream`, '*',
          'kind', 'ops',
          'ops', JSON.stringify(appliedOps),
          'userId', ws.userId,
        )
        room.broadcastExcept(ws, encode({
          ch: 'remote_ops', ops: appliedOps, streamId, userId: ws.userId
        }))
      }
      break
    }
    
    case 'awareness':
      room.broadcastExcept(ws, raw)  // Stream 적재 안 함 (휘발성)
      break
  }
})

// 클라이언트 접속 직후 replay
ws.on('connect', async ({ sinceStreamId }) => {
  if (!sinceStreamId) return
  const entries = await redis.xrange(`doc:${docId}:stream`, sinceStreamId, '+')
  for (const [streamId, fields] of entries) {
    ws.send(encodeStreamEntry(streamId, fields))
  }
})
```

#### 4.4.3 DB 반영 — pycrdt 기반 stateless OperationConsumer

**핵심 원칙**
- 클라이언트는 DB 저장에 관여하지 않는다 (이탈/크래시 유실 0).
- Consumer는 **인메모리 Y.Doc을 유지하지 않는다** (매 이벤트마다 임시 생성/파괴).
- Consumer는 **수평 확장 가능** — Stream consumer group이 blockId로 partition.

```python
# api-docs/app/document/infrastructure/consumers/operation_consumer.py

class OperationConsumer:
    """
    Redis Stream의 delta event를 소비해 DB에 블록 단위로 반영한다.
    State는 DB(yjs_state BYTEA)에 영속화. 워커는 완전 stateless.
    """
    
    async def consume(self):
        while True:
            entries = await self.redis.xreadgroup(
                group='block-ops', consumer=self.consumer_id,
                streams={self.stream_key: '>'},
                count=50, block=2000,
            )
            if entries:
                await self._process_batch(entries)
    
    async def _process_batch(self, entries):
        # 같은 blockId의 연속 delta는 모아서 한 번에 apply (IO 절감)
        by_block: dict[UUID, list] = group_by(entries, key=lambda e: e['blockId'])
        
        async with self.db.begin() as tx:
            for block_id, block_entries in by_block.items():
                if block_entries[0]['kind'] == 'ops':
                    await self._apply_structure_ops(tx, block_entries)
                else:
                    await self._apply_crdt_deltas(tx, block_id, block_entries)
        
        # 배치 전체가 성공하면 XACK
        await self.redis.xack(self.stream_key, 'block-ops',
                              *[e['id'] for e in entries])
    
    async def _apply_crdt_deltas(self, tx, block_id, entries):
        """블록별 delta 배치를 state bytes에 반영"""
        row = await tx.fetchone(
            "SELECT yjs_state, last_applied_stream_id "
            "FROM doc_blocks WHERE block_id = $1 FOR UPDATE",
            block_id,
        )
        
        # 임시 Y.Doc — 매 호출마다 생성, 끝나면 폐기
        ydoc = Y.YDoc()
        if row['yjs_state']:
            Y.apply_update(ydoc, row['yjs_state'])
        ytext = ydoc.get_text(block_id.hex)
        
        last_stream_id = row['last_applied_stream_id']
        for entry in entries:
            # idempotency: 이미 반영된 streamId는 건너뜀
            if last_stream_id and entry['id'] <= last_stream_id:
                continue
            Y.apply_update(ydoc, entry['delta'])
            last_stream_id = entry['id']
        
        new_state = Y.encode_state_as_update(ydoc)
        new_content = ytext_to_inline_nodes(ytext)  # Y.Text → InlineNode[]
        
        await tx.execute(
            "UPDATE doc_blocks "
            "SET yjs_state = $1, content = $2, last_applied_stream_id = $3, "
            "    updated_at = now() "
            "WHERE block_id = $4",
            new_state, json.dumps(new_content), last_stream_id, block_id,
        )
        # ydoc은 함수 반환과 함께 GC — 인메모리 유지 없음
```

**idempotency**: `last_applied_stream_id` 를 비교하므로 같은 delta가 재배달돼도 중복 적용되지 않음. Consumer group 재시작/재처리 안전.

**cold start** (`yjs_state`가 NULL인 블록): `insert_block` 직후엔 state가 비어있음. 첫 delta부터 쌓아서 state를 구성.

**Stream retention 정책**:
- `MAXLEN ~100000` 또는 `MINID` 기반 (예: 7일 이전 제거).
- 클라이언트가 오래 오프라인 상태에서 접속 시 `sinceStreamId`가 trim된 구간이면 full reload(`GET /blocks`)로 fallback.

**크래시/이탈 내성**:
- 클라이언트: 이탈해도 Stream에 이미 적재된 delta는 Consumer가 DB에 반영. 유실 없음.
- Consumer: 재시작하면 XACK 안 된 메시지부터 재처리. state bytes가 DB에 있으니 idempotent 적용.
- WS 서버: stateless. 재시작/스케일아웃 자유.

#### 4.4.4 Option A/D(LWW 계열) 채택 시 WebSocket

CRDT 채널이 불필요. 블록 텍스트 변경도 일반 operation으로 처리:

```typescript
type ClientMessage =
  | { ch: 'ops';       ops: BlockOperation[]; seq: number }
  | { ch: 'awareness'; state: AwarenessState }

// 블록 텍스트 변경 = update_block operation
// { op: 'update_block', blockId: 'block-3', payload: { content: {...} } }
// crdt 채널 없음. 서버가 version 비교로 충돌 처리
```

### 4.5 WebSocket 메시지 프로토콜 (최종)

```typescript
// 접속 URL
// ws://socket-server/v3/docs/{docId}?sinceStreamId={lastStreamId}

// Client → Server
type ClientMessage =
  | { ch: 'ops';       ops: BlockOperation[]; clientSeq: number }   // 블록 구조 변경
  | { ch: 'crdt';      blockId: string; delta: Uint8Array }          // 블록 텍스트 delta
  | { ch: 'awareness'; state: AwarenessState }                       // 커서/프레즌스

// Server → Client
type ServerMessage =
  | { ch: 'ack';        clientSeq: number; results: OpResult[] }
  | { ch: 'nack';       clientSeq: number; conflicts: ConflictInfo[] }
  | { ch: 'remote_ops'; ops: BlockOperation[]; userId: number; streamId: string }
  | { ch: 'crdt';       blockId: string; delta: Uint8Array; userId: number; streamId: string }
  | { ch: 'awareness';  users: AwarenessInfo[] }
  | { ch: 'replay_done'; streamId: string }    // sinceStreamId 기반 replay 종료 신호
  | { ch: 'reload_required'; reason: 'stream_trimmed' }  // Stream retention 경계 초과 → full reload

interface BlockOperation {
  op: 'insert_block' | 'delete_block' | 'move_block'
     | 'update_attrs' | 'update_content'
  blockId: string
  payload: Record<string, unknown>
  version?: number   // insert/delete/move/update_attrs 시 필수 (Optimistic Lock)
                     // update_content는 version 불필요 (LWW, §4.7)
}

interface OpResult {
  blockId: string
  newVersion: number
  status: 'applied' | 'conflict'
}

// 초기 로드 응답 (REST, 참고)
interface LoadBlocksResponse {
  blocks: Block[]
  lastStreamId: string   // 이 시점의 Stream cursor. WS 접속 시 sinceStreamId로 전달
}
```

> **채널 규약**
> - sub/unsub 없음. 모든 클라이언트가 Room 입장 시 전체 블록의 crdt delta를 수신한다.
> - 서버는 crdt delta를 해석하지 않고 Room 전체에 relay + Stream 적재.
> - 모든 delta/ops 메시지는 **streamId를 함께 전달**한다. 클라이언트는 가장 최근 수신한 streamId를 저장했다가 재연결 시 `sinceStreamId`로 보낸다.
> - `reload_required`를 받으면 `GET /blocks`로 full reload. Stream retention을 초과한 장기 오프라인 케이스.

### 4.6 성능 분석 (Option B 기준)

#### 4.6.1 프론트엔드

**초기 로드 — Y.Text 생성 비용**

```
JSON → Y.Text 변환 (블록 1개):
  짧은 문단 (50자): ~0.05ms, ~2KB 메모리
  긴 문단 (1000자 + mark 20개): ~1ms, ~5KB 메모리

블록 수별:
  100블록: ~5ms, ~200KB    ← 대부분의 문서
  500블록: ~25ms, ~1MB
  1000블록: ~50ms, ~2MB

현재 방식 (문서 전체 Y.Doc):
  크기: 수십KB ~ 수MB (이미 이 수준)

→ 현재와 비슷하거나 가벼움. 50ms는 사용자 체감 불가 수준.
```

**키스트로크 당 비용**

```
현재:   키스트로크 → Tiptap → ProseMirror → Yjs Y.Text → delta 전송
신규:   키스트로크 → beforeInput → Y.Text → delta 전송

중간 레이어(Tiptap/ProseMirror)가 제거되므로 오히려 더 빠름.
Y.Text.insert() 호출: ~0.01ms
Yjs update 이벤트 → delta 생성: ~0.01ms
```

**DOM ↔ Y.Text 바인딩**

```
사용자 입력 → Y.Text 반영:
  beforeInput 이벤트에서 커서 위치(offset) 계산 후 Y.Text API 호출
  이건 Tiptap이 내부적으로 하던 것과 동일한 작업

원격 Y.Text 변경 → DOM 반영:
  Y.Text.observe() 콜백에서 event.delta를 DOM에 적용
  delta: [{ retain: 5 }, { insert: ' world', attributes: { bold: true } }]
  → DOM에서 offset 5 뒤에 <strong> world</strong> 삽입
  per-delta: ~0.1ms
```

**백엔드 블록 조립 비용**

```sql
-- 문서 블록 전체 조회: 단일 쿼리
SELECT block_id, parent_id, position, type, content, version
FROM doc_blocks WHERE doc_id = :doc_id
ORDER BY parent_id NULLS FIRST, position;
```

```
100블록 기준:
  DB 쿼리: 1회, ~1ms (인덱스 활용)
  응답 조립: flat → tree grouping (O(n) dict 조회), ~1ms
  JSONB 컬럼은 파싱/변환 없이 그대로 응답에 포함

현재:
  doc_snapshots에서 yjs_state_bytes 1행 조회 + base64 인코딩
  시간은 비슷하지만, 전송 크기가 수십KB~수MB

→ 조립 비용은 사실상 없음. JSONB를 그대로 내려보내는 것.
```

#### 4.6.2 백엔드

**DB 쓰기 비교**

```
시나리오: 100블록 문서, 3명이 5분간 동시 편집 (각각 10개 블록 수정)

현재 (Yjs Snapshot):
  30초마다 전체 스냅샷 UPSERT = 10회
  각 스냅샷: ~200KB (100블록 Yjs 바이너리)
  총 DB 쓰기: ~2MB, 대형 BYTEA 10회 UPSERT

신규 (Block Operation):
  변경된 블록만 debounced (10초) 저장
  3명 × 10블록 = 30개 블록 UPDATE
  각 UPDATE: ~0.5KB JSONB
  총 DB 쓰기: ~15KB, 소형 JSONB 30회 UPDATE

→ 쓰기량 ~99% 감소. 횟수 3배 증가하나 각각 매우 작음.
  PostgreSQL은 소형 JSONB UPDATE를 대형 BYTEA UPSERT보다 훨씬 효율적으로 처리.
```

**WebSocket 서버 부하**

```
현재: Yjs delta를 Room 전체에 relay (바이너리, 해석 안 함)
신규: Yjs delta를 Room 전체에 relay (바이너리, blockId 태그 추가)

→ 동일. 메시지에 blockId 필드 하나 추가된 것 외에 차이 없음.
```

**Redis 부하**

```
현재:
  Redis Stream: 키스트로크 단위 Yjs delta 전부 적재
  Redis Pub/Sub: 같은 delta를 Room broadcast

신규:
  Redis Pub/Sub: crdt delta relay (현재와 동일)
  Redis Stream: update_block operation만 (10초 debounce, 빈도 훨씬 낮음)

→ Redis Stream 부하 감소. 키스트로크 단위 delta가 Stream에 쌓이지 않음.
```

#### 4.6.3 주의 시나리오

```
100명이 같은 문서를 열고 있고, 5명이 각각 다른 블록 편집 중

crdt delta 전파:
  5명 × 초당 5회 타이핑 = 초당 25개 delta
  각 delta → Room의 99명에게 relay = 초당 2475개 메시지 전송

현재 방식도 동일 (문서 전체 delta를 100명에게 broadcast)

단, 수신 측:
  현재: 문서 전체 Y.Doc에 적용 (한 곳)
  신규: blockId로 해당 Y.Text에 적용 (Map lookup 1회 추가, ~0.001ms)

→ 현재와 사실상 동일.
```

### 4.7 Operation 충돌 정책

| op_type | 충돌 처리 | 이유 |
|---|---|---|
| `insert_block` | **Optimistic Lock — 서버 권위**. `blockId` 중복 / `parent_id` 미존재 / `position` 충돌 시 nack | 블록 구조는 단일 진실이 필요. position UNIQUE 제약 있음 |
| `delete_block` | **Optimistic Lock**. `version` 불일치 시 nack | 중간에 편집된 블록을 실수로 삭제하지 않기 위해 |
| `move_block` | **Optimistic Lock** + parent advisory lock. LexoRank 리밸런싱 중이면 대기 | 트리 구조 일관성 |
| `update_attrs` | **Optimistic Lock**. `version` 불일치 시 nack | 블록 속성(checked, language, icon 등)은 LWW가 위험 — 서로 다른 의미의 변경이 동시에 들어올 수 있음 |
| `update_content` (텍스트) | **LWW — version 검사 없이 덮어쓰기** | 텍스트는 CRDT가 수렴을 보장. 실제로는 이 op를 보내지 않고 `crdt` 채널 delta로 처리됨 (§4.2) |
| `crdt` delta | **검사 없음**. Stream에 적재하고 peer에 relay | CRDT 자체가 수렴 보장 |

**핵심 구분**
- **구조 변경**(트리, 속성): 서버가 순서를 강제하고 충돌 시 클라이언트가 재시도. "서버 권위".
- **텍스트 내용**: CRDT delta로 merge. 서버는 해석하지 않음.

**nack 처리 흐름**
```
1. 서버: nack { clientSeq, conflicts: [{ blockId, currentVersion, currentState }] }
2. 클라이언트: 해당 블록만 서버 상태로 rebase
3. 사용자가 덮어쓸지 선택 (UI) — 대개는 자동 재시도 가능
```

**move_block의 parent advisory lock**

같은 부모의 자식 블록에 대해 `move_block` 처리 중 LexoRank 리밸런싱이 필요해지면 position UNIQUE 제약에 걸릴 수 있다. 트랜잭션 내에서 parent에 대해 `pg_advisory_xact_lock(doc_id, parent_id_hash)`를 획득해 직렬화.

**ACID 경계**
- `ops` 처리 트랜잭션: version 비교 + position 재계산 + DB 변경 + Stream XADD 가 같은 논리적 단위. Stream XADD는 성공한 op에 대해서만 수행.
- `crdt` delta는 version 없이 Stream 적재 후 Consumer가 처리.

---

## 5. 프론트엔드 아키텍처

### 5.1 컴포넌트 구조

```
DocumentPage
├── DocumentHeader (title, breadcrumb, share, ...)
├── BlockEditor
│   ├── BlockTree (상태 관리)
│   │   ├── useBlockStore (zustand)
│   │   └── useOperationQueue (optimistic updates + ack)
│   ├── BlockRenderer (가상화된 블록 목록)
│   │   ├── BlockWrapper (공통: drag handle, menu, indent)
│   │   │   ├── ParagraphBlock → ContentEditableBlock
│   │   │   ├── HeadingBlock → ContentEditableBlock
│   │   │   ├── CodeBlock → CodeMirror / Monaco
│   │   │   ├── ImageBlock → ImageUploader
│   │   │   ├── TodoBlock → Checkbox + ContentEditableBlock
│   │   │   ├── CalloutBlock → Icon + ContentEditableBlock
│   │   │   ├── ToggleBlock → Collapsible + children
│   │   │   ├── TableBlock → TableEditor
│   │   │   ├── DividerBlock → <hr />
│   │   │   └── EmbedBlock → iframe
│   │   └── BlockDropZone (drag & drop 영역)
│   ├── SlashCommandMenu (블록 타입 선택)
│   ├── BlockDragOverlay (드래그 미리보기)
│   └── SelectionManager (다중 블록 선택)
└── CollaborationBar (접속 유저, 커서 표시)
```

### 5.2 BlockStore (Zustand)

```typescript
interface BlockStore {
  // 상태
  blocks: Map<string, Block>          // blockId → Block
  rootOrder: string[]                 // 최상위 블록 ID 정렬
  childrenMap: Map<string, string[]>  // parentId → childIds 정렬
  
  // 편집
  focusedBlockId: string | null
  selectedBlockIds: Set<string>
  
  // 동기화
  pendingOps: Operation[]             // 서버 ACK 대기 중
  serverSeq: number                   // 마지막 수신한 server sequence
  
  // Actions
  insertBlock(type: BlockType, afterId?: string, parentId?: string): string
  updateBlock(blockId: string, content: Partial<BlockContent>): void
  deleteBlock(blockId: string): void
  moveBlock(blockId: string, toParentId: string | null, afterId?: string): void
  
  // Remote
  applyRemoteOps(ops: Operation[]): void
  handleAck(clientSeq: number, results: OpResult[]): void
  handleNack(clientSeq: number, conflicts: ConflictInfo[]): void
}
```

### 5.3 에디터 전략 — Custom contentEditable (Tiptap/ProseMirror 제거)

Tiptap/ProseMirror를 완전히 제거하고, Notion과 동일하게 Custom contentEditable 기반으로 구현한다.

#### 왜 Tiptap을 제거하는가

- 블록마다 Tiptap 인스턴스를 만드는 것은 메모리/성능 최악
- 그렇다고 문서 전체를 하나의 Tiptap으로 관리하면 블록 구조 제어권을 잃음
- Notion, Linear 등 선행 사례가 모두 자체 에디터

#### 블록별 렌더링

| 블록 타입 | 렌더링 | 비고 |
|-----------|--------|------|
| paragraph, heading, quote, callout, todo, list | **ContentEditableBlock** | `contenteditable="true"` div. Selection API로 커서/서식 직접 관리 |
| code | **CodeMirror** | 구문 강조, 자동완성. contentEditable보다 전문 에디터가 적합 |
| image, divider, embed | **커스텀 컴포넌트** | 에디터 불필요, 단순 렌더링 |
| table | **커스텀 테이블** | 셀별 contentEditable |

#### ContentEditableBlock 핵심 구현

```typescript
// 텍스트 블록의 핵심 컴포넌트
const ContentEditableBlock = ({ block, onUpdate }: Props) => {
  const ref = useRef<HTMLDivElement>(null)

  // InlineNode[] → DOM 렌더링
  useEffect(() => {
    renderInlineNodes(ref.current, block.content.children)
  }, [block.content.children])

  // 입력 캡처
  const handleBeforeInput = (e: InputEvent) => {
    e.preventDefault()
    switch (e.inputType) {
      case 'insertText':
        insertTextAtCursor(ref.current, e.data)
        break
      case 'deleteContentBackward':
        deleteAtCursor(ref.current, 'backward')
        break
      case 'formatBold':
        toggleMark('bold')
        break
      // ...
    }
    // DOM → InlineNode[] 변환 → onUpdate
    onUpdate(domToInlineNodes(ref.current))
  }

  // 서식 적용 (toolbar 또는 단축키)
  const toggleMark = (mark: MarkType) => {
    const selection = window.getSelection()
    if (!selection?.rangeCount) return
    applyMarkToRange(ref.current, selection.getRangeAt(0), mark)
    onUpdate(domToInlineNodes(ref.current))
  }

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onBeforeInput={handleBeforeInput}
      // IME 처리 (한국어/일본어/중국어)
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
    />
  )
}
```

#### 직접 구현해야 하는 것

| 기능 | 구현 방식 | 복잡도 |
|------|-----------|--------|
| Bold/Italic/Strikethrough | Selection API + `<strong>`/`<em>` 래핑 | 중간 |
| Link | Selection + `<a>` 래핑 + 팝오버 UI | 중간 |
| @Mention | 트리거 문자 감지 + 검색 팝업 + 커스텀 노드 삽입 | 높음 |
| IME (한국어 등) | compositionstart/end 이벤트 핸들링 | 높음 |
| 붙여넣기 정규화 | clipboard API + HTML 파싱 → InlineNode[] 변환 | 높음 |
| Undo/Redo | 자체 히스토리 스택 (블록 단위) | 중간 |
| 커서 위치 복원 | Selection API + offset 계산 | 중간 |

> **구현 비용이 높지만**, 블록 구조 + 인라인 서식이라는 범위가 명확하므로
> 전체 에디터 프레임워크를 만드는 것과는 다름. 각 기능을 독립적으로 구현 가능.

### 5.4 블록 간 키보드 네비게이션

```typescript
// 블록 간 이동 로직
const handleKeyDown = (e: KeyboardEvent, blockId: string) => {
  switch (true) {
    // Enter: 현재 블록 아래에 새 paragraph 삽입
    case e.key === 'Enter' && !e.shiftKey:
      const newId = store.insertBlock('paragraph', blockId)
      store.focusBlock(newId)
      break
    
    // Backspace at start: 빈 블록이면 삭제, 아니면 이전 블록과 머지
    case e.key === 'Backspace' && cursorAtStart:
      if (isEmpty(blockId)) {
        store.deleteBlock(blockId)
        store.focusPrevBlock(blockId, 'end')
      } else {
        store.mergeWithPrev(blockId)
      }
      break
    
    // Arrow Up/Down at boundary: 블록 간 포커스 이동
    case e.key === 'ArrowUp' && cursorAtStart:
      store.focusPrevBlock(blockId, 'end')
      break
    
    case e.key === 'ArrowDown' && cursorAtEnd:
      store.focusNextBlock(blockId, 'start')
      break
    
    // Tab: indent (자식 블록으로)
    case e.key === 'Tab' && !e.shiftKey:
      store.indentBlock(blockId)
      break
    
    // Shift+Tab: outdent (부모 레벨로)
    case e.key === 'Tab' && e.shiftKey:
      store.outdentBlock(blockId)
      break
    
    // '/': 슬래시 커맨드 메뉴 열기
    case e.key === '/' && cursorAtStart:
      openSlashMenu(blockId)
      break
  }
}
```

### 5.5 가상화 (대규모 문서 성능)

```typescript
// 블록이 100개 이상인 문서에서 가상화 적용
// react-window나 @tanstack/virtual 사용

const BlockList = () => {
  const flatBlocks = useFlattenedBlockTree()  // 트리 → 플랫 리스트
  
  const virtualizer = useVirtualizer({
    count: flatBlocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimateBlockHeight(flatBlocks[i]),
    overscan: 10,  // 뷰포트 밖 10개 블록 미리 렌더
  })
  
  return (
    <div ref={scrollRef}>
      {virtualizer.getVirtualItems().map((virtualRow) => (
        <BlockWrapper
          key={flatBlocks[virtualRow.index].blockId}
          block={flatBlocks[virtualRow.index]}
          style={{ transform: `translateY(${virtualRow.start}px)` }}
        />
      ))}
    </div>
  )
}
```

---

## 6. 백엔드 API 설계

### 6.1 Block API

```
# 문서 블록 전체 조회 (초기 로드)
GET /api/v2/workspaces/{wid}/docs/{docId}/blocks
Response: {
  blocks: Block[],       // 트리 구조 (children 포함)
  serverSeq: number      // 현재 시퀀스 (WebSocket 재연결 시 delta 요청용)
}

# 블록 Operations 제출 (비-WebSocket 폴백, 오프라인 동기화)
POST /api/v2/workspaces/{wid}/docs/{docId}/operations
Body: { ops: Operation[], clientSeq: number }
Response: { results: OpResult[], serverSeq: number }

# 단일 블록 조회
GET /api/v2/workspaces/{wid}/docs/{docId}/blocks/{blockId}

# 블록 히스토리
GET /api/v2/workspaces/{wid}/docs/{docId}/blocks/{blockId}/history
Response: { versions: BlockVersion[] }

# 문서 히스토리 (operation log)
GET /api/v2/workspaces/{wid}/docs/{docId}/history?since={serverSeq}
Response: { ops: Operation[], latestSeq: number }

# 문서 검색 (블록 내용 full-text)
GET /api/v2/workspaces/{wid}/docs/search?q={query}
Response: { results: [{ docId, blockId, snippet, ... }] }
```

### 6.2 Operation Consumer (Redis Stream → DB)

```python
# api-docs/app/document/infrastructure/consumers/operation_consumer.py

class OperationConsumer:
    """
    Redis Stream에서 block operation을 소비하여 DB에 영속화.
    
    기존 SnapshotWorker와의 차이:
    - 기존: 30초마다 yjs_state_bytes 전체 UPSERT
    - 신규: operation 단위로 해당 block만 INSERT/UPDATE/DELETE
    """
    
    BATCH_SIZE = 50         # 한 번에 처리할 최대 operation 수
    BATCH_TIMEOUT_MS = 2000 # 2초 내 BATCH_SIZE 미달이면 즉시 처리
    
    async def consume(self):
        while True:
            ops = await self.redis.xreadgroup(
                group='block-ops-group',
                consumer=self.consumer_id,
                streams={'doc_operations_stream': '>'},
                count=self.BATCH_SIZE,
                block=self.BATCH_TIMEOUT_MS,
            )
            
            if ops:
                # doc_id별로 그룹핑하여 트랜잭션 단위 최적화
                grouped = group_by_doc_id(ops)
                for doc_id, doc_ops in grouped.items():
                    await self._apply_operations(doc_id, doc_ops)
    
    async def _apply_operations(self, doc_id: int, ops: list[Operation]):
        async with self.db.begin() as tx:
            for op in ops:
                match op.op_type:
                    case 'insert_block':
                        await self._insert_block(tx, op)
                    case 'update_block':
                        await self._update_block(tx, op)
                    case 'delete_block':
                        await self._delete_block(tx, op)
                    case 'move_block':
                        await self._move_block(tx, op)
            
            # 문서 updated_at 갱신 (한 번만)
            await tx.execute(
                update(Document)
                .where(Document.id == doc_id)
                .values(updated_at=func.now())
            )
```

### 6.3 DB 쓰기량 비교 (기존 vs 신규)

```
시나리오: 100개 블록 문서에서 3명이 5분간 동시 편집
  - 각자 다른 블록을 편집, 평균 블록당 10회 수정

기존 (Yjs Snapshot):
  - 30초 × 10회 = 10번의 전체 스냅샷 UPSERT
  - 각 스냅샷: ~200KB (100블록 Yjs 바이너리)
  - 총 DB 쓰기: ~2MB, 대형 BYTEA 10회 UPSERT

신규 (Block Operation):
  - 3명 × 10회 = 30개 operation
  - 각 operation: 변경된 블록 1개의 content JSONB (~0.5KB)
  - 총 DB 쓰기: ~15KB, 소형 JSONB 30회 UPDATE
  
  → 쓰기량 ~99% 감소, 쓰기 횟수 3배 증가하나 각각 매우 작음
```

---

## 7. 정렬 전략: LexoRank

### 7.1 왜 LexoRank인가

블록의 순서를 관리하기 위해 `position` 필드에 LexoRank 문자열을 사용합니다.

```
장점:
- 블록 이동/삽입 시 다른 블록의 position 업데이트 불필요
- 정수 index (0, 1, 2...)는 중간 삽입 시 뒤의 모든 행 UPDATE 필요
- LexoRank는 두 값 사이의 중간값 생성이 O(1)

예시:
  Block A: position = "a"
  Block B: position = "n"  
  Block C: position = "z"
  
  A와 B 사이에 삽입: position = "g" (중간값)
  B와 C 사이에 삽입: position = "t"
```

### 7.2 리밸런싱

LexoRank 문자열이 너무 길어지면 (50자 초과) 해당 부모의 자식 블록들을 일괄 리밸런싱합니다.

```python
async def rebalance_positions(doc_id: int, parent_id: UUID | None):
    """같은 부모의 자식 블록들에 균등한 LexoRank 재배정"""
    children = await get_children_ordered(doc_id, parent_id)
    new_positions = generate_even_ranks(len(children))
    
    for child, pos in zip(children, new_positions):
        child.position = pos
    
    # 한 트랜잭션에서 일괄 업데이트
    await bulk_update_positions(children)
```

---

## 8. Awareness (커서/프레즌스)

기존 Yjs Awareness를 대체하는 경량 프레즌스 시스템.

```typescript
// 프론트엔드
interface AwarenessState {
  userId: number
  name: string
  color: string          // 유저별 고유 색상
  focusedBlockId: string | null
  cursor?: {             // 블록 내 커서 위치
    blockId: string
    offset: number
  }
}

// 서버: Redis Hash로 관리 (TTL 30초, heartbeat로 갱신)
// Key: awareness:{docId}
// Field: userId → JSON(AwarenessState)
```

WebSocket 메시지로 awareness 변경을 broadcast하고, Redis Hash로 서버 재시작 시에도 복원 가능.

---

## 9. 마이그레이션 전략

### 9.1 단계별 전환

```
Phase 1: Block 모델 구축 + 양방향 변환기 (2주)
  ├─ doc_blocks 테이블 + API 구현
  ├─ TiptapJSON → Block[] 변환기 (기존 TiptapAdapter 확장)
  ├─ Block[] → TiptapJSON 역변환기
  └─ 기존 doc_snapshots에서 blocks 생성하는 마이그레이션 스크립트

Phase 2: 프론트엔드 BlockEditor MVP (3주)
  ├─ BlockStore (zustand) + BlockRenderer
  ├─ 기본 블록 타입 (paragraph, heading, list, code, image, divider)
  ├─ 키보드 네비게이션 + 슬래시 커맨드
  └─ REST API 기반 저장 (아직 실시간 동기화 없음)

Phase 3: 실시간 동기화 (2주)
  ├─ WebSocket Operation 프로토콜 구현
  ├─ OperationQueue (optimistic update + ack)
  ├─ Awareness (커서/프레즌스) → 기존 relay 서버 확장
  └─ OperationConsumer (Redis Stream → DB)

Phase 4: 고급 기능 + 안정화 (2주)
  ├─ 드래그 앤 드롭 (블록 이동)
  ├─ 다중 블록 선택 + 일괄 작업
  ├─ 테이블 블록, callout, toggle
  ├─ 블록 히스토리/되돌리기
  └─ Full-text search

Phase 5: Yjs 제거 + 정리 (1주)
  ├─ doc_snapshots 테이블 deprecate
  ├─ yjs, pycrdt 의존성 제거
  ├─ WebSocket 서버 V1 경로 제거
  └─ relay-provider.ts 제거
```

### 9.2 데이터 마이그레이션

```python
# 기존 yjs_state_bytes → doc_blocks 변환

async def migrate_document(doc_id: int):
    # 1. Yjs 바이너리에서 Tiptap JSON 추출
    snapshot = await get_snapshot(doc_id)
    ydoc = Y.Doc()
    Y.applyUpdate(ydoc, snapshot.yjs_state_bytes)
    tiptap_json = ydoc.getXmlFragment('default').toJSON()
    
    # 2. Tiptap JSON → Block[] 변환
    blocks = tiptap_to_blocks(tiptap_json)
    
    # 3. DB에 블록 삽입
    for block in blocks:
        await insert_block(doc_id, block)
```

---

## 10. 기존 코드 활용/변경 가이드

### 10.1 유지하는 것

| 모듈 | 경로 | 활용 방법 |
|------|------|-----------|
| DynamicDoc 타입 | `web/shared/dynamic-doc/types.ts` | Block 타입 시스템의 기반으로 확장 |
| TiptapAdapter | `web/shared/dynamic-doc/adapters/tiptap-adapter.ts` | 데이터 마이그레이션 변환기 (기존 Tiptap JSON → Block[] 변환용) |
| MarkdownAdapter | `web/shared/dynamic-doc/adapters/markdown-adapter.ts` | 내보내기/붙여넣기 기능 |
| doc_blocks 테이블 | `api-docs/models/block_model.py` | 스키마 확장하여 사용 (version, depth 등 추가) |
| Redis Stream 패턴 | `api-docs/snapshot_worker.py` | OperationConsumer에서 같은 패턴 사용 |
| WebSocket 서버 | `web-socket-for-docs/` | V3 경로 추가하여 Operation + CRDT relay 프로토콜 구현 |
| yjs (§4.3 Option B 채택 시) | `web/` | 블록 내부 텍스트 CRDT 전용. 프론트엔드만 |

### 10.2 제거/대체하는 것

| 모듈 | 경로 | 대체 |
|------|------|------|
| Tiptap / ProseMirror | `web/shared/ui/tiptap/` 전체 | Custom contentEditable |
| relay-provider.ts | `web/shared/ui/tiptap/relay-provider.ts` | BlockSyncProvider |
| use-collaboration-sync-v2 | `web/shared/ui/tiptap/` | useBlockSync |
| Tiptap 확장들 | `web/shared/ui/tiptap/extensions/` | Custom 인라인 서식 (Selection API) |
| SnapshotWorker | `api-docs/snapshot_worker.py` | OperationConsumer |
| doc_snapshots 테이블 | `api-docs/models/snapshot_model.py` | doc_blocks + doc_operations |
| pycrdt (백엔드) | `api-docs/` | 제거 (CRDT는 프론트엔드만) |
| V1/V2 WebSocket 핸들러 | `web-socket-for-docs/src/v2/` | V3 Operation + CRDT relay 핸들러 |

---

## 11. 리스크 및 고려사항

### 11.1 Custom contentEditable 구현 비용

- **문제**: Tiptap/ProseMirror 없이 직접 구현하므로 인라인 서식, IME, 붙여넣기 등을 모두 자체 처리
- **대응**:
  - 블록 단위로 독립적이므로 기능을 점진적으로 추가 가능
  - MVP: paragraph + heading + bold/italic만 → 이후 mention, link, 복잡한 붙여넣기 순차 추가
  - IME(한국어)는 compositionstart/end로 처리. 초기부터 반드시 고려

### 11.2 블록 내부 텍스트 동시 편집 (§4.3 의사결정에 따름)

- **Option A/D(LWW) 채택 시**: 같은 블록 동시 편집에서 편집 유실 가능. Awareness로 완화
- **Option B(CRDT) 채택 시**: Y.Text ↔ InlineNode[] 양방향 변환 구현. 브라우저 크래시 시 dirty 블록 유실 (최대 10초분). beforeunload에서 즉시 저장 시도로 완화
- **Option C(OT) 채택 시**: rich text transform 함수 구현 난이도 및 버그 위험

### 11.3 오프라인 편집

- **현재 스코프 밖**: 최초 버전에서는 온라인 전용
- **향후 확장**: OperationQueue를 IndexedDB에 영속화하면 오프라인 → 온라인 동기화 가능

### 11.4 대규모 문서

- 블록 1000개 이상: 가상화 + lazy loading (스크롤 시 블록 데이터 추가 로드)
- 블록 5000개 이상: 페이지 분할 권장 (UX 가이드)

---

## 12. 요약

| 항목 | 기존 | 신규 |
|------|------|------|
| 저장 단위 | 문서 전체 (Yjs binary) | 블록 개별 (JSONB row) |
| 동기화 — 블록 구조 | CRDT state sync | 서버 권위 + Optimistic Lock |
| 동기화 — 블록 내부 텍스트 | CRDT (문서 전체에 포함) | 블록별 독립 Y.Text (인메모리, DB에 JSON 저장) |
| DB 부하 | 높음 (주기적 대형 UPSERT) | 낮음 (변경 블록만 소형 UPDATE) |
| 검색 | 불가 | Full-text search (GIN index) |
| 기능 확장 | Yjs 스키마 종속 | Block type 추가만으로 확장 |
| 블록 단위 제어 | 불가 | 권한, 히스토리 가능 |
| 프론트엔드 에디터 | 단일 Tiptap + Yjs | Custom contentEditable (Tiptap 제거) |
| WebSocket 구조 | 문서당 1개 WS, 전체 delta relay | 문서당 1개 WS, blockId별 delta relay (동일 구조) |
| 성능 (초기 로드) | Yjs 바이너리 파싱 | JSON 렌더 + Y.Text 생성 (~5ms/100블록) |
| 성능 (DB 쓰기) | 30초마다 수십KB~수MB | 10초 debounce, 변경 블록만 ~0.5KB |
| 예상 전환 기간 | - | ~10주 (5 Phase) |
