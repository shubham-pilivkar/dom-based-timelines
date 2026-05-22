// Tests for the live-transcribe speaker-name resolver.
// The resolver is the bridge between provider numeric speaker IDs
// (Speaker 0/1/2…) and real participant names from the meeting UI.
// This is the cornerstone of Mode 2 usability — without correct
// binding, every transcript shows generic labels and the user can't
// compare the four STT providers' diarization accuracy.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRESHNESS_MS,
  DEFAULT_STALE_NAME_WINDOW_MS,
  SpeakerNameMap,
  TranscribeMode,
} from '../src/transcribe/speaker-name-map.js';


// Each test pins ``now()`` so the freshness window is deterministic.
function makeMap(opts = {}) {
  let t = opts.t0 ?? 1_000_000;
  const map = new SpeakerNameMap({
    ...opts,
    now: () => t,
  });
  return {
    map,
    advance(ms) { t += ms; },
    setTime(ms) { t = ms; },
  };
}


describe('Mode 1 (self)', () => {
  it('returns the configured self name for every numeric speaker', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.SELF);
    map.setSelfName('Shubham');
    expect(map.resolve({ speaker: 0, text: 'hi' })).toBe('Shubham');
    // Same name regardless of numeric speaker — Mode 1 collapses
    // every provider speaker into the user.
    expect(map.resolve({ speaker: 1, text: 'hi' })).toBe('Shubham');
    expect(map.resolve({ speaker: 99, text: 'hi' })).toBe('Shubham');
  });

  it('falls back to "You" when self name not yet loaded', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.SELF);
    expect(map.resolve({ speaker: 0 })).toBe('You');
  });

  it('ignores DOM observations in Mode 1', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.SELF);
    map.setSelfName('Shubham');
    map.recordObservation('SomeOtherPerson');
    // DOM said "SomeOtherPerson" but Mode 1 still labels with self.
    expect(map.resolve({ speaker: 0 })).toBe('Shubham');
  });
});


describe('Mode 2 (participants) — fresh binding', () => {
  it('binds numeric speaker to DOM observation on first sighting', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.recordObservation('Rishi');
    expect(map.resolve({ speaker: 0 })).toBe('Rishi');
  });

  it('caches binding so subsequent events for same numeric reuse name', () => {
    const { map, advance } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.recordObservation('Rishi');
    expect(map.resolve({ speaker: 0 })).toBe('Rishi');
    // Advance past the freshness window — cached binding survives.
    advance(DEFAULT_FRESHNESS_MS + 1000);
    expect(map.resolve({ speaker: 0 })).toBe('Rishi');
  });

  it('freshest meeting caption-author wins over a stale numeric cache', () => {
    // The meeting platform's own "who is speaking" is ground truth;
    // the STT provider's numeric labels are unreliable (it re-uses
    // 0/1 across humans). So once Priya is the current caption
    // author, even provider-numeric 0 resolves to Priya — NOT the
    // old "first binding for 0 sticks forever" (the reported bug:
    // wrong/"Speaker A" names that never corrected).
    const { map, advance } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.recordObservation('Rishi');
    expect(map.resolve({ speaker: 0 })).toBe('Rishi');
    advance(2000);
    map.recordObservation('Priya');
    expect(map.resolve({ speaker: 1 })).toBe('Priya');
    // Priya is the freshest author → numeric 0 now also resolves to
    // her (tracks the live meeting, not a stale cache).
    expect(map.resolve({ speaker: 0 })).toBe('Priya');
  });

  it('cached numeric name BRIDGES a gap when no fresh author exists', () => {
    const { map, advance } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.recordObservation('Rishi');
    expect(map.resolve({ speaker: 0 })).toBe('Rishi'); // binds 0→Rishi
    // Long gap, no new caption author AND past the stale window →
    // the cached binding keeps the turn labelled, not a letter.
    advance(DEFAULT_STALE_NAME_WINDOW_MS + 1000);
    expect(map.resolve({ speaker: 0 })).toBe('Rishi');
  });

  it('falls back to "Speaker A/B/…" when no fresh DOM evidence exists', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    // No observation recorded — first sighting falls back to the
    // provider's diarization label rendered with letters.
    expect(map.resolve({ speaker: 0 })).toBe('Speaker A');
    expect(map.resolve({ speaker: 2 })).toBe('Speaker C');
  });

  it('binds on a later attempt once a fresh observation lands', () => {
    const { map, advance } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    // First sighting — no DOM evidence yet, gets generic.
    expect(map.resolve({ speaker: 0 })).toBe('Speaker A');
    // Now the DOM speaks.
    advance(500);
    map.recordObservation('Rishi');
    // Same numeric speaker, fresh observation — binding lands.
    expect(map.resolve({ speaker: 0 })).toBe('Rishi');
  });
});


