// In-meeting mic-mute → recorder gating.
//   • mic-state-observer behaviour (data-safe: null never drops audio)
//   • content/SW/offscreen wiring (source-contract, like the others)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { startMicStateObserver } from '../src/lib/mic-state-observer.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), 'utf8');

describe('mic-state-observer', () => {
  function h(seq) {
    let i = 0;
    const onChange = vi.fn();
    const o = startMicStateObserver({
      detectMuted: () => (i < seq.length ? seq[i] : seq[seq.length - 1]),
      onChange,
      intervalMs: 1e9, // never auto-fire; step via tick()
    });
    return { o, onChange, step: () => { i += 1; }, tick: () => o.tick() };
  }

  it('emits the first concrete state and then only on change', () => {
    const t = h([false, false, true, true, false]);
    expect(t.onChange).toHaveBeenCalledWith(false); // immediate first read
    t.step(); t.tick();                              // false → no emit
    expect(t.onChange).toHaveBeenCalledTimes(1);
    t.step(); t.tick();                              // true → emit
    expect(t.onChange).toHaveBeenLastCalledWith(true);
    t.step(); t.tick();                              // true → no emit
    t.step(); t.tick();                              // false → emit
    expect(t.onChange).toHaveBeenLastCalledWith(false);
    expect(t.onChange).toHaveBeenCalledTimes(3);
    t.o.dispose();
  });

  it('null is "unknown" — keeps the last state, never reports', () => {
    const t = h([null, null]);
    expect(t.onChange).not.toHaveBeenCalled(); // never reported muted/again
    t.step(); t.tick();
    expect(t.onChange).not.toHaveBeenCalled();
    t.o.dispose();
  });

  it('a detector throw is swallowed (no crash, treated as unknown)', () => {
    const o = startMicStateObserver({
      detectMuted: () => { throw new Error('DOM gone'); },
      onChange: () => {},
      intervalMs: 1e9,
    });
    expect(() => o.tick()).not.toThrow();
    o.dispose();
  });

  it('dispose() stops the loop', () => {
    const t = h([false, true]);
    t.o.dispose();
    t.step(); t.tick();
    expect(t.onChange).toHaveBeenCalledTimes(1); // only the initial
  });
});

