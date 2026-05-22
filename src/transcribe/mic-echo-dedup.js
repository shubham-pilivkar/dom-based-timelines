// Mode 3 double-render guard.
//
// In live-transcribe mode='both', the user's speech is captured TWICE:
//
//   1. Mic substream — direct getUserMedia → user transcribed immediately.
//   2. Tab substream — the same meeting audio (which includes the user's
//      voice routed back from the meeting mix) → user transcribed AGAIN.
//
// The overlay used to render both finals as separate rows, so the user
// saw every utterance twice (once labelled with their real name from
// the mic substream, once labelled the same from the tab substream
// because Phase 2D's cross-pollination correctly resolves the tab
// numeric to ``selfName`` too).
//
// This module owns the dedup ring: each mic-substream final is recorded
// here, and when a tab-substream final arrives that resolves to the
// SAME name AND looks like a near-match of a recent mic final, the
// caller drops it before rendering.
//
// Kept as its own module so the rule is unit-testable without DOM /
// shadow-root scaffolding.

const DEFAULT_WINDOW_MS = 4_000;
const DEFAULT_MAX = 30;

/**
 * Normalise transcript text for fuzzy comparison: lower-case, strip
 * punctuation, collapse whitespace. Provider finals from two different
 * STT vendors (different tokenisation + endpointing) often differ by
 * trailing punctuation or one or two words — direct string equality is
 * too strict.
 */
export function normaliseForDedup(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Either-direction substring containment: tab provider may finalise
 * "hello shubham" vs mic provider's "hello shubham how are you" for
 * the same utterance. Both should match. Empty strings never match.
 */
export function looksLikeEcho(a, b) {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export class MicEchoDedup {
  /**
   * @param {{ windowMs?: number, max?: number, now?: () => number }} [opts]
   */
  constructor(opts = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.max = opts.max ?? DEFAULT_MAX;
    this.now = opts.now ?? (() => Date.now());
    /** @type {Array<{ norm: string, ts: number, name: string }>} */
    this._ring = [];
  }

  /**
   * Record a mic-substream final so subsequent tab-substream finals
   * within the window that match it are recognised as echoes.
   * No-op when ``name`` is empty — the resolver returns "" for not-
   * yet-loaded selfName, and we MUST NOT poison the ring with empty
   * strings (every tab final would then dedup against them).
   */
  recordMicFinal(name, text, tsMs) {
    if (!name) return;
    const norm = normaliseForDedup(text);
    if (!norm) return;
    this._ring.push({
      norm,
      name,
      ts: typeof tsMs === 'number' ? tsMs : this.now(),
    });
    while (this._ring.length > this.max) this._ring.shift();
  }

  /**
   * @returns {boolean} true if the tab-substream final is a near-match
   *   of a recent mic-substream final FROM THE SAME SPEAKER (i.e. the
   *   user). False means render the tab final normally.
   */
  isEcho(name, text, tsMs) {
    if (!name) return false;
    const cutoff = (typeof tsMs === 'number' ? tsMs : this.now()) - this.windowMs;
    const norm = normaliseForDedup(text);
    if (!norm) return false;
    // Newest-first so the most recent mic final wins.
    for (let i = this._ring.length - 1; i >= 0; i--) {
      const m = this._ring[i];
      if (m.ts < cutoff) break; // past the window — older entries even older
      if (m.name !== name) continue;
      if (looksLikeEcho(m.norm, norm)) return true;
    }
    return false;
  }

  /** Drop everything — called on session reset / mode change. */
  reset() {
    this._ring.length = 0;
  }
}