describe('Mode 2 freshness window', () => {
  it('past freshnessMs: shows the real name but does NOT cache it', () => {
    const { map, advance } = makeMap({
      freshnessMs: 4000, staleNameWindowMs: 45000,
    });
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.recordObservation('Rishi');
    // Walk past the BINDING window but within the display window.
    advance(5000);
    // Improvement: a real participant name from the meeting's own
    // captions beats "Speaker A". But it must NOT be cached — the
    // binding has to self-correct when a fresh observation lands.
    expect(map.resolve({ speaker: 0 })).toBe('Rishi');
    expect(map.numericToName.size).toBe(0);
  });

  it('falls back to "Speaker A" only past the stale-name window', () => {
    const { map, advance } = makeMap({
      freshnessMs: 4000, staleNameWindowMs: 45000,
    });
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.recordObservation('Rishi');
    advance(46000); // beyond even the wide display window
    expect(map.resolve({ speaker: 0 })).toBe('Speaker A');
  });

  it('prefers newest observation when multiple are in-window', () => {
    const { map, advance } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.recordObservation('Rishi');
    advance(500);
    map.recordObservation('Priya');
    // Newest wins.
    expect(map.resolve({ speaker: 0 })).toBe('Priya');
  });
});


describe('observation buffer', () => {
  it('drops oldest when timelineMax is exceeded', () => {
    const { map } = makeMap({ timelineMax: 3 });
    map.recordObservation('A', 1000);
    map.recordObservation('B', 2000);
    map.recordObservation('C', 3000);
    expect(map.timeline.length).toBe(3);
    map.recordObservation('D', 4000);
    // Oldest dropped.
    expect(map.timeline.length).toBe(3);
    expect(map.timeline[0].name).toBe('B');
    expect(map.timeline[2].name).toBe('D');
  });

  it('silently ignores empty/falsy names', () => {
    const { map } = makeMap();
    map.recordObservation('');
    map.recordObservation(null);
    map.recordObservation(undefined);
    expect(map.timeline.length).toBe(0);
  });
});


describe('reset', () => {
  it('clears mode, self name, cache, and timeline', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.setSelfName('Rishi');
    map.recordObservation('Priya');
    map.resolve({ speaker: 0 });  // populate the cache

    map.reset();

    expect(map.mode).toBe(null);
    expect(map.selfName).toBe(null);
    expect(map.numericToName.size).toBe(0);
    expect(map.timeline.length).toBe(0);
    // A speaker-0 lookup after reset is generic — the prior cache
    // is gone.
    map.setMode(TranscribeMode.PARTICIPANTS);
    expect(map.resolve({ speaker: 0 })).toBe('Speaker A');
  });
});


describe('alphabetic fallback labels', () => {
  it('emits Speaker A..Z for the first 26 numeric IDs', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    expect(map.resolve({ speaker: 0 })).toBe('Speaker A');
    expect(map.resolve({ speaker: 1 })).toBe('Speaker B');
    expect(map.resolve({ speaker: 25 })).toBe('Speaker Z');
  });

  it('wraps to numeric beyond 26 speakers so the label stays a string', () => {
    // 26+ speakers in a meeting never happens, but the function must
    // not return "Speaker {" (66 == 'A' + 26) or NaN.
    const { map } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    expect(map.resolve({ speaker: 26 })).toBe('Speaker 27');
  });
});


