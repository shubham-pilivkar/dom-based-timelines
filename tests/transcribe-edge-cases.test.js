// Post-audit edge-case wiring tests. Same source-text contract style
// as `important-points.test.js` — we don't run the SW / offscreen /
// overlay for real, just pin the chain so a refactor that breaks one
// of these guards fails here first.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { IMPORTANT_POINTS_MAX } from '../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const swJs = readFileSync(
  resolve(here, '../src/background/service-worker.js'),
  'utf8',
);
const overlayJs = readFileSync(
  resolve(here, '../src/transcribe/overlay.js'),
  'utf8',
);
const popupJs = readFileSync(
  resolve(here, '../src/popup/popup.js'),
  'utf8',
);

// ---- A: SW watchdog detects dead offscreen during transcribe ----------

describe('SW watchdog — dead-offscreen detection', () => {
  it('the transcribe-only branch checks offscreenExists()', () => {
    // The alarm handler used to early-return for transcribe-only
    // sessions with no offscreen-aliveness check. Without this
    // probe, an OOM-killed offscreen would leave the SW state at
    // ACTIVE indefinitely with no transcripts arriving.
    const transcribeOnlyBranchIdx = swJs.indexOf(
      "Transcribe-only — alarm's primary job",
    );
    expect(transcribeOnlyBranchIdx).toBeGreaterThan(-1);
    // The offscreen probe must be inside that branch.
    const probeIdx = swJs.indexOf('await offscreenExists()', transcribeOnlyBranchIdx);
    expect(probeIdx).toBeGreaterThan(-1);
    // …and the failure path must set state to ERROR + clear the alarm
    // so we don't re-trigger every tick.
    const errorState = swJs.indexOf('offscreen_lost', probeIdx);
    expect(errorState).toBeGreaterThan(-1);
    const clearAlarm = swJs.indexOf('clearWatchdogAlarm()', probeIdx);
    expect(clearAlarm).toBeGreaterThan(-1);
    expect(clearAlarm).toBeLessThan(errorState + 200);
  });
});

// ---- C: importantPoints FIFO cap --------------------------------------

describe('SW importantPoints — FIFO cap', () => {
  it('IMPORTANT_POINTS_MAX is exported and sane', () => {
    // Number, not a string. Big enough that real meetings (~50
    // points) never get truncated, small enough to bound storage
    // on a runaway extractor.
    expect(typeof IMPORTANT_POINTS_MAX).toBe('number');
    expect(IMPORTANT_POINTS_MAX).toBeGreaterThanOrEqual(100);
    expect(IMPORTANT_POINTS_MAX).toBeLessThanOrEqual(10_000);
  });

  it('SW imports IMPORTANT_POINTS_MAX from constants', () => {
    expect(swJs).toContain('IMPORTANT_POINTS_MAX');
    // Sanity: must come from the constants module import block, not
    // a stray local literal.
    const importBlock = swJs.slice(0, swJs.indexOf("} from '../constants.js';"));
    expect(importBlock).toContain('IMPORTANT_POINTS_MAX');
  });

  it('IMPORTANT_POINTS_UPDATE merger applies the cap with splice', () => {
    // The cap MUST be applied AFTER the dedup-aware merge and BEFORE
    // the persist, so dropped-oldest-when-overflowing semantics
    // matches a FIFO. The implementation uses Array.splice on
    // ``merged`` — pin the shape so a refactor doesn't accidentally
    // switch to "drop incoming" which would silently lose new
    // points instead of evicting old ones.
    const handlerIdx = swJs.indexOf(
      'case MessageType.IMPORTANT_POINTS_UPDATE:',
    );
    expect(handlerIdx).toBeGreaterThan(-1);
    // Anchor on the persist call inside the handler — the cap code
    // must come BEFORE this, and the empty-batch early-return is
    // BEFORE the merge so anchoring on the persist captures the
    // whole interesting region.
    const sliceEnd = swJs.indexOf(
      'await setTranscribeState({ importantPoints: merged });',
      handlerIdx,
    );
    expect(sliceEnd).toBeGreaterThan(handlerIdx);
    const block = swJs.slice(handlerIdx, sliceEnd);
    expect(block).toContain('IMPORTANT_POINTS_MAX');
    expect(block).toMatch(/merged\.splice\(0,\s*merged\.length\s*-\s*IMPORTANT_POINTS_MAX\)/);
  });
});

