/**
 * awareness channel handler.
 *
 * Awareness is ephemeral — never logged to the stream and never pushed to the
 * bus. We simply relay to the local Room, skipping the sender. The server
 * shape mirrors the contract in docs/protocol.md:
 *
 *   { ch: 'awareness', users: [{ userId, state, color, name }] }
 *
 * For now the ws server doesn't know user's `color` or `name` (those come
 * from api). We forward a minimal single-user entry and leave color/name
 * empty; the client UI falls back to stale data keyed by userId. Richer
 * awareness metadata can join later without changing the wire contract.
 */
import type { RoomRegistry } from '../room.js';
import type { ContextedSocket } from '../types.js';
import type { ClientAwarenessMessage, ServerMessage } from '../protocol.js';

export interface AwarenessHandlerDeps {
  rooms: RoomRegistry;
}

export function handleAwareness(
  deps: AwarenessHandlerDeps,
  ws: ContextedSocket,
  msg: ClientAwarenessMessage,
): void {
  const { rooms } = deps;
  const { docId, userId } = ws.ctx;

  // Cache the latest awareness state for potential reuse (e.g. sending a
  // snapshot on a new peer's join). Kept minimal per constraints.
  ws.ctx.awareness = msg.state;

  const frame: ServerMessage = {
    ch: 'awareness',
    users: [
      {
        userId,
        state: msg.state,
        color: '',
        name: '',
      },
    ],
  };
  rooms.broadcastLocal(docId, frame, ws);
}
