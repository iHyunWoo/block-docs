/**
 * Wire protocol — zod schemas + inferred TS types.
 *
 * Mirrors docs/protocol.md exactly. This module is the single source of truth
 * that the rest of the WS server imports. Do NOT widen, narrow, or rename
 * anything here without updating docs/protocol.md first.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared: BlockOperation / AwarenessState
// ---------------------------------------------------------------------------

export const BlockOperationSchema = z.object({
  op: z.enum(['insert_block', 'delete_block', 'move_block', 'update_attrs', 'update_content']),
  blockId: z.string().min(1),
  payload: z.record(z.unknown()),
  version: z.number().int().nonnegative().optional(),
});
export type BlockOperation = z.infer<typeof BlockOperationSchema>;

export const AwarenessStateSchema = z.object({
  focusedBlockId: z.string().nullable().optional(),
  cursor: z
    .object({
      blockId: z.string().min(1),
      offset: z.number().int().nonnegative(),
    })
    .optional(),
});
export type AwarenessState = z.infer<typeof AwarenessStateSchema>;

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export const ClientOpsMessageSchema = z.object({
  ch: z.literal('ops'),
  clientSeq: z.number().int().nonnegative(),
  ops: z.array(BlockOperationSchema).min(1),
});
export type ClientOpsMessage = z.infer<typeof ClientOpsMessageSchema>;

export const ClientCrdtMessageSchema = z.object({
  ch: z.literal('crdt'),
  blockId: z.string().min(1),
  // base64 of the raw Yjs update bytes
  delta: z.string().min(1),
});
export type ClientCrdtMessage = z.infer<typeof ClientCrdtMessageSchema>;

export const ClientAwarenessMessageSchema = z.object({
  ch: z.literal('awareness'),
  state: AwarenessStateSchema,
});
export type ClientAwarenessMessage = z.infer<typeof ClientAwarenessMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion('ch', [
  ClientOpsMessageSchema,
  ClientCrdtMessageSchema,
  ClientAwarenessMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface OpResult {
  blockId: string;
  newVersion: number;
  status: 'applied' | 'conflict';
  current?: unknown;
}

export interface ConflictInfo {
  blockId: string;
  reason?: string;
  current?: unknown;
}

export type AwarenessInfo = {
  userId: number;
  state: AwarenessState;
  color: string;
  name: string;
};

export type ServerMessage =
  | { ch: 'hello'; userId: number; lastStreamId: string }
  | { ch: 'ack'; clientSeq: number; results: OpResult[] }
  | { ch: 'nack'; clientSeq: number; conflicts: ConflictInfo[] }
  | { ch: 'remote_ops'; ops: BlockOperation[]; userId: number; streamId: string }
  | { ch: 'crdt'; blockId: string; delta: string; userId: number; streamId: string }
  | { ch: 'awareness'; users: AwarenessInfo[] }
  | { ch: 'replay_done'; streamId: string }
  | { ch: 'reload_required'; reason: 'stream_trimmed' };

// ---------------------------------------------------------------------------
// Bus envelope (inter-instance)
// ---------------------------------------------------------------------------

/** Envelope published to `doc:{docId}:bus`. */
export interface BusEnvelope {
  originInstance: string;
  frame: ServerMessage;
}

/**
 * Attempt to parse a client message from a raw WebSocket payload.
 *
 * Returns either { ok:true, msg } or { ok:false, error }.
 */
export function parseClientMessage(
  raw: string,
): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  const parsed = ClientMessageSchema.safeParse(obj);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, msg: parsed.data };
}
