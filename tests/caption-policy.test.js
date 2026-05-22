// Unit tests for the caption ownership policy. Pure JS — drive it
// with fake adapters + a fake clock and step it via the returned
// tick().

import { describe, expect, it, vi } from 'vitest';

import { startCaptionPolicy } from '../src/lib/caption-policy.js';

function harness(initialOn) {
  let on = initialOn;
  let t = 1000;
  const enable = vi.fn(() => { on = true; }); // one-directional
  const disable = vi.fn(() => { on = false; });
  const hideUI = vi.fn();
  const unhideUI = vi.fn();
  const p = startCaptionPolicy({
    isOn: () => on,
    enable,
    disable,
    hideUI,
    unhideUI,
    now: () => t,
    intervalMs: 1e9, // never auto-fire; we step manually
    enableGraceMs: 3500,
  });
  return {
    p, enable, disable, hideUI, unhideUI,
    setOn: (v) => { on = v; },
    advance: (ms) => { t += ms; },
    tick: () => p.tick(),
  };
}

describe('caption-policy — case 1: user already had captions on', () => {
  it('keeps them visible, never hides, never enables', () => {
    const h = harness(true); // construction runs the first tick
    expect(h.p.state().userWantsVisible).toBe(true);
    expect(h.unhideUI).toHaveBeenCalled();
    expect(h.hideUI).not.toHaveBeenCalled();
    expect(h.enable).not.toHaveBeenCalled();
    h.p.dispose();
  });
});

describe('caption-policy — case 2: captions off → enable + hide', () => {
  it('enables captions and hides the box (stealth)', () => {
    const h = harness(false);
    expect(h.enable).toHaveBeenCalledTimes(1);
    expect(h.hideUI).toHaveBeenCalled();
    expect(h.unhideUI).not.toHaveBeenCalled();
    expect(h.p.state().userWantsVisible).toBe(false);
    // Captions come back ON because WE enabled them (within grace) →
    // stay hidden, do not flip to user-visible.
    h.setOn(true);
    h.advance(1500); // < grace
    h.tick();
    expect(h.p.state().userWantsVisible).toBe(false);
    h.p.dispose();
  });
});

describe('caption-policy — case 3: user turns captions on themselves', () => {
  it('an OFF→ON transition outside the grace window unhides', () => {
    const h = harness(false); // enable + hide, weEnabledAt = 1000
    h.unhideUI.mockClear();
    // User enables captions much later (not us).
    h.advance(10_000); // well past the 3500ms grace
    h.setOn(true);
    h.tick();
    expect(h.p.state().userWantsVisible).toBe(true);
    expect(h.unhideUI).toHaveBeenCalled();
    h.p.dispose();
  });
});

describe('caption-policy — case 4: user turns captions off mid-meeting', () => {
  it('detects the ON→OFF, re-enables, and re-hides (stealth)', () => {
    const h = harness(false);
    // Get to a steady "user-visible, on" state first (case 1-ish):
    h.advance(10_000);
    h.setOn(true);
    h.tick(); // OFF→ON outside grace → userWantsVisible true
    expect(h.p.state().userWantsVisible).toBe(true);
    h.enable.mockClear();
    h.hideUI.mockClear();
    // User turns captions OFF.
    h.setOn(false);
    h.tick();
    // They don't want captions → stealth: re-enable + hide.
    expect(h.p.state().userWantsVisible).toBe(false);
    expect(h.enable).toHaveBeenCalled();
    expect(h.hideUI).toHaveBeenCalled();
    h.p.dispose();
  });
});

describe('caption-policy — lifecycle', () => {
  it('dispose() stops the reconcile loop', () => {
    const h = harness(true);
    h.p.dispose();
    const calls = h.unhideUI.mock.calls.length;
    h.setOn(false);
    h.tick(); // disposed → no-op
    expect(h.unhideUI.mock.calls.length).toBe(calls);
    expect(h.enable).not.toHaveBeenCalled();
  });

  it('isOn throwing does not crash the tick', () => {
    let t = 0;
    const p = startCaptionPolicy({
      isOn: () => { throw new Error('DOM gone'); },
      enable: () => {},
      hideUI: () => {},
      unhideUI: () => {},
      now: () => (t += 100),
      intervalMs: 1e9,
    });
    expect(() => p.tick()).not.toThrow();
    p.dispose();
  });
});

describe('dispose({ restore }) — turn captions off only if extension-owned', () => {
  it('extension-owned (off at attach → we enabled): restore turns them OFF', () => {
    const h = harness(false);   // captions OFF → policy enables them
    expect(h.enable).toHaveBeenCalled();
    h.setOn(true);              // they came on (ours, in grace)
    h.tick();
    expect(h.p.state().userWantsVisible).toBe(false); // extension-owned
    h.p.dispose({ restore: true });
    expect(h.disable).toHaveBeenCalledTimes(1);        // box turned off
  });

  it('user-owned (on at attach): restore LEAVES captions on', () => {
    const h = harness(true);    // user had captions on
    expect(h.p.state().userWantsVisible).toBe(true);
    h.p.dispose({ restore: true });
    expect(h.disable).not.toHaveBeenCalled();
  });

  it('user turned them on mid-session: restore leaves them on', () => {
    const h = harness(false);
    h.advance(10_000);          // well past the enable grace
    h.setOn(true);              // USER turned captions on
    h.tick();
    expect(h.p.state().userWantsVisible).toBe(true);
    h.p.dispose({ restore: true });
    expect(h.disable).not.toHaveBeenCalled();
  });

  it('no-arg dispose() never turns captions off (back-compat)', () => {
    const h = harness(false);
    h.setOn(true); h.tick();
    h.p.dispose();
    expect(h.disable).not.toHaveBeenCalled();
  });

  it('restore is a no-op when captions are already off', () => {
    // enable() that never actually turns captions on (e.g. the
    // platform button wasn't found) → nothing to turn off at stop.
    const disable = vi.fn();
    let t = 1000;
    const p = startCaptionPolicy({
      isOn: () => false,
      enable: () => {},          // stays off
      disable,
      hideUI: () => {},
      unhideUI: () => {},
      now: () => t,
      intervalMs: 1e9,
    });
    t += 5000;
    p.dispose({ restore: true });
    expect(disable).not.toHaveBeenCalled();
  });
});
