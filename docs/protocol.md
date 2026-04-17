# Wire Protocol

Shared contract between `web`, `ws`, `api`. Derived from `docs/block-based-document.md` §4.5.

## REST (api, port 8000)

### GET `/api/v1/docs/{docId}/blocks`
Initial load snapshot + Stream cursor for lag correction.

```jsonc
// 200
{
  "docId": 1,
  "blocks": [
    {
      "blockId": "018f...",
      "parentId": null,
      "position": "m",
      "depth": 0,
      "type": "paragraph",
      "content": { "children": [{ "type": "text", "text": "Hello" }] },
      "version": 1
    }
  ],
  "lastStreamId": "1711234567890-0"
}
```

### POST `/api/v1/docs/{docId}/operations`
REST fallback for block-structure ops when WebSocket is unavailable.
Same body as `ch:"ops"` WS message.

### GET `/api/v1/users/me`
```jsonc
// 200 — userId is read from the demo `uid` cookie (1..N)
{ "id": 1, "handle": "alice", "name": "Alice", "color": "#f97316" }
```

### POST `/api/v1/images/presign`
Returns a presigned URL for upload (demo uses a mock that writes into a local
volume — URL includes the uploader's user id to keep them distinct).
```jsonc
// request
{ "contentType": "image/png", "size": 12345 }
// 200
{
  "uploadUrl": "http://localhost:8000/api/v1/images/upload/...",
  "publicUrl": "http://localhost:8000/api/v1/images/abc.png",
  "imageId": "abc"
}
```

---

## WebSocket (ws, ports 4001 / 4002)

Connection URL:
```
ws://host:port/v3/docs/{docId}?sinceStreamId={lastStreamId}&uid={userId}
```

All messages are JSON. `delta` (binary Yjs update) is base64-encoded on the wire.

### Client → Server

```ts
type ClientMessage =
  | { ch: 'ops';       clientSeq: number; ops: BlockOperation[] }
  | { ch: 'crdt';      blockId: string; delta: string /* base64 */ }
  | { ch: 'awareness'; state: AwarenessState };

interface BlockOperation {
  op: 'insert_block' | 'delete_block' | 'move_block'
    | 'update_attrs' | 'update_content';
  blockId: string;         // client-generated UUIDv7
  payload: Record<string, unknown>;
  version?: number;        // required for delete/move/update_attrs
}

interface AwarenessState {
  focusedBlockId?: string | null;
  cursor?: { blockId: string; offset: number };
}
```

### Server → Client

```ts
type ServerMessage =
  | { ch: 'hello';        userId: number; lastStreamId: string }
  | { ch: 'ack';          clientSeq: number; results: OpResult[] }
  | { ch: 'nack';         clientSeq: number; conflicts: ConflictInfo[] }
  | { ch: 'remote_ops';   ops: BlockOperation[]; userId: number; streamId: string }
  | { ch: 'crdt';         blockId: string; delta: string; userId: number; streamId: string }
  | { ch: 'awareness';    users: Array<{ userId: number; state: AwarenessState; color: string; name: string }> }
  | { ch: 'replay_done';  streamId: string }
  | { ch: 'reload_required'; reason: 'stream_trimmed' };

interface OpResult {
  blockId: string;
  newVersion: number;
  status: 'applied' | 'conflict';
  current?: Block;  // on conflict: server's current state
}
```

---

## Redis

### Stream — `doc:{docId}:stream`
Source of truth for CRDT deltas. Stream entries:

```
XADD doc:1:stream * kind crdt    blockId <uuid>  delta <bytes>  userId <int>
XADD doc:1:stream * kind ops     ops <json-string>              userId <int>
```

Retention: `MAXLEN ~ 100000` (approximate trim). Older ids → `reload_required`.

### Pub/Sub — `doc:{docId}:bus`
WS fan-out between multiple ws instances. Payload = server-to-client frame
(one message per Room broadcast). Excludes the sender socket via an
`originInstance` field.

```
PUBLISH doc:1:bus '{"originInstance":"ws-1","frame":{...ServerMessage}}'
```

Each ws instance subscribes to `doc:{docId}:bus` on demand (first user joins)
and unsubscribes when the last user leaves.

---

## Block / InlineNode shape (reminder)

```ts
type Block = {
  blockId: string;
  parentId: string | null;
  position: string;           // LexoRank
  depth: number;
  type: 'paragraph' | 'heading' | 'code' | 'blockquote' | 'divider'
      | 'image' | 'bulleted_list' | 'numbered_list' | 'todo' | 'callout';
  content: BlockContent;
  version: number;
};

type BlockContent = {
  children?: InlineNode[];
  attrs?: Record<string, unknown>;
};

type InlineNode =
  | { type: 'text'; text: string; marks?: Mark[] }
  | { type: 'mention'; attrs: { userId: number; label: string } };

type Mark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'strike' }
  | { type: 'code' }
  | { type: 'link'; attrs: { href: string } }
  | { type: 'comment'; attrs: { commentId: string } };
```
