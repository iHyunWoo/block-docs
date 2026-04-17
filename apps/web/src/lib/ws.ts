"use client";

import { WS_URL } from "./env";
import type { ClientMessage, ServerMessage } from "./types";

// ----------------------------------------
// Helpers
// ----------------------------------------

const LS_KEY = (docId: number | string) => `block-docs:lastStreamId:${docId}`;

function readUidCookie(): number | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)uid=(\d+)/);
  return m ? parseInt(m[1]!, 10) : null;
}

type Listener = (msg: ServerMessage) => void;

// ----------------------------------------
// Connection state machine
// ----------------------------------------

export class WsClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private listeners = new Set<Listener>();
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<() => void>();
  private sendQueue: ClientMessage[] = [];
  public lastStreamId: string | null;

  constructor(private readonly docId: number | string) {
    this.lastStreamId = this.readLastStreamId();
  }

  // ------ public API ------

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Close any active socket and re-open immediately. Used by tests. */
  reconnect(): void {
    if (this.ws) {
      // Flag this as a non-user close so scheduleReconnect stays armed.
      this.closedByUser = false;
      this.ws.close();
      this.ws = null;
    }
    this.connect();
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Queue until the connection is open — crdt deltas MUST NOT be dropped
      // silently or we lose keystrokes that happened before the first open.
      // Ops (`ch:'ops'`) are still additionally backed by the pendingOps
      // queue in the store, so this is primarily about crdt continuity.
      this.sendQueue.push(msg);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private flushSendQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const pending = this.sendQueue;
    this.sendQueue = [];
    for (const msg of pending) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onOpen(fn: () => void): () => void {
    this.openListeners.add(fn);
    return () => this.openListeners.delete(fn);
  }

  onClose(fn: () => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ------ internal ------

  private open(): void {
    const uid = readUidCookie();
    const params = new URLSearchParams();
    if (this.lastStreamId) params.set("sinceStreamId", this.lastStreamId);
    if (uid != null) params.set("uid", String(uid));

    const url = `${WS_URL}/v3/docs/${this.docId}?${params.toString()}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.flushSendQueue();
      for (const fn of this.openListeners) fn();
    });

    ws.addEventListener("message", (ev) => {
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }

      // Heartbeat handling
      if (parsed.ch === "ping") {
        this.send({ ch: "pong" });
        return;
      }

      // Track lastStreamId on any frame that carries one.
      if ("streamId" in parsed && typeof parsed.streamId === "string") {
        this.lastStreamId = parsed.streamId;
        this.writeLastStreamId(parsed.streamId);
      }

      if (parsed.ch === "reload_required") {
        // Drop cursor; consumer must re-fetch via REST.
        this.lastStreamId = null;
        this.writeLastStreamId(null);
      }

      if (parsed.ch === "hello" && parsed.lastStreamId) {
        // Don't overwrite a known higher id; the hello is mostly informational.
        if (!this.lastStreamId) {
          this.lastStreamId = parsed.lastStreamId;
          this.writeLastStreamId(parsed.lastStreamId);
        }
      }

      for (const fn of this.listeners) fn(parsed);
    });

    const triggerClose = () => {
      for (const fn of this.closeListeners) fn();
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.addEventListener("close", triggerClose);
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
  }

  private scheduleReconnect(): void {
    const attempt = this.reconnectAttempt++;
    const backoff = Math.min(30_000, 1_000 * Math.pow(2, attempt));
    const jitter = Math.floor(Math.random() * 250);
    setTimeout(() => {
      if (this.closedByUser) return;
      this.open();
    }, backoff + jitter);
  }

  private readLastStreamId(): string | null {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(LS_KEY(this.docId));
  }

  private writeLastStreamId(v: string | null): void {
    if (typeof localStorage === "undefined") return;
    if (v == null) localStorage.removeItem(LS_KEY(this.docId));
    else localStorage.setItem(LS_KEY(this.docId), v);
  }
}
