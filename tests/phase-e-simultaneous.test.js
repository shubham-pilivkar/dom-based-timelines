// Phase E — recording and live-transcription may run simultaneously.
// Source-contract tests: the offscreen doc is refcounted (closed only
// when BOTH features are idle), the cross-feature mutex is gone, and
// the popup shows both sessions at once.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const sw = readFileSync(resolve(here, '../src/background/service-worker.js'), 'utf8');
const popupHtml = readFileSync(resolve(here, '../src/popup/popup.html'), 'utf8');
const popupJs = readFileSync(resolve(here, '../src/popup/popup.js'), 'utf8');

describe('Phase E — offscreen refcount (close only when both idle)', () => {
  it('destroyOffscreenIfIdle checks BOTH state machines', () => {
    const i = sw.indexOf('async function destroyOffscreenIfIdle()');
    expect(i).toBeGreaterThan(-1);
    const fn = sw.slice(i, i + 900);
    expect(fn).toContain('getState()');
    expect(fn).toContain('getTranscribeState()');
    expect(fn).toContain('if (recBusy || trBusy) return;');
    expect(fn).toContain('await destroyOffscreen();');
  });

  it('feature teardown paths use the refcounted variant', () => {
    // The bare destroyOffscreen() must only appear inside the helper
    // itself + the helper's own definition target. Every feature
    // teardown path goes through destroyOffscreenIfIdle so stopping
    // one feature can't kill the doc the other still needs.
    const bare = sw.match(/await destroyOffscreen\(\);/g) || [];
    // Exactly one bare call — the one inside destroyOffscreenIfIdle.
    expect(bare.length).toBe(1);
    const guarded = sw.match(/await destroyOffscreenIfIdle\(\);/g) || [];
    expect(guarded.length).toBeGreaterThanOrEqual(4);
  });
});

describe('Phase E — cross-feature mutex removed', () => {
  it('startTranscribe no longer rejects when a recording is active', () => {
    const i = sw.indexOf('async function startTranscribe(');
    const fn = sw.slice(i, sw.indexOf('\nasync function ', i + 1));
    // The same-feature guard stays…
    expect(fn).toContain("code: 'busy_transcribing'");
    // …but the recording cross-guard is gone.
    expect(fn).not.toContain("code: 'busy_recording'");
  });

  it('startRecording no longer rejects when transcription is active', () => {
    const i = sw.indexOf('async function startRecording(');
    const fn = sw.slice(i, sw.indexOf('\nasync function ', i + 1));
    expect(fn).not.toContain("return { code: 'busy_transcribing'");
  });

  it('START_TRANSCRIBE message handler dropped the busy_recording pre-check', () => {
    const i = sw.indexOf('case MessageType.START_TRANSCRIBE:');
    const block = sw.slice(i, i + 2400);
    expect(block).not.toContain("code: 'busy_recording'");
    // same-feature guard still present
    expect(block).toContain("code: 'busy_transcribing'");
  });
});

describe('Phase E — unified popup shows both sessions', () => {
  it('declares the always-visible dual-session strip', () => {
    expect(popupHtml).toContain('id="sessions-strip"');
    expect(popupHtml).toContain('id="sess-rec-state"');
    expect(popupHtml).toContain('id="sess-tr-state"');
    expect(popupHtml).toContain('id="sess-rec-dot"');
    expect(popupHtml).toContain('id="sess-tr-dot"');
  });

  it('renderSessionsStrip reads both state machines and is called by both renderers', () => {
    expect(popupJs).toContain('function renderSessionsStrip()');
    const fn = popupJs.slice(
      popupJs.indexOf('function renderSessionsStrip()'),
      popupJs.indexOf('function renderSessionsStrip()') + 1900,
    );
    expect(fn).toContain('lastState');
    expect(fn).toContain('lastTranscribeState');
    expect(fn).toContain('RecordingState.RECORDING');
    expect(fn).toContain('TranscribeState.ACTIVE');
    // Called from both render paths so it stays in sync with whichever
    // side just changed.
    const renderIdx = popupJs.indexOf('function render(state) {');
    expect(popupJs.slice(renderIdx, renderIdx + 400))
      .toContain('renderSessionsStrip()');
    const trIdx = popupJs.indexOf('function renderTranscribeState(state) {');
    expect(popupJs.slice(trIdx, trIdx + 200))
      .toContain('renderSessionsStrip()');
  });
});
