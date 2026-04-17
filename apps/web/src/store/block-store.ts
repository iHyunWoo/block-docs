"use client";

import { create } from "zustand";
import { midpoint } from "@/lib/lexorank";
import type {
  AwarenessEntry,
  Block,
  BlockOperation,
  BlockType,
  InlineNode,
  OpResult,
} from "@/lib/types";
import { newBlockId } from "@/lib/uuid";

// ========================================
// State shape
// ========================================

export interface BlockStoreState {
  docId: number | string | null;
  blocks: Map<string, Block>;
  /** rootOrder / childrenMap are derived, maintained on write. */
  rootOrder: string[];
  childrenMap: Map<string, string[]>;
  lastStreamId: string | null;

  /** Optimistically queued ops waiting for ack/nack. */
  pendingOps: Array<{ clientSeq: number; ops: BlockOperation[] }>;
  clientSeqCounter: number;

  awareness: Map<number, AwarenessEntry>;
  focusedBlockId: string | null;

  // ------ actions ------
  loadSnapshot: (args: {
    docId: number | string;
    blocks: Block[];
    lastStreamId: string;
  }) => void;
  resetDoc: () => void;

  insertBlock: (
    type: BlockType,
    options?: {
      afterId?: string;
      parentId?: string | null;
      content?: { children?: InlineNode[]; attrs?: Record<string, unknown> };
      blockId?: string;
    },
  ) => string;
  deleteBlock: (blockId: string) => void;
  moveBlock: (
    blockId: string,
    to: { parentId: string | null; afterId?: string },
  ) => void;
  updateAttrs: (blockId: string, attrs: Record<string, unknown>) => void;
  updateContent: (blockId: string, content: Block["content"]) => void;

  applyRemoteOps: (ops: BlockOperation[], streamId?: string) => void;
  handleAck: (clientSeq: number, results: OpResult[]) => void;
  handleNack: (
    clientSeq: number,
    conflicts: Array<{ blockId: string; reason: string; current?: Block }>,
  ) => void;

  setAwareness: (users: AwarenessEntry[]) => void;
  setFocusedBlockId: (blockId: string | null) => void;
  setLastStreamId: (id: string | null) => void;

  /** Drain the pendingOps queue (called by WS layer after (re)connect). */
  drainPending: (
    send: (frame: { ch: "ops"; clientSeq: number; ops: BlockOperation[] }) => void,
  ) => void;

  /** Produce and register an operation from the editor side. */
  enqueueOps: (ops: BlockOperation[]) => number;
}

// ========================================
// Helpers
// ========================================

