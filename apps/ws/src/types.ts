/**
 * Shared non-wire types: per-socket metadata and redis interface shape.
 */
import type { WebSocket } from 'ws';

/** Metadata attached to each connected WebSocket. */
export interface SocketContext {
  docId: number;
  userId: number;
  instanceId: string;
  sinceStreamId: string | null;
  /** Heartbeat: set true on pong, reset to false on ping. */
  isAlive: boolean;
  /** Latest awareness state — cached only for re-broadcast on room join. */
  awareness?: unknown;
}

export type ContextedSocket = WebSocket & { ctx: SocketContext };

/**
 * Subset of ioredis we actually consume. Tests inject a fake that satisfies
 * this shape so we don't need a real Redis in unit tests.
 */
export interface RedisLike {
  xadd(key: string, ...args: (string | number | Buffer)[]): Promise<string | null>;
  xrange(
    key: string,
    start: string,
    end: string,
    ...args: string[]
  ): Promise<Array<[string, string[]]>>;
  xinfo(subcommand: 'STREAM', key: string): Promise<unknown>;
  publish(channel: string, payload: string): Promise<number>;
  subscribe(...channels: string[]): Promise<number>;
  unsubscribe(...channels: string[]): Promise<number>;
  quit(): Promise<'OK'>;
  on(event: 'message', listener: (channel: string, message: string) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}
