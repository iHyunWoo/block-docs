import { describe, it, expect } from 'vitest';
import { parseClientMessage } from '../protocol.js';

describe('client message schema', () => {
  it('accepts a valid crdt message', () => {
    const res = parseClientMessage(
      JSON.stringify({ ch: 'crdt', blockId: 'b1', delta: Buffer.from('x').toString('base64') }),
    );
    expect(res.ok).toBe(true);
  });

  it('accepts a valid ops message', () => {
    const res = parseClientMessage(
      JSON.stringify({
        ch: 'ops',
        clientSeq: 1,
        ops: [{ op: 'update_attrs', blockId: 'b1', payload: { checked: true }, version: 2 }],
      }),
    );
    expect(res.ok).toBe(true);
  });

  it('accepts a valid awareness message', () => {
    const res = parseClientMessage(
      JSON.stringify({
        ch: 'awareness',
        state: { focusedBlockId: 'b1', cursor: { blockId: 'b1', offset: 5 } },
      }),
    );
    expect(res.ok).toBe(true);
  });

  it('rejects unknown channel', () => {
    const res = parseClientMessage(JSON.stringify({ ch: 'mystery', foo: 1 }));
    expect(res.ok).toBe(false);
  });

  it('rejects invalid JSON', () => {
    const res = parseClientMessage('not-json');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('invalid_json');
  });

  it('rejects crdt with empty delta', () => {
    const res = parseClientMessage(JSON.stringify({ ch: 'crdt', blockId: 'b1', delta: '' }));
    expect(res.ok).toBe(false);
  });

  it('rejects ops with no operations', () => {
    const res = parseClientMessage(JSON.stringify({ ch: 'ops', clientSeq: 0, ops: [] }));
    expect(res.ok).toBe(false);
  });

  it('rejects ops with invalid op type', () => {
    const res = parseClientMessage(
      JSON.stringify({
        ch: 'ops',
        clientSeq: 0,
        ops: [{ op: 'nuke_doc', blockId: 'b1', payload: {} }],
      }),
    );
    expect(res.ok).toBe(false);
  });

  it('rejects awareness with bad cursor offset', () => {
    const res = parseClientMessage(
      JSON.stringify({
        ch: 'awareness',
        state: { cursor: { blockId: 'b1', offset: -1 } },
      }),
    );
    expect(res.ok).toBe(false);
  });
});
