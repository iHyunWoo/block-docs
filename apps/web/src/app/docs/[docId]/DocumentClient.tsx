"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockEditor } from "@/components/editor/BlockEditor";
import { Presence } from "@/components/Presence";
import { fetchBlocks, fetchMe } from "@/lib/api";
import { INSTANCE_LABEL } from "@/lib/env";
import type { ServerMessage, User } from "@/lib/types";
import { useWs } from "@/lib/useWs";
import { useBlockStore } from "@/store/block-store";
import { YjsRegistry } from "@/editor/yjs";

interface Props {
  docId: string;
}

export function DocumentClient({ docId }: Props) {
  const loadSnapshot = useBlockStore((s) => s.loadSnapshot);
  const resetDoc = useBlockStore((s) => s.resetDoc);
  const applyRemoteOps = useBlockStore((s) => s.applyRemoteOps);
  const handleAck = useBlockStore((s) => s.handleAck);
  const handleNack = useBlockStore((s) => s.handleNack);
  const setAwareness = useBlockStore((s) => s.setAwareness);
  const setLastStreamId = useBlockStore((s) => s.setLastStreamId);
  const pendingOps = useBlockStore((s) => s.pendingOps);

  const ws = useWs(docId);
  const [me, setMe] = useState<User | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [requestFocusBlockId, setRequestFocusBlockId] = useState<string | null>(null);

  // Expose ws client to tests (reconnect.spec.ts drives close() / reconnect()).
  useEffect(() => {
    if (typeof window === "undefined" || !ws) return;
    (window as unknown as { __blockDocsWs?: unknown }).__blockDocsWs = ws;
    return () => {
      delete (window as unknown as { __blockDocsWs?: unknown }).__blockDocsWs;
    };
  }, [ws]);

  // ---- Yjs registry (scoped to this doc) ----
  const yjs = useMemo(() => {
    return new YjsRegistry(({ blockId, deltaB64 }) => {
      ws?.send({ ch: "crdt", blockId, delta: deltaB64 });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, docId]);

  useEffect(() => {
    return () => {
      yjs.clear();
    };
  }, [yjs]);

  // ---- Initial fetch ----
  const lastLoadedRef = useRef<string | null>(null);
  const loadInitial = useCallback(async () => {
    setStatus("loading");
    try {
      const [snap, user] = await Promise.all([
        fetchBlocks(docId),
        fetchMe().catch(() => null),
      ]);
      // Reset state on (re)load.
      yjs.clear();
      resetDoc();
      loadSnapshot({
        docId: snap.docId,
        blocks: snap.blocks,
        lastStreamId: snap.lastStreamId,
      });
      // Prime Y.Texts for all blocks so incoming crdt deltas apply cleanly.
      for (const b of snap.blocks) {
        yjs.ensure(b.blockId, b.content.children ?? []);
      }
      if (user) setMe(user);
      lastLoadedRef.current = snap.lastStreamId;
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [docId, loadSnapshot, resetDoc, yjs]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  // ---- WS wiring ----
  useEffect(() => {
    if (!ws) return;
    const off = ws.onMessage((msg: ServerMessage) => {
      switch (msg.ch) {
        case "remote_ops": {
          applyRemoteOps(msg.ops, msg.streamId);
          // Ensure Y.Texts exist for newly inserted blocks BEFORE any
          // pending crdt frames for them (§4.2).
          for (const op of msg.ops) {
            if (op.op === "insert_block") {
              const p = op.payload as { content?: { children?: unknown[] } };
              const children = Array.isArray(p.content?.children)
                ? (p.content!.children as import("@/lib/types").InlineNode[])
                : [];
              yjs.ensure(op.blockId, children);
            }
            if (op.op === "delete_block") {
              yjs.destroy(op.blockId);
            }
          }
          break;
        }
        case "crdt": {
          yjs.applyRemoteDelta(msg.blockId, msg.delta);
          setLastStreamId(msg.streamId);
          break;
        }
        case "ack":
          handleAck(msg.clientSeq, msg.results);
          break;
        case "nack":
          handleNack(msg.clientSeq, msg.conflicts);
          break;
        case "awareness":
          setAwareness(msg.users);
          break;
        case "replay_done":
          setLastStreamId(msg.streamId);
          break;
        case "reload_required":
          // Drop everything and re-fetch.
          yjs.clear();
          resetDoc();
          loadInitial();
          break;
        case "hello":
        case "ping":
        case "pong":
          break;
      }
    });
    return off;
  }, [ws, applyRemoteOps, handleAck, handleNack, setAwareness, setLastStreamId, yjs, resetDoc, loadInitial]);

  // ---- Send pending ops when WS opens ----
  useEffect(() => {
    if (!ws) return;
    const off = ws.onOpen(() => {
      // Drain pendingOps from the store.
      useBlockStore.getState().drainPending((frame) => ws.send(frame));
    });
    return off;
  }, [ws]);

  // ---- Flush new pending ops as they come in ----
  useEffect(() => {
    if (!ws || !ws.isOpen()) return;
    if (pendingOps.length === 0) return;
    const last = pendingOps[pendingOps.length - 1]!;
    ws.send({ ch: "ops", clientSeq: last.clientSeq, ops: last.ops });
  }, [pendingOps, ws]);

  return (
    <div className="doc-page">
      <header className="app-header">
        <div className="app-header-left">
          <strong>Block Docs</strong>
          <span className="instance-label" title="Instance label (from NEXT_PUBLIC_INSTANCE_LABEL)">
            {INSTANCE_LABEL}
          </span>
          {me ? (
            <span className="user-chip">
              {me.name} <small>(uid {me.id})</small>
            </span>
          ) : (
            <span className="user-chip">
              Not signed in —{" "}
              <a href="/login?uid=1">uid=1</a> | <a href="/login?uid=2">uid=2</a>
            </span>
          )}
        </div>
        <Presence />
      </header>
      <div className="doc-container">
        {status === "loading" ? (
          <div className="doc-loading">Loading document…</div>
        ) : status === "error" ? (
          <div className="doc-error">Failed to load: {error}</div>
        ) : (
          <BlockEditor
            yjs={yjs}
            requestFocusBlockId={requestFocusBlockId}
            clearRequestFocus={() => setRequestFocusBlockId(null)}
          />
        )}
      </div>
    </div>
  );
}