// ---- D: Phase E removed the cross-feature mutex ----------------------

describe('startRecording — no cross-feature transcribe lock (Phase E)', () => {
  it('startRecording no longer rejects when transcription is active', () => {
    // Phase E: recording + transcription run simultaneously (separate
    // pipelines in the refcounted shared offscreen doc). The old
    // ``busy_transcribing`` cross-guard inside startRecording is gone;
    // only the same-feature "already recording" guard remains.
    const fnIdx = swJs.indexOf('async function startRecording(');
    expect(fnIdx).toBeGreaterThan(-1);
    const next = swJs.indexOf('\nasync function ', fnIdx + 1);
    const body = swJs.slice(fnIdx, next === -1 ? swJs.length : next);
    expect(body).not.toContain("return { code: 'busy_transcribing'");
  });

  it('the busy_transcribing humanised string is still mapped (defensive)', () => {
    // The SW no longer returns it for the cross-feature case, but the
    // popup keeps the mapping so any other future use still reads
    // cleanly rather than as a raw code.
    expect(popupJs).toContain("data.code === 'busy_transcribing'");
    expect(popupJs).toContain('Live transcription is active');
  });
});

// ---- G: transcribe button stop-path matches its "Stop" label ----------

describe('handleTranscribeClick — stop path covers every "Stop" state', () => {
  it('routes ACTIVE | PAUSED | RECONNECTING to STOP_TRANSCRIBE', () => {
    // Regression: the button is labelled "Stop transcription" for
    // ACTIVE | PAUSED | RECONNECTING (renderTranscribeState), but the
    // click handler used to stop only on ACTIVE. A click while PAUSED
    // fell through to the start path, re-issued START_TRANSCRIBE and
    // the SW rejected it with busy_transcribing ("A transcription
    // session is already active."). The stop guard must cover the
    // same three states the button labels "Stop".
    const fnIdx = popupJs.indexOf('async function handleTranscribeClick(');
    expect(fnIdx).toBeGreaterThan(-1);
    const startPathIdx = popupJs.indexOf('// Start path', fnIdx);
    expect(startPathIdx).toBeGreaterThan(fnIdx);
    // The stop guard sits BEFORE the start path.
    const stopGuard = popupJs.slice(fnIdx, startPathIdx);
    expect(stopGuard).toContain('MessageType.STOP_TRANSCRIBE');
    expect(stopGuard).toContain('TranscribeState.ACTIVE');
    expect(stopGuard).toContain('TranscribeState.PAUSED');
    expect(stopGuard).toContain('TranscribeState.RECONNECTING');
  });
});

// ---- H: clean stop must not populate the transcribe error field -------

describe('SW TRANSCRIBE_LIFECYCLE — stopped is not an error', () => {
  it("only sets error on phase==='error', never on a clean stopped", () => {
    // Regression: "Stop live transcription" showed "Error: client_stop"
    // because the lifecycle handler wrote ``error: message.reason`` for
    // BOTH stopped and error phases. The stopped path must null error.
    const caseIdx = swJs.indexOf('case MessageType.TRANSCRIBE_LIFECYCLE:');
    expect(caseIdx).toBeGreaterThan(-1);
    const next = swJs.indexOf('\n    case MessageType.', caseIdx + 1);
    const body = swJs.slice(caseIdx, next === -1 ? swJs.length : next);
    // The setTranscribeState for stopped|error must gate the reason on
    // the error phase, not assign it unconditionally.
    expect(body).toContain("message.phase === 'stopped' || message.phase === 'error'");
    expect(body).toContain(
      "error: message.phase === 'error' ? (message.reason ?? null) : null",
    );
    expect(body).not.toContain('error: message.reason ?? null,');
  });
});

// ---- I: overlay mounts ONLY for an active transcription session -------

