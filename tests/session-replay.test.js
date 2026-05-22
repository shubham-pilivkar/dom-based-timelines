// Tests for the session-replay sanitiser. The full ring-buffer round
// trip needs IndexedDB which is heavy to mock — those paths are
// exercised indirectly by the popup-driven SW flow. Here we pin the
// privacy-critical sanitiser contract so a regression that leaks
// transcript text or emails fails loud.

import { describe, expect, it } from 'vitest';

import { sanitise } from '../src/lib/session-replay.js';


describe('sanitise', () => {
  it('redacts known PII field names regardless of value', () => {
    const input = {
      text: 'Whatever the user said — full transcript line',
      speaker_name: 'Rishi Kumar',
      email: 'user@example.com',
      token: 'eyJabc.xyz',
      ws_token: 'abc',
      authorization: 'Bearer xyz',
      password: 'hunter2',
    };
    const out = sanitise(input);
    for (const k of Object.keys(input)) {
      expect(out[k]).toBe('[redacted]');
    }
  });

  it('keeps non-PII fields verbatim when they are short', () => {
    const out = sanitise({ type: 'CHUNK_PERSISTED', chunkIndex: 7, ok: true });
    expect(out).toEqual({ type: 'CHUNK_PERSISTED', chunkIndex: 7, ok: true });
  });

  it('truncates long strings to 80 chars to prevent accidental leaks', () => {
    const long = 'x'.repeat(200);
    const out = sanitise({ msg: long });
    expect(out.msg.length).toBe(80);
    expect(out.msg.endsWith('...')).toBe(true);
  });

  it('recursively sanitises nested objects and arrays', () => {
    const input = {
      outer: {
        speaker_name: 'inner-pii',
        details: [{ text: 'transcript' }, { ok: true }],
      },
    };
    const out = sanitise(input);
    expect(out.outer.speaker_name).toBe('[redacted]');
    expect(out.outer.details[0].text).toBe('[redacted]');
    expect(out.outer.details[1].ok).toBe(true);
  });

  it('caps array length to 50 so a runaway accumulator cannot fill the ring', () => {
    const arr = Array.from({ length: 200 }, (_, i) => ({ i }));
    const out = sanitise({ items: arr });
    expect(out.items.length).toBe(50);
    expect(out.items[0]).toEqual({ i: 0 });
  });

  it('halts deep recursion with a placeholder rather than throwing', () => {
    // Build a 10-level nested object — sanitise caps at depth 6.
    let cur = { tail: 'leaf' };
    for (let i = 0; i < 10; i += 1) cur = { next: cur };
    const out = sanitise(cur);
    // Walk into ``out`` and confirm we hit the truncation marker
    // before bottoming out on 'leaf'.
    const s = JSON.stringify(out);
    expect(s).toContain('[truncated_depth]');
  });

  it('passes null/undefined through unchanged', () => {
    expect(sanitise(null)).toBe(null);
    expect(sanitise(undefined)).toBe(undefined);
  });

  it('handles primitives without wrapping them', () => {
    expect(sanitise(42)).toBe(42);
    expect(sanitise(true)).toBe(true);
    expect(sanitise('short')).toBe('short');
  });

  it('serialises BigInt as string (JSON-safe)', () => {
    // BigInt would otherwise throw inside JSON.stringify when the
    // popup ships the dump. Better to stringify here than to risk
    // a runtime throw at send time.
    expect(sanitise(BigInt(123))).toBe('123');
  });

  it('reduces functions and symbols to a tag', () => {
    expect(sanitise(() => 1)).toBe('[function]');
    expect(sanitise(Symbol('x'))).toBe('[symbol]');
  });
});
