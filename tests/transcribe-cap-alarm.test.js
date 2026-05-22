// Fix 2 — live-transcribe duration-cap BACKSTOP alarm.
//
// Before this fix, live-transcribe relied ENTIRELY on the relay
// sending TRANSCRIBE_DURATION_CAP_EXCEEDED at the cap boundary. If
// that signal never arrived (relay bug / WS already dropped), a
// transcribe session could run past the cap with no client-side
// auto-stop. The recorder has an alarm-backed autostop; transcribe
// did not. This adds a parallel, distinctly-named alarm as a safety
// net (the relay stays the precise enforcer).
//
// The service worker can't be imported under vitest, so these are
// source-contract tests (same style as the other SW wiring suites).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const sw = readFileSync(
  resolve(here, '../src/background/service-worker.js'),
  'utf8',
);

describe('transcribe duration-cap backstop — wiring', () => {
  it('uses a DISTINCT alarm name from the recording cap (they run simultaneously)', () => {
    expect(sw).toMatch(
      /TRANSCRIBE_DURATION_CAP_AUTOSTOP_ALARM_NAME\s*=\s*\n?\s*'transcribe-duration-cap-autostop'/,
    );
    // Must not reuse the recording alarm name.
    expect(sw).toContain("DURATION_CAP_AUTOSTOP_ALARM_NAME = 'duration-cap-autostop'");
  });

  it('lands AFTER the relay cap via a grace margin (never cuts early)', () => {
    expect(sw).toMatch(/TRANSCRIBE_CAP_BACKSTOP_GRACE_MS\s*=\s*90_000/);
    const fnIdx = sw.indexOf('async function scheduleTranscribeDurationCapAlarm(');
    const fn = sw.slice(fnIdx, fnIdx + 600);
    expect(fn).toMatch(/remainingSeconds \* 1000\s*\+\s*TRANSCRIBE_CAP_BACKSTOP_GRACE_MS/);
    // Clears any prior schedule first (reschedule-safe).
    expect(fn).toMatch(/chrome\.alarms\.clear\(TRANSCRIBE_DURATION_CAP_AUTOSTOP_ALARM_NAME\)/);
    // No-op when there's no cap.
    expect(fn).toMatch(/if \(!capSeconds \|\| capSeconds <= 0\) return;/);
  });

  it('fireTranscribeDurationCapAutostop is idempotent + stops the session', () => {
    const fnIdx = sw.indexOf('async function fireTranscribeDurationCapAutostop(');
    const fn = sw.slice(fnIdx, fnIdx + 500);
    // Idempotent vs the relay path + user stop.
    expect(fn).toMatch(/if \(cur\.state === TranscribeState\.IDLE\) return;/);
    expect(fn).toMatch(/stopTranscribe\(\{ reason: 'duration_cap_exceeded' \}\)/);
  });

  it('armed on transcribe start when cap > 0', () => {
    expect(sw).toMatch(
      /if \(transcribeCap\.maxDurationSeconds > 0\) \{[\s\S]{0,300}scheduleTranscribeDurationCapAlarm\(\{/,
    );
  });

  it('cleared in stopTranscribe', () => {
    const fnIdx = sw.indexOf('async function stopTranscribe(');
    const fn = sw.slice(fnIdx, fnIdx + 400);
    expect(fn).toMatch(/clearTranscribeDurationCapAlarm\(\)/);
  });

  it('frozen on pause, re-armed on resume', () => {
    const pauseIdx = sw.indexOf('async function pauseTranscribe(');
    const pause = sw.slice(pauseIdx, sw.indexOf('async function resumeTranscribe('));
    expect(pause).toMatch(/clearTranscribeDurationCapAlarm\(\)/);
    const resumeIdx = sw.indexOf('async function resumeTranscribe(');
    const resume = sw.slice(resumeIdx, resumeIdx + 1200);
    expect(resume).toMatch(/scheduleTranscribeDurationCapAlarm\(\{/);
  });

  it('dispatched from the onAlarm handler', () => {
    expect(sw).toMatch(
      /alarm\.name === TRANSCRIBE_DURATION_CAP_AUTOSTOP_ALARM_NAME[\s\S]{0,120}fireTranscribeDurationCapAutostop\(\)/,
    );
  });
});
