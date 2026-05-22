// Phase B — modes "participants" / "you+others" must (a) keep the
// meeting audible (tabCapture mutes the source tab unless the stream
// is re-emitted) and (b) reliably show the overlay. Source-level
// contract tests, same pattern as the other transcribe suites.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const offscreenHtml = readFileSync(resolve(here, '../src/offscreen/offscreen.html'), 'utf8');
const transcribeJs = readFileSync(resolve(here, '../src/offscreen/transcribe.js'), 'utf8');
const swJs = readFileSync(resolve(here, '../src/background/service-worker.js'), 'utf8');

describe('Phase B — tab-audio passthrough', () => {
  it('offscreen.html has a dedicated transcribe tab monitor element', () => {
    expect(offscreenHtml).toContain('id="transcribe-tab-monitor"');
    // Must be distinct from the recording monitor so the two features
    // can run together (Phase E) without fighting over one element.
    expect(offscreenHtml).toContain('id="tab-monitor"');
  });

  it('_isTabSourced is mic-safe (never monitors the mic substream)', () => {
    expect(transcribeJs).toContain('function _isTabSourced(');
    const fn = transcribeJs.slice(
      transcribeJs.indexOf('function _isTabSourced('),
      transcribeJs.indexOf('function _isTabSourced(') + 260,
    );
    expect(fn).toContain("role === 'tab'");
    expect(fn).toContain("role === 'mic'"); // explicit mic → false
    expect(fn).toContain("mode === 'participants'");
  });

  it('attaches the captured tab stream to the monitor element', () => {
    expect(transcribeJs).toContain("_isTabSourced({ role, mode })");
    expect(transcribeJs).toContain("getElementById('transcribe-tab-monitor')");
    expect(transcribeJs).toContain('monitorEl.srcObject = mediaStream');
  });

  it('detaches the monitor on teardown before stopping tracks', () => {
    const tdIdx = transcribeJs.indexOf('s.monitorEl.srcObject = null');
    expect(tdIdx).toBeGreaterThan(-1);
    const stopIdx = transcribeJs.indexOf(
      's.mediaStream.getTracks().forEach((t) => t.stop())',
    );
    expect(stopIdx).toBeGreaterThan(tdIdx); // detach precedes stop
  });
});

describe('Phase B — overlay mounts immediately for every mode', () => {
  it('mounts the overlay (Bug 4: at STARTING, before the WS round-trip)', () => {
    const fnIdx = swJs.indexOf('async function startTranscribe(');
    const handoffIdx = swJs.indexOf('OFFSCREEN_TRANSCRIBE_START', fnIdx);
    const pre = swJs.slice(fnIdx, handoffIdx);
    // Mounted via the dedicated helper before the offscreen handoff
    // so modes participants/both don't sit blank.
    expect(pre).toContain('mountTranscribeOverlay(tabId, mode)');
    // The helper itself broadcasts an SW-originated 'started'.
    const helper = swJs.slice(
      swJs.indexOf('async function mountTranscribeOverlay('),
      swJs.indexOf('async function unmountTranscribeOverlay('),
    );
    expect(helper).toMatch(/phase: 'started'[\s\S]*isReconnect: false/);
    expect(helper).toContain('sendToTab(tabId,');
  });

  it('SW tears the overlay back down if the start fails', () => {
    const fnIdx = swJs.indexOf('async function startTranscribe(');
    const fnEnd = swJs.indexOf('\nasync function ', fnIdx + 1);
    const fnBody = swJs.slice(fnIdx, fnEnd === -1 ? swJs.length : fnEnd);
    const failIdx = fnBody.indexOf('if (!started) {');
    expect(failIdx).toBeGreaterThan(-1);
    const block = fnBody.slice(failIdx, failIdx + 1200);
    expect(block).toContain('unmountTranscribeOverlay(tabId, lastErr)');
  });
});
