/**
 * Rooms — per-docId Set<WebSocket> bookkeeping plus Redis pub/sub channel
 * lifecycle (subscribe on first join, unsubscribe on last leave).
 *
 * The Redis subscriber is SHARED across all rooms on this instance. ioredis
 * allows a subscriber connection to hold a dynamic set of channels; we just
 * add/remove from it.
 */
import type { WebSocket } from 'ws';
import type { RedisLike } from './types.js';
import type { ServerMessage } from './protocol.js';

export interface RoomRegistryOptions {
  /** Shared ioredis client used purely for SUBSCRIBE/UNSUBSCRIBE. */
  subscriber: RedisLike;
  /** Channel builder — exposed for testability. */
  channelFor?: (docId: number) => string;
  /** Called with (docId, WebSocket[]) before SUBSCRIBE, useful for metrics. */
  onFirstJoin?: (docId: number) => void;
  onLastLeave?: (docId: number) => void;
}

export class RoomRegistry {
  private readonly rooms = new Map<number, Set<WebSocket>>();
  private readonly subscriber: RedisLike;
  private readonly channelFor: (docId: number) => string;
  private readonly onFirstJoin?: (docId: number) => void;
  private readonly onLastLeave?: (docId: number) => void;

  constructor(opts: RoomRegistryOptions) {
    this.subscriber = opts.subscriber;
    this.channelFor = opts.channelFor ?? ((id) => `doc:${id}:bus`);
    this.onFirstJoin = opts.onFirstJoin;
    this.onLastLeave = opts.onLastLeave;
  }

  /** Testing / introspection. */
  size(docId: number): number {
    return this.rooms.get(docId)?.size ?? 0;
  }

  /** Testing / introspection. */
  docs(): number[] {
    return [...this.rooms.keys()];
  }

  /**
   * Add the socket to the doc's Room. If this is the first socket for that
   * doc on this instance, subscribe to the Redis bus channel for it.
   */
  async join(docId: number, ws: WebSocket): Promise<void> {
    let set = this.rooms.get(docId);
    if (!set) {
      set = new Set();
      this.rooms.set(docId, set);
    }
    const wasEmpty = set.size === 0;
    set.add(ws);

    if (wasEmpty) {
      // Subscribe BEFORE broadcasting anything — ordering of the SUBSCRIBE
      // reply vs. a PUBLISH from another instance is handled by Redis itself.
      await this.subscriber.subscribe(this.channelFor(docId));
      this.onFirstJoin?.(docId);
    }
  }

  /**
   * Remove the socket from the Room. If no sockets remain on this instance
   * for that doc, unsubscribe from the bus channel.
   */
  async leave(docId: number, ws: WebSocket): Promise<void> {
    const set = this.rooms.get(docId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      this.rooms.delete(docId);
      try {
        await this.subscriber.unsubscribe(this.channelFor(docId));
      } catch {
        // Best-effort: if subscriber died, the process will recycle anyway.
      }
      this.onLastLeave?.(docId);
    }
  }

  /**
   * Send a frame to every socket in this Room on this instance, optionally
   * skipping the sender.
   *
   * We serialize once — same JSON goes to every peer. Socket.send is called
   * on OPEN sockets only (guards against races with close events).
   */
  broadcastLocal(docId: number, frame: ServerMessage, exceptSocket?: WebSocket): void {
    const set = this.rooms.get(docId);
    if (!set || set.size === 0) return;
    const payload = JSON.stringify(frame);
    for (const ws of set) {
      if (ws === exceptSocket) continue;
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(payload);
    }
  }

  /** Returns a read-only snapshot of sockets for a doc — handy for shutdown. */
  members(docId: number): readonly WebSocket[] {
    const set = this.rooms.get(docId);
    return set ? [...set] : [];
  }

  allSockets(): WebSocket[] {
    const out: WebSocket[] = [];
    for (const set of this.rooms.values()) {
      for (const ws of set) out.push(ws);
    }
    return out;
  }
}