function sortByPosition(blocks: Block[], ids: string[]): string[] {
  return ids
    .slice()
    .sort((a, b) => {
      const pa = blocks.find((x) => x.blockId === a)?.position ?? "";
      const pb = blocks.find((x) => x.blockId === b)?.position ?? "";
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
}

function rebuildIndex(blocks: Map<string, Block>): {
  rootOrder: string[];
  childrenMap: Map<string, string[]>;
} {
  const rootOrder: string[] = [];
  const childrenMap = new Map<string, string[]>();
  const all = Array.from(blocks.values());
  for (const b of all) {
    if (b.parentId == null) rootOrder.push(b.blockId);
    else {
      const arr = childrenMap.get(b.parentId) ?? [];
      arr.push(b.blockId);
      childrenMap.set(b.parentId, arr);
    }
  }
  const byPos = (a: string, b: string) => {
    const pa = blocks.get(a)?.position ?? "";
    const pb = blocks.get(b)?.position ?? "";
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  };
  rootOrder.sort(byPos);
  for (const [k, v] of childrenMap) {
    v.sort(byPos);
    childrenMap.set(k, v);
  }
  return { rootOrder, childrenMap };
}

/**
 * Compute a LexoRank string that places a new block after `afterId` (or at the
 * start if afterId is null) among siblings with `parentId`.
 */
function computePosition(
  blocks: Map<string, Block>,
  order: string[],
  parentId: string | null,
  afterId: string | null | undefined,
): string {
  const siblings = order
    .map((id) => blocks.get(id))
    .filter((b): b is Block => !!b && b.parentId === parentId);

  let prevPos: string | null = null;
  let nextPos: string | null = null;

  if (afterId == null) {
    // Insert at start.
    nextPos = siblings[0]?.position ?? null;
  } else {
    const idx = siblings.findIndex((b) => b.blockId === afterId);
    if (idx >= 0) {
      prevPos = siblings[idx]!.position;
      nextPos = siblings[idx + 1]?.position ?? null;
    } else {
      // Fallback: append to end.
      prevPos = siblings[siblings.length - 1]?.position ?? null;
    }
  }

  return midpoint(prevPos, nextPos);
}

/** Get a flat, tree-ordered listing (parents before children, DFS). */
export function flattenBlocks(
  rootOrder: string[],
  childrenMap: Map<string, string[]>,
  blocks: Map<string, Block>,
): Block[] {
  const out: Block[] = [];
  const walk = (id: string) => {
    const b = blocks.get(id);
    if (!b) return;
    out.push(b);
    const kids = childrenMap.get(id);
    if (kids) for (const k of kids) walk(k);
  };
  for (const id of rootOrder) walk(id);
  return out;
}

// ========================================
// Store
// ========================================

export const useBlockStore = create<BlockStoreState>((set, get) => ({
  docId: null,
  blocks: new Map(),
  rootOrder: [],
  childrenMap: new Map(),
  lastStreamId: null,
  pendingOps: [],
  clientSeqCounter: 1,
  awareness: new Map(),
  focusedBlockId: null,

  loadSnapshot: ({ docId, blocks, lastStreamId }) => {
    const map = new Map<string, Block>();
    for (const b of blocks) map.set(b.blockId, b);
    const idx = rebuildIndex(map);
    set({
      docId,
      blocks: map,
      rootOrder: idx.rootOrder,
      childrenMap: idx.childrenMap,
      lastStreamId,
      pendingOps: [],
      clientSeqCounter: 1,
    });
  },

  resetDoc: () => {
    set({
      blocks: new Map(),
      rootOrder: [],
      childrenMap: new Map(),
      lastStreamId: null,
      pendingOps: [],
      clientSeqCounter: 1,
      awareness: new Map(),
      focusedBlockId: null,
    });
  },

  insertBlock: (type, opts = {}) => {
    const blockId = opts.blockId ?? newBlockId();
    const parentId = opts.parentId ?? null;
    const { blocks, rootOrder, childrenMap } = get();

    // Use union of all ids (rootOrder + every childrenMap value).
    const allOrder = [
      ...rootOrder,
      ...Array.from(childrenMap.values()).flat(),
    ];
    const position = computePosition(blocks, allOrder, parentId, opts.afterId);

    const block: Block = {
      blockId,
      parentId,
      position,
      depth:
        parentId == null ? 0 : (blocks.get(parentId)?.depth ?? 0) + 1,
      type,
      content: opts.content ?? {},
      version: 1,
    };
    const next = new Map(blocks);
    next.set(blockId, block);
    const idx = rebuildIndex(next);
    set({ blocks: next, rootOrder: idx.rootOrder, childrenMap: idx.childrenMap });

    // Enqueue op.
    get().enqueueOps([
      {
        op: "insert_block",
        blockId,
        payload: {
          type,
          parentId,
          afterId: opts.afterId ?? null,
          content: block.content,
          position,
        },
      },
    ]);

    return blockId;
  },

  deleteBlock: (blockId) => {
    const { blocks } = get();
    const existing = blocks.get(blockId);
    if (!existing) return;
    const next = new Map(blocks);
    next.delete(blockId);
    // Orphan children: promote to parent (simpler than cascading delete for MVP).
    for (const [id, b] of next) {
      if (b.parentId === blockId) {
        next.set(id, { ...b, parentId: existing.parentId });
      }
    }
    const idx = rebuildIndex(next);
    set({ blocks: next, rootOrder: idx.rootOrder, childrenMap: idx.childrenMap });

    get().enqueueOps([
      {
        op: "delete_block",
        blockId,
        payload: {},
        version: existing.version,
      },
    ]);
  },

  moveBlock: (blockId, to) => {
    const { blocks, rootOrder, childrenMap } = get();
    const existing = blocks.get(blockId);
    if (!existing) return;
    const allOrder = [
      ...rootOrder,
      ...Array.from(childrenMap.values()).flat(),
    ];
    const position = computePosition(blocks, allOrder, to.parentId, to.afterId);
    const next = new Map(blocks);
    next.set(blockId, {
      ...existing,
      parentId: to.parentId,
      position,
      depth:
        to.parentId == null ? 0 : (blocks.get(to.parentId)?.depth ?? 0) + 1,
    });
    const idx = rebuildIndex(next);
    set({ blocks: next, rootOrder: idx.rootOrder, childrenMap: idx.childrenMap });

    get().enqueueOps([
      {
        op: "move_block",
        blockId,
        payload: {
          parentId: to.parentId,
          afterId: to.afterId ?? null,
          position,
        },
        version: existing.version,
      },
    ]);
  },

  updateAttrs: (blockId, attrs) => {
    const { blocks } = get();
    const b = blocks.get(blockId);
    if (!b) return;
    const next = new Map(blocks);
    next.set(blockId, {
      ...b,
      content: { ...b.content, attrs: { ...(b.content.attrs ?? {}), ...attrs } },
    });
    set({ blocks: next });
    get().enqueueOps([
      { op: "update_attrs", blockId, payload: { attrs }, version: b.version },
    ]);
  },

  updateContent: (blockId, content) => {
    const { blocks } = get();
    const b = blocks.get(blockId);
    if (!b) return;
    const next = new Map(blocks);
    next.set(blockId, { ...b, content });
    set({ blocks: next });
    // Intentionally no op enqueue here — text changes are delivered via Yjs
    // CRDT deltas over the 'crdt' channel, not via update_content ops.
  },

  applyRemoteOps: (ops, streamId) => {
    const { blocks } = get();
    const next = new Map(blocks);
    for (const op of ops) {
      switch (op.op) {
        case "insert_block": {
          const payload = op.payload as {
            type: BlockType;
            parentId: string | null;
            position: string;
            content?: Block["content"];
          };
          next.set(op.blockId, {
            blockId: op.blockId,
            parentId: payload.parentId ?? null,
            position: payload.position,
            depth:
              payload.parentId == null
                ? 0
                : (next.get(payload.parentId)?.depth ?? 0) + 1,
            type: payload.type,
            content: payload.content ?? {},
            version: 1,
          });
          break;
        }
        case "delete_block": {
          next.delete(op.blockId);
          for (const [id, b] of next) {
            if (b.parentId === op.blockId) {
              const existing = next.get(op.blockId);
              next.set(id, { ...b, parentId: existing?.parentId ?? null });
            }
          }
          break;
        }
        case "move_block": {
          const b = next.get(op.blockId);
          if (!b) break;
          const p = op.payload as {
            parentId: string | null;
            position: string;
          };
          next.set(op.blockId, {
            ...b,
            parentId: p.parentId ?? null,
            position: p.position,
          });
          break;
        }
        case "update_attrs": {
          const b = next.get(op.blockId);
          if (!b) break;
          const p = op.payload as { attrs: Record<string, unknown> };
          next.set(op.blockId, {
            ...b,
            content: {
              ...b.content,
              attrs: { ...(b.content.attrs ?? {}), ...p.attrs },
            },
            version: (op.version ?? b.version) + 1,
          });
          break;
        }
        case "update_content": {
          // Text updates are normally on crdt channel, but accept full snapshots too.
          const b = next.get(op.blockId);
          if (!b) break;
          const p = op.payload as { content: Block["content"] };
          next.set(op.blockId, {
            ...b,
            content: p.content,
            version: (op.version ?? b.version) + 1,
          });
          break;
        }
      }
    }
    const idx = rebuildIndex(next);
    set({
      blocks: next,
      rootOrder: idx.rootOrder,
      childrenMap: idx.childrenMap,
      lastStreamId: streamId ?? get().lastStreamId,
    });
  },

  handleAck: (clientSeq, results) => {
    const { pendingOps, blocks } = get();
    const next = new Map(blocks);
    for (const r of results) {
      const b = next.get(r.blockId);
      if (b) next.set(r.blockId, { ...b, version: r.newVersion });
    }
    set({
      pendingOps: pendingOps.filter((p) => p.clientSeq !== clientSeq),
      blocks: next,
    });
  },

  handleNack: (clientSeq, conflicts) => {
    const { pendingOps, blocks } = get();
    const next = new Map(blocks);
    for (const c of conflicts) {
      if (c.current) next.set(c.blockId, c.current);
      else next.delete(c.blockId);
    }
    const idx = rebuildIndex(next);
    set({
      pendingOps: pendingOps.filter((p) => p.clientSeq !== clientSeq),
      blocks: next,
      rootOrder: idx.rootOrder,
      childrenMap: idx.childrenMap,
    });
  },

  setAwareness: (users) => {
    const map = new Map<number, AwarenessEntry>();
    for (const u of users) map.set(u.userId, u);
    set({ awareness: map });
  },

  setFocusedBlockId: (blockId) => set({ focusedBlockId: blockId }),
  setLastStreamId: (id) => set({ lastStreamId: id }),

  drainPending: (send) => {
    for (const p of get().pendingOps) {
      send({ ch: "ops", clientSeq: p.clientSeq, ops: p.ops });
    }
  },

  enqueueOps: (ops) => {
    const clientSeq = get().clientSeqCounter;
    set({
      clientSeqCounter: clientSeq + 1,
      pendingOps: [...get().pendingOps, { clientSeq, ops }],
    });
    return clientSeq;
  },
}));