describe('clearNumericBindings (provider failover)', () => {
  it('drops the numeric→name cache but keeps mode and timeline', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.recordObservation('Rishi');
    expect(map.resolve({ speaker: 0 })).toBe('Rishi');
    // Provider failover happens — wipe numeric bindings only.
    map.clearNumericBindings();
    // Mode + timeline survive the switch.
    expect(map.mode).toBe(TranscribeMode.PARTICIPANTS);
    expect(map.timeline.length).toBe(1);
    // Numeric ID 0 from the NEW provider rebinds from the still-valid
    // DOM observation — same name lands, but it's a re-derivation,
    // not a stale cache hit.
    expect(map.resolve({ speaker: 0 })).toBe('Rishi');
  });

  it('lets a fresh DOM observation override stale binding after switch', () => {
    const { map, advance } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.recordObservation('Rishi');
    expect(map.resolve({ speaker: 0 })).toBe('Rishi');
    // Now the active speaker changes, DOM emits Priya, then provider
    // failover fires. Old provider had cached 0→Rishi; new provider's
    // first frame on speaker 0 should bind to Priya.
    advance(500);
    map.recordObservation('Priya');
    map.clearNumericBindings();
    expect(map.resolve({ speaker: 0 })).toBe('Priya');
  });
});


describe('edge cases', () => {
  it('returns "Speaker" when numeric speaker is null/undefined', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    expect(map.resolve({ speaker: null })).toBe('Speaker');
    expect(map.resolve({})).toBe('Speaker');
  });

  it('handles transcript events with extra fields', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.recordObservation('Rishi');
    const event = {
      type: 'final',
      speaker: 0,
      text: 'long meaningful turn',
      started_at_ms: 1234,
      ended_at_ms: 5678,
      language: 'hi',
    };
    expect(map.resolve(event)).toBe('Rishi');
  });
});

describe('real participant names instead of "Speaker A/B" (user ask)', () => {
  it('a final that lags the caption still shows the real name', () => {
    // Provider finals arrive 1-3s behind audio; Meet emits a caption-
    // author line, THEN the matching final lands a few seconds later.
    const { map, advance } = makeMap(); // defaults: fresh 8s, stale 45s
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.recordObservation('Aarav');
    advance(2500); // typical provider-final lag — inside 8s fresh
    expect(map.resolve({ speaker: 0 })).toBe('Aarav');
  });

  it('only emits a letter label when there is NO name evidence at all', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    // Captions never produced a name (e.g. provider w/o diarization,
    // captions unavailable) → letter, not a wrong name.
    expect(map.resolve({ speaker: 1 })).toBe('Speaker B');
  });

  it('DEFAULT_FRESHNESS_MS was widened so finals match real names', () => {
    expect(DEFAULT_FRESHNESS_MS).toBeGreaterThanOrEqual(8000);
  });
});

