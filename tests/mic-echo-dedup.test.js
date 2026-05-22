// Tests for Mode 3 mic-vs-tab final dedup (Bug 12.1).
//
// In live-transcribe mode='both', the user's voice is captured twice:
// the mic substream gets it directly, and the tab substream gets it
// echoed back through the meeting audio mix. Both substream finals
// land at the overlay; this dedup ring lets the renderer drop the
// tab-substream echo so the user sees each utterance ONCE, not twice.

import { describe, expect, it } from 'vitest';
import {
  MicEchoDedup,
  looksLikeEcho,
  normaliseForDedup,
} from '../src/transcribe/mic-echo-dedup.js';

function makeDedup(opts = {}) {
  let t = opts.t0 ?? 1_000_000;
  const d = new MicEchoDedup({ ...opts, now: () => t });
  return {
    d,
    advance(ms) { t += ms; },
    setTime(ms) { t = ms; },
  };
}

const SELF = 'Shubham Pilivkar';

describe('normaliseForDedup', () => {
  it('lower-cases, strips punctuation, collapses whitespace', () => {
    expect(normaliseForDedup('Hello,  World!')).toBe('hello world');
    expect(normaliseForDedup('  Multi\n\nline  ')).toBe('multi line');
  });

  it('returns empty for non-strings / empty / whitespace', () => {
    expect(normaliseForDedup(null)).toBe('');
    expect(normaliseForDedup(undefined)).toBe('');
    expect(normaliseForDedup('')).toBe('');
    expect(normaliseForDedup('   ')).toBe('');
    expect(normaliseForDedup(42)).toBe('');
  });
});

describe('looksLikeEcho', () => {
  it('exact normalised match', () => {
    expect(looksLikeEcho('hello world', 'hello world')).toBe(true);
  });

  it('one contains the other (either direction)', () => {
    expect(looksLikeEcho('hello world how are you', 'hello world')).toBe(true);
    expect(looksLikeEcho('hello world', 'hello world how are you')).toBe(true);
  });

  it('completely different strings do NOT match', () => {
    expect(looksLikeEcho('hello world', 'good morning')).toBe(false);
  });

  it('empty inputs never match', () => {
    expect(looksLikeEcho('', 'hello')).toBe(false);
    expect(looksLikeEcho('hello', '')).toBe(false);
  });
});

describe('MicEchoDedup — Mode 3 user voice dedup', () => {
  it('tab final right after matching mic final is an echo', () => {
    const { d, advance } = makeDedup();
    d.recordMicFinal(SELF, 'Hello, this is Shubham');
    advance(500); // tab provider lag
    expect(d.isEcho(SELF, 'Hello this is Shubham')).toBe(true);
  });

  it('tab final beyond the window is NOT an echo (window expired)', () => {
    const { d, advance } = makeDedup({ windowMs: 4000 });
    d.recordMicFinal(SELF, 'Hello this is Shubham');
    advance(5000);
    expect(d.isEcho(SELF, 'Hello this is Shubham')).toBe(false);
  });

  it('tab final without any prior mic final renders normally', () => {
    const { d } = makeDedup();
    expect(d.isEcho(SELF, 'Hello this is Shubham')).toBe(false);
  });

  it('different speaker name does NOT dedup', () => {
    // Other participant ("Rishi") says something via tab — even if mic
    // had said the same text, the speaker-name guard means Rishi's
    // line renders.
    const { d } = makeDedup();
    d.recordMicFinal(SELF, 'Hello this is Shubham');
    expect(d.isEcho('Rishi', 'Hello this is Shubham')).toBe(false);
  });

  it('different text does NOT dedup', () => {
    const { d } = makeDedup();
    d.recordMicFinal(SELF, 'Hello this is Shubham');
    expect(d.isEcho(SELF, 'Talking about something else entirely')).toBe(false);
  });

  it('tab final containing a SUPERSET of mic text still dedups', () => {
    // Different providers tokenise differently — tab may finalise a
    // longer chunk that includes the mic-final fragment.
    const { d } = makeDedup();
    d.recordMicFinal(SELF, 'Hello');
    expect(d.isEcho(SELF, 'Hello this is Shubham how are you')).toBe(true);
  });

  it('tab final containing a SUBSET of mic text still dedups', () => {
    const { d } = makeDedup();
    d.recordMicFinal(SELF, 'Hello this is Shubham how are you');
    expect(d.isEcho(SELF, 'Hello')).toBe(true);
  });

  it('punctuation / casing differences across providers still dedup', () => {
    const { d } = makeDedup();
    d.recordMicFinal(SELF, 'Hello, this is Shubham!');
    expect(d.isEcho(SELF, 'hello this is shubham')).toBe(true);
  });

  it('ring caps at max — oldest entries evicted', () => {
    const { d, advance } = makeDedup({ max: 3 });
    d.recordMicFinal(SELF, 'turn one');
    advance(100);
    d.recordMicFinal(SELF, 'turn two');
    advance(100);
    d.recordMicFinal(SELF, 'turn three');
    advance(100);
    d.recordMicFinal(SELF, 'turn four');
    // 'turn one' should have been evicted (only 3 slots).
    expect(d.isEcho(SELF, 'turn one')).toBe(false);
    expect(d.isEcho(SELF, 'turn four')).toBe(true);
  });

  it('empty name guard — selfName not yet loaded means no record + no echo', () => {
    const { d } = makeDedup();
    d.recordMicFinal('', 'hello'); // no-op — would otherwise poison the ring
    expect(d.isEcho(SELF, 'hello')).toBe(false);
    // And with empty name on isEcho — should not dedup either.
    expect(d.isEcho('', 'hello')).toBe(false);
  });

  it('empty text guard — neither record nor echo fires', () => {
    const { d } = makeDedup();
    d.recordMicFinal(SELF, '');
    expect(d.isEcho(SELF, '')).toBe(false);
    // Recording empty text MUST NOT poison the ring.
    expect(d.isEcho(SELF, 'real text')).toBe(false);
  });

  it('reset clears the ring', () => {
    const { d } = makeDedup();
    d.recordMicFinal(SELF, 'hello');
    expect(d.isEcho(SELF, 'hello')).toBe(true);
    d.reset();
    expect(d.isEcho(SELF, 'hello')).toBe(false);
  });

  it('newest mic final wins when multiple match — verified via window scan order', () => {
    const { d, advance } = makeDedup();
    d.recordMicFinal(SELF, 'old turn');
    advance(2000);
    d.recordMicFinal(SELF, 'old turn');
    advance(500);
    // Both entries match; isEcho returns true based on the newest.
    expect(d.isEcho(SELF, 'old turn')).toBe(true);
  });
});
