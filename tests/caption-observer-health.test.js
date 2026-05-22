// Bug 5.1 — caption observer health-check + selectors_broken telemetry.
//
// The caption-speaker-observer scrapes Meet/Teams caption blocks via a
// MutationObserver. When Meet rotates a class name OR the user moves
// into a breakout-room re-mount that breaks the selectors, the
// observer keeps running but never sees a real caption. Before this
// fix, the only signal was a silent timeline (no events, no error,
// no telemetry); now a one-shot ``selectors_broken`` event fires
// when captions WERE flowing but stopped for >30s.
//
// Tests drive ``_tickHealthCheck`` + ``_test_markCaptionSeen``
// directly. The MutationObserver delivery path is covered separately
// by tests/caption-speaker-observer.test.js — duplicating it here led
// to happy-dom + setInterval race conditions that masked the actual
// health-check logic.

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import { startCaptionSpeakerObserver }
  from '../src/lib/caption-speaker-observer.js';

describe('caption observer — selectors_broken telemetry (Bug 5.1)', () => {
  let root;
  let now;
  let handle;
  let onTelemetry;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
    now = 1_000_000;
    onTelemetry = vi.fn();
  });

  afterEach(() => {
    try { handle?.dispose(); } catch { /* noop */ }
    handle = null;
    root.remove();
  });

  function start({ healthTickMs = 60_000, selectorsBrokenMs = 30 } = {}) {
    // healthTickMs defaults LONG so the real setInterval never fires
    // during a test. Tests drive ``_tickHealthCheck`` manually.
    return startCaptionSpeakerObserver({
      root,
      getElapsedSeconds: () => 0,
      isActive: () => true,
      onChange: vi.fn(),
      onTelemetry,
      now: () => now,
      healthTickMs,
      selectorsBrokenMs,
      enableCaptions: () => {},
    });
  }

  function selectorsBrokenCalls() {
    return onTelemetry.mock.calls.filter((c) => c[0] === 'selectors_broken');
  }

  // -----------------------------------------------------------------
  // never seen a caption → never fires (the gate `!sawAnyCaption`
  // protects no-captions meetings)
  // -----------------------------------------------------------------

  it('does NOT fire when no captions have ever been seen', () => {
    handle = start();
    now += 10_000_000; // way past any threshold
    handle._tickHealthCheck();
    handle._tickHealthCheck();
    expect(selectorsBrokenCalls().length).toBe(0);
  });

  // -----------------------------------------------------------------
  // fires ONCE after silence past the threshold
  // -----------------------------------------------------------------

  it('fires ONCE after >threshold silence following at least one real caption', () => {
    handle = start({ selectorsBrokenMs: 30 });
    handle._test_markCaptionSeen(now); // sawAnyCaption=true, last=1_000_000
    // Just under threshold — no fire.
    now += 25;
    handle._tickHealthCheck();
    expect(selectorsBrokenCalls().length).toBe(0);
    // Past threshold — fire the one-shot event.
    now += 10; // sinceMs = 35 ≥ 30
    handle._tickHealthCheck();
    expect(selectorsBrokenCalls().length).toBe(1);
    const payload = selectorsBrokenCalls()[0][1];
    expect(payload).toMatchObject({ source: 'captions' });
    expect(payload.sinceMs).toBeGreaterThanOrEqual(30);
    // Subsequent ticks must NOT re-fire — one-shot per observer life.
    now += 500;
    handle._tickHealthCheck();
    handle._tickHealthCheck();
    expect(selectorsBrokenCalls().length).toBe(1);
  });

  // -----------------------------------------------------------------
  // captions still flowing → tick always sees sinceMs < threshold
  // -----------------------------------------------------------------

  it('does NOT fire while captions are still flowing within the window', () => {
    handle = start({ selectorsBrokenMs: 30 });
    handle._test_markCaptionSeen(now);
    for (let i = 0; i < 5; i++) {
      now += 20;
      handle._tickHealthCheck();
      handle._test_markCaptionSeen(now); // simulate fresh caption
    }
    expect(selectorsBrokenCalls().length).toBe(0);
  });

  // -----------------------------------------------------------------
  // dispose() clears the real setInterval
  // -----------------------------------------------------------------

  it('dispose() clears the real health-check interval', () => {
    handle = start({ healthTickMs: 5, selectorsBrokenMs: 30 });
    const spy = vi.spyOn(globalThis, 'clearInterval');
    handle.dispose();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    handle = null;
  });

  // -----------------------------------------------------------------
  // isActive() gate — paused detector doesn't emit
  // -----------------------------------------------------------------

  it('does NOT fire while isActive() is false', () => {
    let active = true;
    handle = startCaptionSpeakerObserver({
      root,
      getElapsedSeconds: () => 0,
      isActive: () => active,
      onChange: vi.fn(),
      onTelemetry,
      now: () => now,
      healthTickMs: 60_000,
      selectorsBrokenMs: 30,
      enableCaptions: () => {},
    });
    handle._test_markCaptionSeen(now);
    active = false; // detector paused
    now += 100; // well past threshold
    handle._tickHealthCheck();
    expect(selectorsBrokenCalls().length).toBe(0);
    // Re-activate — tick now fires.
    active = true;
    handle._tickHealthCheck();
    expect(selectorsBrokenCalls().length).toBe(1);
  });

  // -----------------------------------------------------------------
  // sinceMs payload reflects the actual gap (not a constant)
  // -----------------------------------------------------------------

  it('sinceMs payload reflects the actual silence duration', () => {
    handle = start({ selectorsBrokenMs: 50 });
    handle._test_markCaptionSeen(now);
    now += 75; // sinceMs = 75, threshold 50 → fire
    handle._tickHealthCheck();
    expect(selectorsBrokenCalls()[0][1].sinceMs).toBe(75);
  });
});
