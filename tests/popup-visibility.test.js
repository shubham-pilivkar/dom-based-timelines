// Contract tests for the Phase U2 visibility additions. We can't
// easily run the popup through a full DOM in vitest, but we CAN pin
// the wiring: element IDs match between HTML and JS, render logic
// references the right state fields, telemetry interceptors mirror
// the documented event names into state.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TELEMETRY_EVENT_NAMES } from '../src/constants.js';


const here = dirname(fileURLToPath(import.meta.url));
const popupHtml = readFileSync(resolve(here, '../src/popup/popup.html'), 'utf8');
const popupJs = readFileSync(resolve(here, '../src/popup/popup.js'), 'utf8');
const popupCss = readFileSync(resolve(here, '../src/popup/popup.css'), 'utf8');
const swJs = readFileSync(
  resolve(here, '../src/background/service-worker.js'),
  'utf8',
);


describe('popup.html — Phase U2 elements present', () => {
  it('includes the encryption indicator next to the state pill', () => {
    expect(popupHtml).toContain('id="encrypt-indicator"');
  });

  it('includes the heap row + value', () => {
    expect(popupHtml).toContain('id="heap-row"');
    expect(popupHtml).toContain('id="heap-value"');
  });

  it('includes the recap toast container', () => {
    expect(popupHtml).toContain('id="recap-toast"');
    expect(popupHtml).toContain('id="recap-message"');
  });

  it('includes the VAD row inside the transcribe panel', () => {
    expect(popupHtml).toContain('id="transcribe-vad-row"');
    expect(popupHtml).toContain('id="transcribe-vad-value"');
  });
});


describe('popup.js — Phase U2 wiring', () => {
  it('looks up every Phase U2 element ID via the els map', () => {
    // Each ID in the HTML must have a matching getElementById in JS;
    // grep is sufficient since the els map is the only access point.
    expect(popupJs).toContain("$('encrypt-indicator')");
    expect(popupJs).toContain("$('heap-row')");
    expect(popupJs).toContain("$('heap-value')");
    expect(popupJs).toContain("$('recap-toast')");
    expect(popupJs).toContain("$('recap-message')");
    expect(popupJs).toContain("$('transcribe-vad-row')");
    expect(popupJs).toContain("$('transcribe-vad-value')");
  });

  it('renders the encryption indicator from state.isEncrypted', () => {
    expect(popupJs).toContain('state.isEncrypted');
    expect(popupJs).toContain('encryptIndicator.classList.toggle');
  });

  it('renders heap value only when state.heapMb >= 100 (first watermark)', () => {
    // Pin the threshold so a tuning regression below 100 doesn't
    // start spamming an idle / quiet recording with the indicator.
    expect(popupJs).toMatch(/state\.heapMb\s*>=\s*100/);
  });

  it('reads state.vadDroppedPct on the transcribe panel render path', () => {
    expect(popupJs).toContain('state.vadDroppedPct');
    expect(popupJs).toContain('silence skipped');
  });

  it('fires the recap toast only on RECORDING → IDLE transition', () => {
    // The transition guard prevents a stale "Saved" beat on every
    // popup re-open (which calls render() with the current state).
    expect(popupJs).toContain('prevState === RecordingState.RECORDING');
    expect(popupJs).toContain('state.state === RecordingState.IDLE');
  });
});


describe('popup.css — Phase U2 styles defined', () => {
  it('defines .encrypt-pill + hidden state', () => {
    expect(popupCss).toContain('.encrypt-pill');
    expect(popupCss).toContain('.encrypt-pill.hidden');
  });

  it('defines .hint-row used by VAD + heap rows', () => {
    expect(popupCss).toContain('.hint-row');
  });

  it('defines .recap-toast with hidden state', () => {
    expect(popupCss).toContain('.recap-toast');
    expect(popupCss).toContain('.recap-toast.hidden');
  });
});


describe('service-worker.js — telemetry interceptors mirror to state', () => {
  it('matches vad_stats events and writes state.vadDroppedPct', () => {
    // The interceptor lives inside the TELEMETRY_EVENT case. We grep
    // the surrounding text so a regression that drops the match
    // surfaces here.
    expect(swJs).toContain('TELEMETRY_EVENT_NAMES.VAD_STATS');
    expect(swJs).toContain('vadDroppedPct');
  });

  it('matches heap_high_water_mark events and writes state.heapMb', () => {
    expect(swJs).toContain('TELEMETRY_EVENT_NAMES.HEAP_HIGH_WATER_MARK');
    expect(swJs).toContain('heapMb');
  });

  it('telemetry-event names referenced by interceptor are in the allowlist', () => {
    // Sanity-check the allowlist hasn't drifted. The popup's UI
    // signal is silently dropped if the allowlist drops the names.
    expect(TELEMETRY_EVENT_NAMES.VAD_STATS).toBe('vad_stats');
    expect(TELEMETRY_EVENT_NAMES.HEAP_HIGH_WATER_MARK).toBe('heap_high_water_mark');
  });
});
