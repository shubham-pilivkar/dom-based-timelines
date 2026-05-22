// Speaker-name resolution for the live-transcription overlay.
//
// Provider STT services emit numeric speaker labels (Speaker 0, 1,
// 2…) that are stable WITHIN a session but have no relation to the
// meeting platform's participant identities. This module bridges
// that gap using two pieces of evidence:
//
//   * Mode 1 ("self"): every numeric speaker maps to the signed-in
//     user. The display name comes from the user's email local part.
//   * Mode 2 ("participants"): meet.js / teams.js DOM-tile detection
//     emits SPEAKER_CHANGE events with the participant name on the
//     active tile. The first time a numeric speaker appears in a
//     transcript event, we look at "who was the DOM saying was
//     speaking around then?" and cache that mapping.
//
// Extracted out of overlay.js so the resolver is testable without
// jsdom + Shadow DOM scaffolding.

export const TranscribeMode = Object.freeze({
  SELF: 'self',
  PARTICIPANTS: 'participants',
  // Mode 3 — mic + tab in parallel. The resolver routes per-event
  // via the ``streamRole`` hint passed to ``resolve()``: mic-origin
  // events collapse to the self name, tab-origin events go through
  // the participant resolution path.
  BOTH: 'both',
});

// Window in which a DOM caption-author observation is trusted enough
// to CACHE as the numeric→name binding. Widened 4s→8s→12s→20s:
// provider finals arrive 1-5s behind the audio on slower networks,
// AND Mode 3 tab substreams of mode='both' often land 1-3s after
// their mic-substream cross-pollination (D10) — a 12s window missed
// the binding for slow-final users so they re-fell-back to
// "Speaker A/B" mid-meeting. 20s comfortably covers both the wire
// latency and the cross-pollination lag without crossing the stale
// window's responsibility.
export const DEFAULT_FRESHNESS_MS = 20000;
// Separate, wider window for the DISPLAY fallback. When there's no
// cached binding and nothing inside the (tighter) freshness window,
// showing the most recent real speaker from the last ~60s is far
// more useful — and in a turn-taking meeting almost always correct —
// than a generic "Speaker A". This name is shown but NOT cached, so
// the next event self-corrects the moment a fresh observation lands.
// Widened 45s→60s in lockstep with the freshness bump so the gap
// between caching and "best guess" stays the same.
export const DEFAULT_STALE_NAME_WINDOW_MS = 60000;
export const DEFAULT_TIMELINE_MAX = 64;


export class SpeakerNameMap {
  /**
   * @param {{freshnessMs?: number, timelineMax?: number, now?: () => number}} opts
   */
  constructor(opts = {}) {
    this.freshnessMs = opts.freshnessMs ?? DEFAULT_FRESHNESS_MS;
    this.staleNameWindowMs =
      opts.staleNameWindowMs ?? DEFAULT_STALE_NAME_WINDOW_MS;
    this.timelineMax = opts.timelineMax ?? DEFAULT_TIMELINE_MAX;
    // Inject ``now`` so tests can pin time without monkey-patching
    // Date.now globally.
    this.now = opts.now ?? (() => Date.now());
    this.mode = null;
    this.selfName = null;
    /** @type {Map<number, string>} */
    this.numericToName = new Map();
    /** @type {Array<{ wall_clock_ms: number, name: string }>} */
    this.timeline = [];
  }

  setMode(mode) {
    this.mode = mode;
  }

  setSelfName(name) {
    this.selfName = name;
  }

  /**
   * Record a SPEAKER_CHANGE observation. Older entries are dropped
   * once the timeline exceeds ``timelineMax`` so a multi-hour
   * meeting doesn't grow this without bound.
   */
  recordObservation(name, wallClockMs) {
    if (!name) return;
    this.timeline.push({
      wall_clock_ms: wallClockMs ?? this.now(),
      name,
    });
    while (this.timeline.length > this.timelineMax) {
      this.timeline.shift();
    }
  }

