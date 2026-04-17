import { describe, it, expect } from 'vitest';
import { RoomRegistry } from '../room.js';
import { FakeRedisHub } from './fakes/fakeRedis.js';
import type { WebSocket } from 'ws';

function makeFakeSocket(): WebSocket {
  const sent: unknown[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send(p: string) {
      sent.push(p);
    },
    close() {
      this.readyState = 3;
    },
    __sent: sent,
  } as unknown as WebSocket;
  return ws;
}

describe('RoomRegistry', () => {
  it('subscribes on first join, unsubscribes on last leave', async () => {
    const hub = new FakeRedisHub();
    const sub = hub.subscriber();
    const rooms = new RoomRegistry({ subscriber: sub });
    const a = makeFakeSocket();
    const b = makeFakeSocket();

    await rooms.join(1, a);
    expect([...sub.subscribedChannels.keys()]).toEqual(['doc:1:bus']);
    await rooms.join(1, b);
    // Still one channel — second join must not re-subscribe.
    expect([...sub.subscribedChannels.keys()]).toEqual(['doc:1:bus']);

    await rooms.leave(1, a);
    expect([...sub.subscribedChannels.keys()]).toEqual(['doc:1:bus']);
    await rooms.leave(1, b);
    expect([...sub.subscribedChannels.keys()]).toEqual([]);
  });

  it('broadcasts to room members except sender', () => {
    const hub = new FakeRedisHub();
    const rooms = new RoomRegistry({ subscriber: hub.subscriber() });
    const a = makeFakeSocket();
    const b = makeFakeSocket();
    const c = makeFakeSocket();
    void rooms.join(2, a);
    void rooms.join(2, b);
    void rooms.join(2, c);

    rooms.broadcastLocal(2, { ch: 'replay_done', streamId: '1-0' }, a);

    expect((a as unknown as { __sent: unknown[] }).__sent.length).toBe(0);
    expect((b as unknown as { __sent: unknown[] }).__sent.length).toBe(1);
    expect((c as unknown as { __sent: unknown[] }).__sent.length).toBe(1);
  });

  it('keeps rooms isolated by docId', async () => {
    const hub = new FakeRedisHub();
    const rooms = new RoomRegistry({ subscriber: hub.subscriber() });
    const a = makeFakeSocket();
    const b = makeFakeSocket();
    await rooms.join(10, a);
    await rooms.join(20, b);

    rooms.broadcastLocal(10, { ch: 'replay_done', streamId: '1-0' });
    expect((a as unknown as { __sent: unknown[] }).__sent.length).toBe(1);
    expect((b as unknown as { __sent: unknown[] }).__sent.length).toBe(0);
  });

  it('tolerates double leave', async () => {
    const hub = new FakeRedisHub();
    const rooms = new RoomRegistry({ subscriber: hub.subscriber() });
    const a = makeFakeSocket();
    await rooms.join(3, a);
    await rooms.leave(3, a);
    await expect(rooms.leave(3, a)).resolves.toBeUndefined();
  });
});
