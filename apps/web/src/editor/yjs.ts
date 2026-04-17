"use client";

import * as Y from "yjs";
import { b64ToBytes, bytesToB64 } from "@/lib/base64";
import type { InlineNode, Mark } from "@/lib/types";

// ========================================
// Per-block Y.Doc / Y.Text registry
//
// Design (docs/block-based-document.md §4.2 / §4.4):
//   - Each block owns one Y.Doc with a Y.Text named "root".
//   - On snapshot load, the Y.Text is bulk-initialized inside a transaction
//     whose origin === 'init'; observers skip this origin so no network
//     traffic is emitted.
//   - Local edits (no explicit origin) produce Y update bytes → base64 → WS.
//   - Remote crdt deltas are applied with origin === 'remote'; observers that
//     render to the DOM only react to 'remote' | 'init' updates.
// ========================================

type Origin = "init" | "local" | "remote";

export interface BlockDoc {
  doc: Y.Doc;
  text: Y.Text;
  /** Unsubscribers for the update handler. */
  destroy(): void;
}

export type UpdateEmitter = (payload: {
  blockId: string;
  deltaB64: string;
}) => void;

export type RemoteApplyListener = (blockId: string) => void;

export class YjsRegistry {
  private blocks = new Map<string, BlockDoc>();
  private observers = new Map<string, Set<RemoteApplyListener>>();
  private bufferedDeltas = new Map<string, Array<{ deltaB64: string; ts: number }>>();
  private readonly bufferTtlMs = 1_000;

  constructor(private readonly emit: UpdateEmitter) {}

  /** Ensure a Doc/Text exists for blockId, seeded with `initial` inlines. */
  ensure(blockId: string, initial: InlineNode[] = []): BlockDoc {
    const existing = this.blocks.get(blockId);
    if (existing) return existing;

    const doc = new Y.Doc();
    const text = doc.getText("root");

    // Bulk init — origin 'init' lets our update handler skip broadcasting.
    if (initial.length > 0) {
      doc.transact(() => {
        applyInlineNodes(text, initial);
      }, "init");
    }

    const handleUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === "init" || origin === "remote") return;
      this.emit({ blockId, deltaB64: bytesToB64(update) });
    };
    doc.on("update", handleUpdate);

    const entry: BlockDoc = {
      doc,
      text,
      destroy: () => {
        doc.off("update", handleUpdate);
        doc.destroy();
      },
    };
    this.blocks.set(blockId, entry);

    // Flush any buffered remote deltas that arrived before insert_block.
    const buf = this.bufferedDeltas.get(blockId);
    if (buf) {
      const now = Date.now();
      for (const { deltaB64, ts } of buf) {
        if (now - ts > this.bufferTtlMs) continue;
        this.applyRemoteDelta(blockId, deltaB64);
      }
      this.bufferedDeltas.delete(blockId);
    }

    return entry;
  }

  get(blockId: string): BlockDoc | undefined {
    return this.blocks.get(blockId);
  }

  /** Destroy a block's doc (e.g. delete_block). */
  destroy(blockId: string): void {
    const entry = this.blocks.get(blockId);
    if (entry) {
      entry.destroy();
      this.blocks.delete(blockId);
    }
    this.observers.delete(blockId);
    this.bufferedDeltas.delete(blockId);
  }

  /** Apply a remote base64 CRDT update. Buffers if the block isn't known yet. */
  applyRemoteDelta(blockId: string, deltaB64: string): void {
    const entry = this.blocks.get(blockId);
    if (!entry) {
      // Buffer with TTL, §4.2 race rule.
      const buf = this.bufferedDeltas.get(blockId) ?? [];
      buf.push({ deltaB64, ts: Date.now() });
      this.bufferedDeltas.set(blockId, buf);
      return;
    }
    Y.applyUpdate(entry.doc, b64ToBytes(deltaB64), "remote");
    const subs = this.observers.get(blockId);
    if (subs) for (const fn of subs) fn(blockId);
  }

  /** Subscribe to remote-applied change notifications for a blockId. */
  subscribe(blockId: string, fn: RemoteApplyListener): () => void {
    let set = this.observers.get(blockId);
    if (!set) {
      set = new Set();
      this.observers.set(blockId, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Drop all blocks (used on reload_required). */
  clear(): void {
    for (const entry of this.blocks.values()) entry.destroy();
    this.blocks.clear();
    this.observers.clear();
    this.bufferedDeltas.clear();
  }
}

// ========================================
// InlineNode[] <-> Y.Text (Quill-style delta)
// ========================================

/** Translate our Mark[] into a Y.Text format attribute object. */
function marksToFormat(marks: Mark[] | undefined): Record<string, unknown> | undefined {
  if (!marks || marks.length === 0) return undefined;
  const fmt: Record<string, unknown> = {};
  for (const mark of marks) {
    if (mark.type === "link" || mark.type === "comment") {
      fmt[mark.type] = mark.attrs ?? true;
    } else {
      fmt[mark.type] = true;
    }
  }
  return fmt;
}

/** Translate a Y.Text format attributes object back into Mark[]. */
function formatToMarks(
  format: Record<string, unknown> | undefined,
): Mark[] | undefined {
  if (!format) return undefined;
  const marks: Mark[] = [];
  for (const [key, val] of Object.entries(format)) {
    if (val === false || val == null) continue;
    if (key === "link" && typeof val === "object") {
      marks.push({ type: "link", attrs: val as Record<string, unknown> });
    } else if (key === "comment" && typeof val === "object") {
      marks.push({ type: "comment", attrs: val as Record<string, unknown> });
    } else if (
      key === "bold" ||
      key === "italic" ||
      key === "strike" ||
      key === "code"
    ) {
      marks.push({ type: key });
    }
  }
  return marks.length > 0 ? marks : undefined;
}

/** Bulk insert InlineNode[] into a (presumed empty) Y.Text. */
export function applyInlineNodes(text: Y.Text, nodes: InlineNode[]): void {
  let cursor = 0;
  for (const node of nodes) {
    if (node.type === "text") {
      const fmt = marksToFormat(node.marks);
      if (fmt) text.insert(cursor, node.text, fmt);
      else text.insert(cursor, node.text);
      cursor += node.text.length;
    } else if (node.type === "mention") {
      // Represent mentions as an embedded object; renderer handles the chip.
      text.insertEmbed(cursor, { mention: node.attrs });
      cursor += 1;
    }
  }
}

/** Snapshot a Y.Text as InlineNode[]. */
export function readInlineNodes(text: Y.Text): InlineNode[] {
  const delta = text.toDelta() as Array<{
    insert: string | Record<string, unknown>;
    attributes?: Record<string, unknown>;
  }>;
  const out: InlineNode[] = [];
  for (const op of delta) {
    if (typeof op.insert === "string") {
      const marks = formatToMarks(op.attributes);
      const node: InlineNode = { type: "text", text: op.insert };
      if (marks) node.marks = marks;
      out.push(node);
    } else if (op.insert && typeof op.insert === "object") {
      const m = op.insert as { mention?: { userId: number; label: string } };
      if (m.mention) {
        out.push({ type: "mention", attrs: m.mention });
      }
    }
  }
  return out;
}

/** Serialize current state → base64 update, used if you ever want to re-emit. */
export function snapshotB64(doc: Y.Doc): string {
  return bytesToB64(Y.encodeStateAsUpdate(doc));
}