  /**
   * Walk the timeline newest-first and return the first observation
   * within the freshness window. Newest match wins — provider events
   * arrive ~200-500ms behind real audio, so the most recent DOM
   * observation is almost always the right answer.
   *
   * @returns {string | null}
   */
  lookupAt(wallClockMs) {
    const cutoff = (wallClockMs ?? this.now()) - this.freshnessMs;
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const obs = this.timeline[i];
      if (obs.wall_clock_ms < cutoff) break;
      return obs.name;
    }
    return null;
  }

  /**
   * Newest observation within ``maxAgeMs`` (default: the wider stale-
   * name display window). Used ONLY for the display fallback — never
   * to cache a binding — so a real participant name is shown instead
   * of "Speaker A/B" when the freshness window just missed.
   *
   * @returns {string | null}
   */
  lookupMostRecent(maxAgeMs) {
    const span = maxAgeMs ?? this.staleNameWindowMs;
    const cutoff = this.now() - span;
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const obs = this.timeline[i];
      if (obs.wall_clock_ms < cutoff) return null;
      return obs.name;
    }
    return null;
  }

  /**
   * Resolve a transcript event to a display label.
   *
   * For Mode 1, all events collapse to ``selfName`` (or ``"You"`` if
   * the resolver hasn't been told the self name yet).
   *
   * For Mode 2:
   *   1. Return cached name if numeric→name was already bound.
   *   2. Else, try to bind from the freshest DOM observation; cache
   *      the binding if it lands.
   *   3. Else, fall back to a generic ``Speaker N`` label. The next
   *      event for the same numeric speaker will try to bind again
   *      — the binding is sticky once made but never inferred from
   *      stale evidence.
   *
   * For Mode 3 (both): the ``streamRole`` parameter overrides
   * mode-based routing per-event. ``streamRole='mic'`` collapses
   * to selfName/"You" (same as Mode 1's behaviour for the mic
   * substream); ``streamRole='tab'`` follows Mode 2's participant
   * resolution path. Null/undefined preserves the historical
   * mode-based behaviour for backward compatibility.
   *
   * @param {object} event
   * @param {string | null} [streamRole]
   */
  resolve(event, streamRole = null) {
    // Mode 3 per-event override (Mode 3 only): the streamRole hint
    // disambiguates mic vs tab without the resolver's mode having
    // to flip back and forth.
    if (streamRole === 'mic') return this.selfName || 'You';
    if (streamRole === 'tab') {
      return this._resolveParticipant(event);
    }
    if (this.mode === TranscribeMode.SELF) {
      return this.selfName || 'You';
    }
    return this._resolveParticipant(event);
  }

  /**
   * Inner helper for the participant-resolution path (Mode 2 and
   * the Mode 3 tab substream). Extracted so the streamRole short-
   * circuits at the top of ``resolve`` don't have to duplicate
   * the cache + DOM-observation lookup.
   */
  _resolveParticipant(event) {
    const raw = event ? event.speaker : null;
    const numeric = (raw === null || raw === undefined)
      ? null : String(raw);

    // PRIMARY: the meeting platform's OWN caption author is ground
    // truth for "who is talking right now" — far more reliable than
    // the STT provider's numeric diarization (which re-uses 0/1
    // across different humans and lags). So the freshest DOM
    // observation WINS and we (re)bind the numeric→name cache to it,
    // instead of the old "first cached value wins forever" (that
    // stuck the wrong name / "Speaker A" for the whole session).
    const fresh = this.lookupAt(this.now());
    if (fresh) {
      if (numeric !== null) this.numericToName.set(numeric, fresh);
      return fresh;
    }

    // BRIDGE: no caption author in the freshness window (the speaker
    // paused, or captions momentarily stalled) — keep the last known
    // real name for this provider-numeric so a continuous turn stays
    // labelled instead of flickering to a letter.
    if (numeric !== null) {
      const cached = this.numericToName.get(numeric);
      if (cached) return cached;
    }

    // DISPLAY FALLBACK: still surface the most recent real participant
    // name from the wider window before resorting to a generic label.
    const recent = this.lookupMostRecent(this.staleNameWindowMs);
    if (recent) return recent;

    // Genuinely no name evidence (captions off/unavailable, or a long
    // silence at session start) — provider diarization as letters so
    // it still reads like a transcript.
    if (numeric === null) return 'Speaker';
    return numericToLetter(numeric);
  }

  reset() {
    this.numericToName.clear();
    this.timeline.length = 0;
    this.mode = null;
    this.selfName = null;
  }

  /**
   * Drop just the numeric→name cache without touching mode/selfName or
   * the DOM observation timeline. Called when the relay fails over to
   * a different STT provider mid-session — the new provider's numeric
   * speaker IDs don't map to the old provider's, so the cached
   * bindings would mis-label everyone. The DOM observations stay
   * valid (they came from the meeting UI, not the provider), so the
   * map can rebind from them on the next ``resolve()``.
   */
  clearNumericBindings() {
    this.numericToName.clear();
  }
}


// 0 → "Speaker A", 1 → "Speaker B", … 25 → "Speaker Z", 26 → "Speaker 27".
// Negative or non-integer numerics get the literal "Speaker" so we
// never return ``Speaker NaN`` or similar.
function numericToLetter(n) {
  // ``n`` may be a number OR a normalised string key ("0", "spk_1").
  // Pull the first integer out so string-typed provider speaker IDs
  // still render as letters instead of the bare "Speaker".
  let v = typeof n === 'number' ? n : NaN;
  if (typeof n === 'string') {
    const m = /\d+/.exec(n);
    if (m) v = Number(m[0]);
  }
  if (!Number.isFinite(v) || v < 0) return 'Speaker';
  if (v < 26) {
    return `Speaker ${String.fromCharCode(65 + Math.floor(v))}`;
  }
  return `Speaker ${Math.floor(v) + 1}`;
}
