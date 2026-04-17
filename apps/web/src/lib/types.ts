// ========================================
// Wire Types — mirror docs/protocol.md
// ========================================

export type BlockType =
  | "paragraph"
  | "heading"
  | "code"
  | "blockquote"
  | "divider"
  | "image"
  | "bulleted_list"
  | "numbered_list"
  | "todo"
  | "callout";

export type MarkType = "bold" | "italic" | "strike" | "code" | "link" | "comment";

export interface Mark {
  type: MarkType;
  attrs?: Record<string, unknown>;
}

export type InlineNode =
  | { type: "text"; text: string; marks?: Mark[] }
  | { type: "mention"; attrs: { userId: number; label: string } };

export interface BlockContent {
  children?: InlineNode[];
  attrs?: Record<string, unknown>;
}

export interface Block {
  blockId: string;
  parentId: string | null;
  position: string; // LexoRank
  depth: number;
  type: BlockType;
  content: BlockContent;
  version: number;
}

export type OpKind =
  | "insert_block"
  | "delete_block"
  | "move_block"
  | "update_attrs"
  | "update_content";

export interface BlockOperation {
  op: OpKind;
  blockId: string;
  payload: Record<string, unknown>;
  version?: number;
}

export interface OpResult {
  blockId: string;
  newVersion: number;
  status: "applied" | "conflict";
  current?: Block;
}

export interface AwarenessState {
  focusedBlockId?: string | null;
  cursor?: { blockId: string; offset: number };
}

export interface AwarenessEntry {
  userId: number;
  state: AwarenessState;
  color: string;
  name: string;
}

export interface User {
  id: number;
  handle: string;
  name: string;
  color: string;
}

export interface BlocksResponse {
  docId: number;
  blocks: Block[];
  lastStreamId: string;
}

export interface PresignResponse {
  uploadUrl: string;
  publicUrl: string;
  imageId: string;
}

// ----------------------------------------
// WS frames (from server to client)
// ----------------------------------------
export type ServerMessage =
  | { ch: "hello"; userId: number; lastStreamId: string }
  | { ch: "ack"; clientSeq: number; results: OpResult[] }
  | { ch: "nack"; clientSeq: number; conflicts: Array<{ blockId: string; reason: string; current?: Block }> }
  | {
      ch: "remote_ops";
      ops: BlockOperation[];
      userId: number;
      streamId: string;
    }
  | {
      ch: "crdt";
      blockId: string;
      delta: string;
      userId: number;
      streamId: string;
    }
  | { ch: "awareness"; users: AwarenessEntry[] }
  | { ch: "replay_done"; streamId: string }
  | { ch: "reload_required"; reason: string }
  | { ch: "ping" }
  | { ch: "pong" };

// ----------------------------------------
// WS frames (client -> server)
// ----------------------------------------
export type ClientMessage =
  | { ch: "ops"; clientSeq: number; ops: BlockOperation[] }
  | { ch: "crdt"; blockId: string; delta: string }
  | { ch: "awareness"; state: AwarenessState }
  | { ch: "pong" };
