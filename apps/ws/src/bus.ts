/**
 * Bus subscriber — wires the shared ioredis subscriber's "message" event to
 * the RoomRegistry, filtering out self-origin frames (we already broadcasted
 * those locally in the crdt handler).
 *
 * The api server also publishes to the bus after handling ops. Its envelope
 * either omits `originInstance` or sets it to "api" — in both cases we
 * accept the frame (since api is not a peer ws instance).
 */
import type { Logger } from 'pino';
import type { RedisLike } from './types.js';
import type { RoomRegistry } from './room.js';
import type { BusEnvelope } from './protocol.js';

const DOC_CHANNEL_RE = /^doc:(\d+):bus$/;

export interface BusWiringOptions {
  instanceId: string;
  subscriber: RedisLike;
  rooms: RoomRegistry;
  logger: Logger;
}

/**
 * Register the message listener. Call once at boot, after the subscriber is
 * connected.
 */
export function wireBusSubscriber(opts: BusWiringOptions): void {
  const { instanceId, subscriber, rooms, logger } = opts;

  subscriber.on('message', (channel: string, message: string) => {
    const match = DOC_CHANNEL_RE.exec(channel);
    if (!match) return; // not one of ours
    const docIdStr = match[1];
    if (!docIdStr) return;
    const docId = Number(docIdStr);
    if (!Number.isFinite(docId)) return;

    let env: BusEnvelope;
    try {
      env = JSON.parse(message) as BusEnvelope;
    } catch (err) {
      logger.warn({ channel, err: (err as Error).message }, 'bus_message_parse_failed');
      return;
    }

    // Skip frames we ourselves originated — they've already been broadcast
    // locally by the crdt handler. The api's frames are always delivered.
    if (env.originInstance && env.originInstance === instanceId) {
      return;
    }

    if (!env.frame || typeof env.frame !== 'object') {
      logger.warn({ channel }, 'bus_envelope_missing_frame');
      return;
    }

    rooms.broadcastLocal(docId, env.frame);
  });
}
