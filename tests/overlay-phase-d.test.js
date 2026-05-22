// Phase D — overlay UX: discoverable single-axis resize, a Copy
// button, and a Stop→Close lifecycle (the panel no longer vanishes
// on stop). Source-contract tests (no AudioWorklet/shadow DOM in
// vitest), same pattern as the other overlay suites.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const o = readFileSync(resolve(here, '../src/transcribe/overlay.js'), 'utf8');

describe('overlay — discoverable resize grips exist (superseded by Bug 5)', () => {
  it('still builds the left/top/corner grips', () => {
    expect(o).toContain("_mk('div', 'resize-handle'");
    expect(o).toContain("_mk('div', 'resize-edge-x'");
    expect(o).toContain("_mk('div', 'resize-edge-y'");
  });

  it('declares discoverable edge styling + axis cursors', () => {
    expect(o).toContain('.resize-edge-x {');
    expect(o).toContain('.resize-edge-y {');
    expect(o).toContain('cursor: ew-resize');
    expect(o).toContain('cursor: ns-resize');
    expect(o).toContain('.panel.minimized .resize-edge-x');
  });
});

describe('Phase D — copy to clipboard', () => {
  it('has a Copy button wired to copyTranscript', () => {
    expect(o).toContain("_mk('button', 'icon-btn copy-btn'");
    expect(o).toContain('void copyTranscript(copyBtn)');
    expect(o).toContain('async function copyTranscript(');
  });

  it('copies finals + important points and has an execCommand fallback', () => {
    // Window widened from 1400 → 1800 chars to cover the speaker-
    // resolver promotion added in Bug 3E (a comment + a resolver call
    // pushed the "Copied" feedback past the previous bound).
    const fn = o.slice(
      o.indexOf('async function copyTranscript('),
      o.indexOf('async function copyTranscript(') + 1800,
    );
    expect(fn).toContain('navigator.clipboard.writeText');
    expect(fn).toContain("document.execCommand('copy')");
    expect(fn).toContain('Important points:');
    expect(fn).toContain("btn.textContent = 'Copied'");
  });
});

describe('Phase D — Stop → Close lifecycle (no auto-teardown)', () => {
  it('Stop button asks the SW to stop and enters the stopped state', () => {
    expect(o).toContain("_mk('button', 'icon-btn stop-btn'");
    const stopWire = o.slice(
      o.indexOf("stopBtn.addEventListener('click'"),
      o.indexOf("stopBtn.addEventListener('click'") + 700,
    );
    expect(stopWire).toContain('MessageType.STOP_TRANSCRIBE');
    expect(stopWire).toContain("enterStoppedState('client_stop')");
  });

  it('the stopped lifecycle no longer calls removeOverlay directly', () => {
    const stoppedIdx = o.indexOf("} else if (message.phase === 'stopped') {");
    const block = o.slice(stoppedIdx, stoppedIdx + 420);
    expect(block).toContain('enterStoppedState(message.reason)');
    expect(block).not.toContain('removeOverlay()');
  });

  it('enterStoppedState shows Close, hides Stop, keeps the transcript', () => {
    const fn = o.slice(
      o.indexOf('function enterStoppedState('),
      o.indexOf('function enterStoppedState(') + 1200,
    );
    expect(fn).toContain("closeBtn.classList.remove('hidden')");
    expect(fn).toContain("stopBtn.classList.add('hidden')");
    // The one auto-remove case: a non-benign stop with no transcript.
    expect(fn).toContain('!hasContent && !_isBenignStop(reason)');
    expect(fn).toContain('removeOverlay()');
  });

  it('Close button stops the session AND tears the overlay down', () => {
    const closeWire = o.slice(
      o.indexOf("closeBtn.addEventListener('click'"),
      o.indexOf("closeBtn.addEventListener('click'") + 900,
    );
    // Closing the window must free the backend WS + reset SW state
    // (idempotent if already stopped) so the next Start is immediate.
    expect(closeWire).toContain('MessageType.STOP_TRANSCRIBE');
    expect(closeWire).toContain('removeOverlay()');
  });

  it('a fresh (non-reconnect) session resets the stopped chrome', () => {
    expect(o).toContain('function resetOverlayForNewSession(');
    const fn = o.slice(
      o.indexOf('function resetOverlayForNewSession('),
      // Widened 500 → 900: the function now clears finalRowByTurn (with
      // its rationale comment) before the shadowRoot guard, pushing the
      // chrome-reset statements further down.
      o.indexOf('function resetOverlayForNewSession(') + 900,
    );
    expect(fn).toContain("panel.classList.remove('stopped')");
    expect(fn).toContain("stopBtn.classList.remove('hidden')");
    expect(fn).toContain("closeBtn.classList.add('hidden')");
  });
});
