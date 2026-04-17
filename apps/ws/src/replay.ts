/**
 * Replay on connect.
 *
 * When a client reconnects with ?sinceStreamId=<id>, we catch them up by
 * walking the Redis Stream from that cursor forward. If their cursor is
 * older than the stream's first entry (retention boundary), we tell them
 * to reload from REST and close the socket with code 4001.
 */
import type { Logger } from 'pino';
import type { WebSocket } from 'ws';
import type { RedisLike } from './types.js';
import type { BlockOperation, ServerMessage } from './protocol.js';

export interface ReplayOptions {
  redis: RedisLike;
  docId: number;
  sinceStreamId: string;
  ws: WebSocket;
  logger: Logger;
}

/** Close code used when we tell the client to full-reload. */
export const RELOAD_REQUIRED_CLOSE_CODE = 4001;

/**
 * Parse a Redis Stream entry's flat [k1, v1, k2, v2, ...] array into a map.
 */
function fieldsToMap(fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const k = fields[i];
    const v = fields[i + 1];
    if (typeof k === 'string' && typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Compare two Redis stream ids of the form `<ms>-<seq>`. Returns -1, 0, or 1.
 */
export function compareStreamIds(a: string, b: string): number {
  const [aMsStr = '0', aSeqStr = '0'] = a.split('-');
  const [bMsStr = '0', bSeqStr = '0'] = b.split('-');
  const aMs = BigInt(aMsStr);
  const bMs = BigInt(bMsStr);
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  const aSeq = BigInt(aSeqStr);
  const bSeq = BigInt(bSeqStr);
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  return 0;
}

/**
 * XINFO STREAM response is an array of alternating keys/values. Extract a
 * single field by name.
 */
function readXInfoField(info: unknown, field: string): unknown {
  if (!Array.isArray(info)) return undefined;
  for (let i = 0; i + 1 < info.length; i += 2) {
    if (info[i] === field) return info[i + 1];
  }
  return undefined;
}

/**
 * Run replay. Returns the last streamId we sent (or the sinceStreamId if
 * nothing was sent). Throws if the socket is already closed mid-way.
 */
export async function runReplay(opts: ReplayOptions): Promise<{
  trimmed: boolean;
  lastStreamId: string;
  framesSent: number;
}> {
  const { redis, docId, sinceStreamId, ws, logger } = opts;
  const streamKey = `doc:${docId}:stream`;

  // Detect retention-trim: if the stream's first entry is after our cursor,
  // we've lost data. Client must fallback to REST load.
  //
  // Exception: `0-0` is the sentinel returned by /blocks when a doc had no
  // stream entries at snapshot time. A later-populated stream is NOT a trim
  // relative to that cursor — replay everything.
  if (sinceStreamId !== '0-0') {
    try {
      const info = await redis.xinfo('STREAM', streamKey);
      const firstEntry = readXInfoField(info, 'first-entry');
      if (Array.isArray(firstEntry)) {
        const firstId = firstEntry[0];
        if (typeof firstId === 'string' && compareStreamIds(firstId, sinceStreamId) > 0) {
          sendFrame(ws, { ch: 'reload_required', reason: 'stream_trimmed' });
          ws.close(RELOAD_REQUIRED_CLOSE_CODE, 'stream_trimmed');
          return { trimmed: true, lastStreamId: sinceStreamId, framesSent: 0 };
        }
      }
    } catch (err) {
      // XINFO fails on a missing stream — that just means there's nothing to
      // replay. Downgrade and continue.
      logger.debug({ docId, err: (err as Error).message }, 'xinfo_failed_continuing_replay');
    }
  }

  // Exclusive lower bound: `(sinceStreamId`
  const entries = await redis.xrange(streamKey, `(${sinceStreamId}`, '+');
  let lastStreamId = sinceStreamId;
  let framesSent = 0;

  for (const entry of entries) {
    const [streamId, fields] = entry;
    const m = fieldsToMap(fields);
    const userIdNum = Number(m.userId ?? '0');

    if (m.kind === 'crdt') {
      const blockId = m.blockId;
      const delta = m.delta;
      if (!blockId || !delta) continue;
      sendFrame(ws, {
        ch: 'crdt',
        blockId,
        delta,
        userId: userIdNum,
        streamId,
      });
      framesSent++;
    } else if (m.kind === 'ops') {
      try {
        const ops = JSON.parse(m.ops ?? '[]') as BlockOperation[];
        sendFrame(ws, {
          ch: 'remote_ops',
          ops,
          userId: userIdNum,
          streamId,
        });
        framesSent++;
      } catch (err) {
        logger.warn({ docId, streamId, err: (err as Error).message }, 'replay_ops_parse_failed');
      }
    } else {
      // unknown kind — ignore but keep advancing cursor
      logger.warn({ docId, streamId, kind: m.kind }, 'replay_unknown_kind');
    }

    lastStreamId = streamId;
  }

  sendFrame(ws, { ch: 'replay_done', streamId: lastStreamId });
  return { trimmed: false, lastStreamId, framesSent };
}

function sendFrame(ws: WebSocket, frame: ServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(frame));
}