describe('D10 — mode=both cross-pollination of mic substream into tab substream', () => {
  // Phase 2 fix: in mode='both' the tab substream's diarization
  // typically can't bind the local user to a real name (Meet hides
  // the caption-author badge for the local user → no DOM observation
  // for them → tab substream falls back to "Speaker A" forever for
  // the user). The overlay's handleEvent records ``selfName`` as a
  // speakerMap observation whenever a mic-substream event arrives,
  // so the tab substream's _resolveParticipant can bind its own
  // (independent) numeric for the user to selfName.
  it('mic event records selfName so tab substream resolves user to real name', () => {
    const { map, advance } = makeMap();
    // Mode='both' uses the participant resolution path for the tab
    // substream via the streamRole='tab' override.
    map.setMode(TranscribeMode.BOTH);
    map.setSelfName('Shubham Pilivkar');

    // Step 1: a mic-substream event arrived in handleEvent. Overlay
    // emits the cross-pollination call below.
    map.recordObservation('Shubham Pilivkar');

    // Step 2: a tab-substream event arrives slightly later. The tab
    // substream's "Speaker A" is the local user (their voice picked
    // up via meeting audio) — and we now have a fresh observation to
    // bind it to.
    advance(800);
    expect(
      map.resolve({ speaker: 0 }, /* streamRole */ 'tab'),
    ).toBe('Shubham Pilivkar');
  });

  it('tab event for OTHER participant still resolves to their caption name', () => {
    // Cross-pollination must not corrupt the resolution of other
    // participants: the freshest observation wins.
    const { map, advance } = makeMap();
    map.setMode(TranscribeMode.BOTH);
    map.setSelfName('Shubham Pilivkar');

    // User spoke (cross-pollination); Suparna then takes a turn and
    // her caption author lands in the DOM.
    map.recordObservation('Shubham Pilivkar');
    advance(500);
    map.recordObservation('Suparna');
    advance(200);
    // Tab event for Speaker B should resolve to Suparna (newest
    // observation wins per the existing resolver contract).
    expect(map.resolve({ speaker: 1 }, 'tab')).toBe('Suparna');
  });
});

describe('D12 — widened freshness windows', () => {
  it('DEFAULT_FRESHNESS_MS is at least 20s (covers slow finals + Mode 3 lag)', () => {
    expect(DEFAULT_FRESHNESS_MS).toBeGreaterThanOrEqual(20000);
  });

  it('DEFAULT_STALE_NAME_WINDOW_MS is at least 60s (covers turn-taking gaps)', () => {
    expect(DEFAULT_STALE_NAME_WINDOW_MS).toBeGreaterThanOrEqual(60000);
  });

  it('stale window is always wider than fresh window (display fallback gap)', () => {
    expect(DEFAULT_STALE_NAME_WINDOW_MS).toBeGreaterThan(DEFAULT_FRESHNESS_MS);
  });

  it('a Mode 3 tab final at 15s after observation still binds (was 12s cliff)', () => {
    // Realistic Mode 3 latency: mic substream finals land ~1s, tab
    // substream finals can lag another 10-14s depending on provider
    // queue. With the old 12s freshness window, the tab final fell
    // off the cliff into the "stale display fallback" zone (the right
    // name was shown but the binding never cached). 20s comfortably
    // covers this so the cache survives and subsequent tab partials
    // reuse the binding instead of falling back per-event.
    const { map, advance } = makeMap();
    map.setMode(TranscribeMode.BOTH);
    map.setSelfName('Shubham Pilivkar');
    map.recordObservation('Shubham Pilivkar');
    advance(15000);
    expect(map.resolve({ speaker: 0 }, 'tab')).toBe('Shubham Pilivkar');
    // Confirm the binding cached (a re-resolve outside the freshness
    // window after binding still returns the same name).
    advance(DEFAULT_STALE_NAME_WINDOW_MS + 1000);
    expect(map.resolve({ speaker: 0 }, 'tab')).toBe('Shubham Pilivkar');
  });
});

describe('numeric speaker key normalization (provider wire-type variance)', () => {
  it('number 0 and string "0" share ONE binding (no re-bind / mislabel)', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    map.recordObservation('Neha');
    expect(map.resolve({ speaker: 0 })).toBe('Neha');   // binds key "0"
    // Same human, provider now emits the id as a string — must reuse
    // the cached name, not re-resolve to whoever is freshest.
    expect(map.resolve({ speaker: '0' })).toBe('Neha');
    expect(map.numericToName.size).toBe(1);
  });

  it('string-typed speaker IDs still render as letters when no name', () => {
    const { map } = makeMap();
    map.setMode(TranscribeMode.PARTICIPANTS);
    expect(map.resolve({ speaker: '0' })).toBe('Speaker A');
    expect(map.resolve({ speaker: 'spk_1' })).toBe('Speaker B');
  });
});
