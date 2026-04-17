/**
 * Minimal in-process fake of the ioredis surface we use. Not thread-safe,
 * not performant, just enough for unit tests.
 *
 * A single FakeRedisHub is shared between the "publisher" and "subscriber"
 * clones so PUBLISH/SUBSCRIBE wires end-to-end in memory.
 */
import { EventEmitter } from 'node:events';
import type { RedisLike } from '../../types.js';

interface StreamEntry {
  id: string;
  fields: string[];
}

class Stream {
  entries: StreamEntry[] = [];
  private seq = 0;
  private ms = Date.now();

  add(fields: string[], maxlen?: number): string {
    // Monotonic ids: reuse ms while seq increments, then move forward.
    const now = Date.now();
    if (now > this.ms) {
      this.ms = now;
      this.seq = 0;
    } else {
      this.seq++;
    }
    const id = `${this.ms}-${this.seq}`;
    this.entries.push({ id, fields });
    if (maxlen && this.entries.length > maxlen) {
      this.entries.splice(0, this.entries.length - maxlen);
    }
    return id;
  }

  range(start: string, end: string): StreamEntry[] {
    const exclusiveLower = start.startsWith('(');
    const lower = exclusiveLower ? start.slice(1) : start;
    const upper = end;
    return this.entries.filter((e) => {
      const afterLower =
        lower === '-' || (exclusiveLower ? cmp(e.id, lower) > 0 : cmp(e.id, lower) >= 0);
      const beforeUpper = upper === '+' || cmp(e.id, upper) <= 0;
      return afterLower && beforeUpper;
    });
  }

  firstId(): string | null {
    return this.entries[0]?.id ?? null;
  }
}

function cmp(a: string, b: string): number {
  const [aMs = '0', aSeq = '0'] = a.split('-');
  const [bMs = '0', bSeq = '0'] = b.split('-');
  const aMsN = BigInt(aMs);
  const bMsN = BigInt(bMs);
  if (aMsN !== bMsN) return aMsN < bMsN ? -1 : 1;
  const aSeqN = BigInt(aSeq);
  const bSeqN = BigInt(bSeq);
  if (aSeqN !== bSeqN) return aSeqN < bSeqN ? -1 : 1;
  return 0;
}

export class FakeRedisHub {
  private streams = new Map<string, Stream>();
  /** subscribers per channel — EventEmitter fires 'message' on each. */
  private channelEmitters = new Map<string, EventEmitter>();

  private getStream(key: string): Stream {
    let s = this.streams.get(key);
    if (!s) {
      s = new Stream();
      this.streams.set(key, s);
    }
    return s;
  }

  xadd(key: string, ...args: (string | number)[]): string {
    // Accept both MAXLEN variants and the plain form.
    let i = 0;
    let maxlen: number | undefined;
    if (args[i] === 'MAXLEN') {
      i++;
      if (args[i] === '~' || args[i] === '=') i++;
      maxlen = Number(args[i]);
      i++;
    }
    if (args[i] !== '*') {
      throw new Error('fakeRedis: only "*" id supported');
    }
    i++;
    const fields = args.slice(i).map((a) => String(a));
    return this.getStream(key).add(fields, maxlen);
  }

  xrange(key: string, start: string, end: string): Array<[string, string[]]> {
    const s = this.streams.get(key);
    if (!s) return [];
    return s.range(start, end).map((e) => [e.id, e.fields] as [string, string[]]);
  }

  xinfoStream(key: string): unknown[] {
    const s = this.streams.get(key);
    const firstId = s?.firstId() ?? null;
    const out: unknown[] = ['length', s?.entries.length ?? 0];
    if (firstId && s) {
      const first = s.entries[0];
      if (first) out.push('first-entry', [first.id, first.fields]);
    } else {
      out.push('first-entry', null);
    }
    return out;
  }

  publish(channel: string, payload: string): number {
    const em = this.channelEmitters.get(channel);
    if (!em) return 0;
    em.emit('message', channel, payload);
    return em.listenerCount('message');
  }

  subscribe(client: FakeRedisClient, channels: string[]): void {
    for (const ch of channels) {
      let em = this.channelEmitters.get(ch);
      if (!em) {
        em = new EventEmitter();
        this.channelEmitters.set(ch, em);
      }
      const listener = (channel: string, payload: string) => {
        client.emit('message', channel, payload);
      };
      em.on('message', listener);
      client.subscribedChannels.set(ch, listener);
    }
  }

  unsubscribe(client: FakeRedisClient, channels: string[]): void {
    for (const ch of channels) {
      const listener = client.subscribedChannels.get(ch);
      if (!listener) continue;
      const em = this.channelEmitters.get(ch);
      em?.off('message', listener);
      client.subscribedChannels.delete(ch);
    }
  }

  publisher(): FakeRedisClient {
    return new FakeRedisClient(this, 'publisher');
  }

  subscriber(): FakeRedisClient {
    return new FakeRedisClient(this, 'subscriber');
  }
}

export class FakeRedisClient extends EventEmitter implements RedisLike {
  readonly subscribedChannels = new Map<string, (c: string, m: string) => void>();

  constructor(
    private hub: FakeRedisHub,
    readonly mode: 'publisher' | 'subscriber',
  ) {
    super();
  }

  async xadd(key: string, ...args: (string | number | Buffer)[]): Promise<string | null> {
    return this.hub.xadd(key, ...(args as (string | number)[]));
  }

  async xrange(key: string, start: string, end: string): Promise<Array<[string, string[]]>> {
    return this.hub.xrange(key, start, end);
  }

  async xinfo(_sub: 'STREAM', key: string): Promise<unknown> {
    return this.hub.xinfoStream(key);
  }

  async publish(channel: string, payload: string): Promise<number> {
    return this.hub.publish(channel, payload);
  }

  async subscribe(...channels: string[]): Promise<number> {
    this.hub.subscribe(this, channels);
    return this.subscribedChannels.size;
  }

  async unsubscribe(...channels: string[]): Promise<number> {
    this.hub.unsubscribe(this, channels);
    return this.subscribedChannels.size;
  }

  async quit(): Promise<'OK'> {
    for (const ch of [...this.subscribedChannels.keys()]) {
      this.hub.unsubscribe(this, [ch]);
    }
    this.removeAllListeners();
    return 'OK';
  }
}