describe('wiring — content scripts detect + emit, SW forwards, offscreen gates', () => {
  const meet = read('../src/content/meet.js');
  const teams = read('../src/content/teams.js');
  const sw = read('../src/background/service-worker.js');
  const off = read('../src/offscreen/offscreen.js');
  const consts = read('../src/constants.js');

  it('message types exist', () => {
    expect(consts).toContain("MIC_MUTE_STATE: 'MIC_MUTE_STATE'");
    expect(consts).toContain("OFFSCREEN_MIC_MUTE: 'OFFSCREEN_MIC_MUTE'");
  });

  it('meetMicMuted is MIC-SCOPED (regression: must not read the camera/tile data-is-muted)', () => {
    const fn = meet.slice(
      meet.indexOf('function meetMicMuted()'),
      meet.indexOf('function meetMicMuted()') + 1400,
    );
    // The over-broad GLOBAL query was the bug — it must be gone
    // (a mic-scoped ``mic.querySelector('[data-is-muted]')`` is fine).
    expect(fn).not.toContain("document.querySelector('[data-is-muted]')");
    // Mic control is located by a microphone-specific aria-label/tooltip…
    expect(fn).toMatch(/aria-label\*="microphone" i/);
    // …and data-is-muted is only read FROM that control (matches/closest).
    expect(fn).toMatch(/mic\.(matches|closest|querySelector)/);
    // Verb-first, and "unmute" tested before "mute" (substring trap).
    expect(fn.indexOf("includes('unmute')"))
      .toBeLessThan(fn.indexOf("includes('turn off microphone')"));
    expect(fn).toContain('return null;');
  });

  it('meet.js observes only while recording', () => {
    expect(meet).toContain('startMicObserver()');
    const lc = meet.slice(meet.indexOf('recordingActive = true;'));
    expect(lc.slice(0, 400)).toContain('startMicObserver()');
    expect(meet).toContain('stopMicObserver()');
    expect(meet).toMatch(/MessageType\.MIC_MUTE_STATE/);
  });

  it('teamsMicMuted broadened for new Teams + verb-first', () => {
    const fn = teams.slice(
      teams.indexOf('function teamsMicMuted()'),
      teams.indexOf('function teamsMicMuted()') + 1400,
    );
    expect(fn).toContain('#microphone-button');
    expect(fn).toContain("[data-tid='toggle-mute']");
    // verb (aria-label/title) before the ambiguous aria-pressed hint
    expect(fn.indexOf("includes('unmute')"))
      .toBeLessThan(fn.indexOf("getAttribute('aria-pressed')"));
    expect(fn.indexOf("includes('unmute')"))
      .toBeLessThan(fn.indexOf("includes('mute')"));
    expect(teams).toContain('startMicObserver()');
    expect(teams).toContain('stopMicObserver()');
  });

  it('SW forwards MIC_MUTE_STATE → OFFSCREEN_MIC_MUTE while recording OR transcribing', () => {
    const c = sw.slice(
      sw.indexOf('case MessageType.MIC_MUTE_STATE:'),
      sw.indexOf('case MessageType.SPEAKER_CHANGE:'),
    );
    expect(c).toContain('RecordingState.RECORDING');
    expect(c).toContain('MessageType.OFFSCREEN_MIC_MUTE');
    expect(c).toContain('muted: !!message.muted');
    // Live-transcribe (self/both) must also gate the mic — forward
    // when transcribe is active too, not only while recording.
    expect(c).toContain('TranscribeState.ACTIVE');
    expect(c).toMatch(/recBusy\s*\|\|\s*trBusy/);
  });

  it('live-transcribe honours the in-meeting mic mute (transcribe.js gate)', () => {
    const tx = read('../src/offscreen/transcribe.js');
    // Module mirror + handler that gates on the SAME OFFSCREEN_MIC_MUTE
    // message the recorder uses.
    expect(tx).toContain('let meetingMicMuted = false;');
    expect(tx).toContain('[MessageType.OFFSCREEN_MIC_MUTE]:');
    expect(tx).toMatch(/meetingMicMuted = !!message\.muted;\s*applyMicGate\(\)/);
    // Gate drops frames at BOTH pump paths (PCM + Opus).
    expect(tx).toContain('sess.paused || sess.micGated');
    expect(tx).toContain('!sess || sess.paused || sess.micGated');
    // Only mic-sourced substreams are gated — participants/tab keep
    // transcribing when YOU mute yourself.
    expect(tx).toMatch(/applyMicGate\(\)\s*\{[\s\S]*!_isTabSourced\(/);
    expect(tx).toMatch(/micGated: meetingMicMuted && !_isTabSourced\(/);
  });

  it('content scripts run the mic observer during transcribe too (self/both)', () => {
    for (const src of [meet, teams]) {
      const start = src.indexOf('[MessageType.TRANSCRIBE_LIFECYCLE]:');
      expect(start).toBeGreaterThan(0);
      const tl = src.slice(start, start + 1400);
      // started → start the (shared, idempotent) mic observer.
      expect(tl).toContain('startMicObserver();');
      // stopped → only stop it if the other feature isn't using it.
      expect(tl).toContain('if (!recordingActive) stopMicObserver();');
    }
    // recording-stop must not kill the observer while transcribe runs.
    expect(meet).toContain('if (!transcribeActive) stopMicObserver();');
    expect(teams).toContain('if (!transcribeActive) stopMicObserver();');
  });

  it('offscreen gates effective mic gain = muted ? 0 : base, reapplied on rotate/gain-change', () => {
    expect(off).toContain('let meetingMicMuted = false;');
    const fn = off.slice(
      off.indexOf('function applyMicGain()'),
      off.indexOf('function applyMicGain()') + 400,
    );
    expect(fn).toContain('meetingMicMuted ? 0 : base');
    expect(off).toContain('[MessageType.OFFSCREEN_MIC_MUTE]:');
    // re-applied after a rotation and on options gain change
    expect(off).toMatch(/session\.baseMicGain = settings\[StorageKey\.MIC_GAIN\][\s\S]{0,40}applyMicGain\(\)/);
    expect(off).toContain('session.baseMicGain = v; applyMicGain()');
  });
});
