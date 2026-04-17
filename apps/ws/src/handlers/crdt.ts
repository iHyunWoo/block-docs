/**
 * crdt channel handler.
 *
 * Flow (per docs/block-based-document.md §4.4.2):
 *   1. Append to doc:{docId}:stream (MAXLEN ~ STREAM_MAXLEN).
 *   2. Broadcast {ch:'crdt', blockId, delta, userId, streamId} to local Room,
 *      skipping the sender.
 *   3. Publish the same frame to doc:{docId}:bus so other instances can
 *      fan out to their own local Rooms.
 */
import type { Logger } from 'pino';
import type { RedisLike, ContextedSocket } from '../types.js';
import type { RoomRegistry } from '../room.js';
import type { BusEnvelope, ClientCrdtMessage, ServerMessage } from '../protocol.js';

export interface CrdtHandlerDeps {
  redis: RedisLike;
  rooms: RoomRegistry;
  instanceId: string;
  streamMaxLen: number;
  logger: Logger;
}

/**
 * Verify a base64 string decodes to a non-empty buffer. We don't inspect the
 * Yjs wire format — the server intentionally doesn't understand deltas.
 */
function isValidBase64NonEmpty(s: string): boolean {
  if (!s) return false;
  try {
    const buf = Buffer.from(s, 'base64');
    if (buf.length === 0) return false;
    // Round-trip check to catch obviously malformed padding.
    return buf.toString('base64').replace(/=+$/, '') === s.replace(/=+$/, '');
  } catch {
    return false;
  }
}

export async function handleCrdt(
  deps: CrdtHandlerDeps,
  ws: ContextedSocket,
  msg: ClientCrdtMessage,
): Promise<void> {
  const { redis, rooms, instanceId, streamMaxLen, logger } = deps;
  const { docId, userId } = ws.ctx;

  if (!isValidBase64NonEmpty(msg.delta)) {
    logger.warn({ docId, userId, blockId: msg.blockId }, 'crdt_invalid_delta');
    return;
  }

  let streamId: string | null;
  try {
    // XADD doc:{docId}:stream MAXLEN ~ <n> * kind crdt blockId <id> delta <bytes> userId <int>
    streamId = await redis.xadd(
      `doc:${docId}:stream`,
      'MAXLEN',
      '~',
      String(streamMaxLen),
      '*',
      'kind',
      'crdt',
      'blockId',
      msg.blockId,
      'delta',
      msg.delta,
      'userId',
      String(userId),
    );
  } catch (err) {
    logger.error(
      { docId, userId, blockId: msg.blockId, err: (err as Error).message },
      'crdt_xadd_failed',
    );
    return;
  }

  if (!streamId) {
    logger.error({ docId, userId }, 'crdt_xadd_returned_null');
    return;
  }

  const frame: ServerMessage = {
    ch: 'crdt',
    blockId: msg.blockId,
    delta: msg.delta,
    userId,
    streamId,
  };

  // Local fan-out first (skip sender).
  rooms.broadcastLocal(docId, frame, ws);

  // Then publish so peer instances can pick it up. They'll skip when
  // originInstance === their own instanceId, and we'll skip ours on the
  // echo since bus.ts filters by originInstance.
  const envelope: BusEnvelope = { originInstance: instanceId, frame };
  try {
    await redis.publish(`doc:${docId}:bus`, JSON.stringify(envelope));
  } catch (err) {
    logger.error({ docId, err: (err as Error).message }, 'crdt_bus_publish_failed');
  }
}
