/**
 * Replay integration test.
 *
 * Runs an in-process ws server backed by the FakeRedisHub, XADDs a few
 * entries, connects with sinceStreamId=0-0, and asserts we receive the
 * corresponding crdt / remote_ops frames followed by replay_done.
 *
 * This one does NOT need a real Redis because the fake implements XRANGE
 * with the exclusive `(` lower bound.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { start, type RunningServer } from '../server.js';
import { FakeRedisHub } from './fakes/fakeRedis.js';

function collectFrames(ws: WebSocket): {
  waitFor: (matcher: (f: any) => boolean, timeoutMs?: number) => Promise<any>;
  all: () => any[];
} {
  const buffer: any[] = [];
  const waiters: Array<(f: any) => void> = [];
  ws.on('message', (data) => {
    const text = (data as Buffer).toString('utf8');
    let f: any;
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    buffer.push(f);
    // Snapshot + clear so waiters can re-queue themselves if their matcher fails.
    const snapshot = waiters.splice(0, waiters.length);
    for (const w of snapshot) w(f);
  });
  return {
    waitFor(matcher, timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        for (const f of buffer) {
          if (matcher(f)) return resolve(f);
        }
        const timer = setTimeout(() => reject(new Error('timeout waiting for frame')), timeoutMs);
        const listener = (f: any) => {
          if (matcher(f)) {
            clearTimeout(timer);
            resolve(f);
          } else {
            waiters.push(listener);
          }
        };
        waiters.push(listener);
      });
    },
    all: () => [...buffer],
  };
}

describe('replay integration', () => {
  let server: RunningServer;
  let hub: FakeRedisHub;

  beforeAll(async () => {
    hub = new FakeRedisHub();
    server = await start({
      config: { port: 0, instanceId: 'ws-test-replay' },
      redis: hub.publisher(),
      subscriber: hub.subscriber(),
      skipSignalHandlers: true,
    });

    // Seed the stream with 2 crdt entries and 1 ops entry.
    const client = hub.publisher();
    await client.xadd(
      'doc:42:stream',
      '*',
      'kind',
      'crdt',
      'blockId',
      'b-1',
      'delta',
      Buffer.from('a').toString('base64'),
      'userId',
      '7',
    );
    await client.xadd(
      'doc:42:stream',
      '*',
      'kind',
      'crdt',
      'blockId',
      'b-2',
      'delta',
      Buffer.from('b').toString('base64'),
      'userId',
      '7',
    );
    await client.xadd(
      'doc:42:stream',
      '*',
      'kind',
      'ops',
      'ops',
      JSON.stringify([
        { op: 'update_attrs', blockId: 'b-3', payload: { checked: true }, version: 2 },
      ]),
      'userId',
      '7',
    );
  });

  afterAll(async () => {
    await server.shutdown();
  });

  it('sends crdt + remote_ops + replay_done when sinceStreamId=0-0', async () => {
    const url = `ws://127.0.0.1:${server.port}/v3/docs/42?uid=1&sinceStreamId=0-0`;
    const ws = new WebSocket(url);
    const frames = collectFrames(ws);
    await new Promise((r) => ws.once('open', () => r(undefined)));

    const hello = await frames.waitFor((f) => f.ch === 'hello');
    expect(hello.userId).toBe(1);

    const crdt1 = await frames.waitFor((f) => f.ch === 'crdt');
    expect(crdt1.blockId).toBe('b-1');
    expect(crdt1.userId).toBe(7);
    expect(typeof crdt1.streamId).toBe('string');

    const remoteOps = await frames.waitFor((f) => f.ch === 'remote_ops');
    expect(remoteOps.ops[0].blockId).toBe('b-3');

    const done = await frames.waitFor((f) => f.ch === 'replay_done');
    expect(typeof done.streamId).toBe('string');
    expect(done.streamId).not.toBe('0-0');

    ws.close();
  }, 10_000);
});
