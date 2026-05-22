// Contract tests for the detached recording-control window wiring.
// Mirrors the popup-visibility.test.js approach: pin the cross-file
// wiring (constants ↔ SW ↔ popup ↔ build) so a rename can't silently
// orphan the feature. Behaviour of control-window.js itself is
// covered by control-window.test.js.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MessageType, StorageKey } from '../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), 'utf8');

const ctlHtml = read('../src/control/control.html');
const ctlJs = read('../src/control/control.js');
const swJs = read('../src/background/service-worker.js');
const popupHtml = read('../src/popup/popup.html');
const popupJs = read('../src/popup/popup.js');
const viteCfg = read('../vite.config.js');

describe('constants', () => {
  it('exposes the new control-window keys', () => {
    expect(MessageType.FOCUS_CONTROL_WINDOW).toBe('FOCUS_CONTROL_WINDOW');
    expect(StorageKey.CONTROL_WINDOW_ID).toBe('mm_control_window_id');
  });
});

describe('control window page', () => {
  it('has the level meters, duration, pause and stop controls', () => {
    expect(ctlHtml).toContain('id="level-mic-fill"');
    expect(ctlHtml).toContain('id="level-tab-fill"');
    expect(ctlHtml).toContain('id="elapsed"');
    expect(ctlHtml).toContain('id="pause"');
    expect(ctlHtml).toContain('id="stop"');
    expect(ctlHtml).toContain('src="./control.js"');
  });

  it('subscribes to STATE_UPDATE + LEVEL_UPDATE and self-closes', () => {
    expect(ctlJs).toContain('MessageType.STATE_UPDATE');
    expect(ctlJs).toContain('MessageType.LEVEL_UPDATE');
    expect(ctlJs).toContain('MessageType.STOP_RECORDING');
    expect(ctlJs).toContain('MessageType.USER_PAUSE');
    expect(ctlJs).toContain('MessageType.USER_RESUME');
    expect(ctlJs).toContain('window.close()');
  });
});

describe('service worker wiring', () => {
  it('opens the control window when recording goes live', () => {
    expect(swJs).toContain("from '../lib/control-window.js'");
    expect(swJs).toContain('await openControlWindow()');
  });

  it('closes it on finalize and clears tracking on window removal', () => {
    expect(swJs).toContain('await closeControlWindow()');
    expect(swJs).toContain('chrome.windows.onRemoved.addListener');
    expect(swJs).toContain('handleWindowRemoved');
  });

  it('handles FOCUS_CONTROL_WINDOW from the popup', () => {
    expect(swJs).toContain('case MessageType.FOCUS_CONTROL_WINDOW');
  });
});

describe('popup reset-while-active', () => {
  it('has the slim "Open controls" affordance', () => {
    expect(popupHtml).toContain('id="control-active-row"');
    expect(popupHtml).toContain('id="open-controls"');
  });

  it('neutralises the session surface while control-owned', () => {
    expect(popupJs).toContain('applyControlOwnedView');
    expect(popupJs).toContain('isControlOwned');
    expect(popupJs).toContain('MessageType.FOCUS_CONTROL_WINDOW');
  });
});

describe('build', () => {
  it('registers control.html as a rollup input', () => {
    expect(viteCfg).toContain("control: 'src/control/control.html'");
  });
});