describe('overlay — session gate (no recording-only leak)', () => {
  it('handleEvent bails before ensureOverlay when no session active', () => {
    // The overlay content script is injected on every Meet/Teams page
    // (shared manifest match with the recording tile detector). A
    // transcript/points message must not mount the panel unless a
    // transcription session was started in this tab.
    const fnIdx = overlayJs.indexOf('function handleEvent(');
    expect(fnIdx).toBeGreaterThan(-1);
    const ensureIdx = overlayJs.indexOf('ensureOverlay()', fnIdx);
    const preamble = overlayJs.slice(fnIdx, ensureIdx);
    expect(preamble).toContain('if (!transcribeSessionActive) return;');
  });

  it('transcribeSessionActive is set true ONLY in the started phase', () => {
    expect(overlayJs).toContain('let transcribeSessionActive = false;');
    // Exactly one assignment to true, and it lives right under the
    // started-phase branch.
    const trueAssigns = overlayJs.match(/transcribeSessionActive = true/g) || [];
    expect(trueAssigns.length).toBe(1);
    const startedIdx = overlayJs.indexOf("if (message.phase === 'started') {");
    const trueIdx = overlayJs.indexOf('transcribeSessionActive = true');
    expect(trueIdx).toBeGreaterThan(startedIdx);
    expect(trueIdx - startedIdx).toBeLessThan(200);
  });

  it('the gate is cleared on stopped (via enterStoppedState) and on removeOverlay', () => {
    // Phase D — the stopped branch no longer tears the panel down; it
    // calls enterStoppedState(), which is where the session gate is
    // now dropped (and again in removeOverlay as a backstop).
    const stoppedIdx = overlayJs.indexOf("} else if (message.phase === 'stopped') {");
    expect(stoppedIdx).toBeGreaterThan(-1);
    expect(
      overlayJs.slice(stoppedIdx, stoppedIdx + 420),
    ).toContain('enterStoppedState(message.reason)');
    const esIdx = overlayJs.indexOf('function enterStoppedState');
    expect(esIdx).toBeGreaterThan(-1);
    expect(
      overlayJs.slice(esIdx, esIdx + 160),
    ).toContain('transcribeSessionActive = false;');
    const rmIdx = overlayJs.indexOf('function removeOverlay');
    expect(
      overlayJs.slice(rmIdx, rmIdx + 400),
    ).toContain('transcribeSessionActive = false;');
  });

  it('IMPORTANT_POINTS_UPDATE is gated on an active session', () => {
    const ipIdx = overlayJs.indexOf('MessageType.IMPORTANT_POINTS_UPDATE');
    const block = overlayJs.slice(ipIdx, ipIdx + 400);
    expect(block).toContain('transcribeSessionActive && Array.isArray(message.points)');
  });
});

// ---- E: overlay clears partialFlushTimer on reconnect ----------------

describe('overlay — partialFlushTimer cleared on reconnect', () => {
  it('the isReconnect branch clears the debounce timer', () => {
    const reconnectBlockIdx = overlayJs.indexOf('if (message.isReconnect)');
    expect(reconnectBlockIdx).toBeGreaterThan(-1);
    const elseIdx = overlayJs.indexOf('} else {', reconnectBlockIdx);
    const block = overlayJs.slice(reconnectBlockIdx, elseIdx);
    expect(block).toContain('partialBySpeaker.clear()');
    expect(block).toContain('clearTimeout(partialFlushTimer)');
    expect(block).toContain('partialFlushTimer = null');
  });
});

// ---- B: reconnect chain — parent_session_id wire-through --------------

describe('SW reconnect — parent_session_id linkage', () => {
  it('refreshTranscribeReconnectUrl passes the current sessionId', () => {
    const fnIdx = swJs.indexOf('async function refreshTranscribeReconnectUrl');
    expect(fnIdx).toBeGreaterThan(-1);
    const next = swJs.indexOf('\nasync function ', fnIdx + 1);
    const body = swJs.slice(fnIdx, next === -1 ? swJs.length : next);
    // The startTranscribeSession call inside this function must
    // include ``parent_session_id`` (or the chain stays broken even
    // when the backend supports it).
    expect(body).toContain('startTranscribeSession');
    expect(body).toContain('parent_session_id');
    expect(body).toContain('cur.sessionId');
  });
});
