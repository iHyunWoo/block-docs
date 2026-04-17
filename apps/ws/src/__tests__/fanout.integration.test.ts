/**
 * Multi-instance fan-out integration test.
 *
 * Spins up TWO ws servers, both pointed at a REAL Redis. User A joins
 * instance-1, User B joins instance-2. A publishes a crdt message; B must
 * receive it (proving the bus wires through Redis pub/sub).
 *
 * Skipped when REDIS_URL is not set, so CI can choose to exercise it or not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import Redis from 'ioredis';
import { start, type RunningServer } from '../server.js';

const REDIS_URL = process.env.REDIS_URL;
const skip = !REDIS_URL;

describe.skipIf(skip)('fanout integration (real Redis)', () => {
  let s1: RunningServer;
  let s2: RunningServer;
  let flusher: Redis;

  beforeAll(async () => {
    flusher = new Redis(REDIS_URL!);
    await flusher.flushdb();

    s1 = await start({
      config: { port: 0, instanceId: 'ws-test-1', redisUrl: REDIS_URL! },
      skipSignalHandlers: true,
    });
    s2 = await start({
      config: { port: 0, instanceId: 'ws-test-2', redisUrl: REDIS_URL! },
      skipSignalHandlers: true,
    });
  });

  afterAll(async () => {
    await s1?.shutdown();
    await s2?.shutdown();
    await flusher?.quit();
  });

  it('a crdt message on instance-1 is delivered to a client on instance-2', async () => {
    const urlA = `ws://127.0.0.1:${s1.port}/v3/docs/99?uid=1`;
    const urlB = `ws://127.0.0.1:${s2.port}/v3/docs/99?uid=2`;

    const a = new WebSocket(urlA);
    const b = new WebSocket(urlB);
    await Promise.all([
      new Promise((r) => a.once('open', () => r(undefined))),
      new Promise((r) => b.once('open', () => r(undefined))),
    ]);

    // Drain hello frames.
    await new Promise((r) => setTimeout(r, 50));

    const received = new Promise<any>((resolve, reject) => {
      const onMsg = (data: WebSocket.RawData) => {
        let f: any;
        try {
          f = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        if (f.ch === 'crdt') {
          b.off('message', onMsg);
          resolve(f);
        }
      };
      b.on('message', onMsg);
      setTimeout(() => reject(new Error('timeout waiting for crdt')), 5000);
    });

    const delta = Buffer.from('hello').toString('base64');
    a.send(JSON.stringify({ ch: 'crdt', blockId: 'b-1', delta }));

    const frame = await received;
    expect(frame.blockId).toBe('b-1');
    expect(frame.delta).toBe(delta);
    expect(frame.userId).toBe(1);
    expect(typeof frame.streamId).toBe('string');

    a.close();
    b.close();
  }, 10_000);
});
