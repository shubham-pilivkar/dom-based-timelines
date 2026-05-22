// Spec: the extension must support "Screen sharing" + "System audio"
// recording, not just chrome.tabCapture (meeting/tab audio). This adds
// an opt-in CaptureSource.SCREEN path via chrome.desktopCapture that
// mirrors the existing tabCapture streamId architecture. Same
// source-text contract style as transcribe-mode-3-both.test.js — the
// real capture APIs can't run under vitest/jsdom, so we pin the
// wiring so a refactor that breaks the screen path fails here first.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CaptureSource, StorageKey } from '../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), 'utf8');
const swJs = read('../src/background/service-worker.js');
const offscreenJs = read('../src/offscreen/offscreen.js');
const mixerJs = read('../src/lib/audio-mixer.js');
const optionsJs = read('../src/options/options.js');
const optionsHtml = read('../src/options/options.html');
const manifest = JSON.parse(read('../manifest.json'));

describe('CaptureSource — constants', () => {
  it('exposes tab + screen with tab as the default value', () => {
    expect(CaptureSource.TAB).toBe('tab');
    expect(CaptureSource.SCREEN).toBe('screen');
    expect(StorageKey.CAPTURE_SOURCE).toBe('mm_capture_source');
  });
});

describe('manifest — least privilege (no desktopCapture)', () => {
  it('keeps tabCapture but NOT desktopCapture', () => {
    // MV3-correct screen capture uses getDisplayMedia() in the
    // offscreen doc, which requires no extension permission. A
    // service-worker desktopCapture streamId can't be consumed by an
    // offscreen document, so that permission (and API) was removed.
    expect(manifest.permissions).toContain('tabCapture');
    expect(manifest.permissions).not.toContain('desktopCapture');
  });
});

describe('service worker — screen via offscreen getDisplayMedia', () => {
  it('declares the offscreen DISPLAY_MEDIA reason (+ USER_MEDIA)', () => {
    expect(swJs).toMatch(
      /reasons:\s*\[\s*'USER_MEDIA',\s*'DISPLAY_MEDIA'\s*\]/,
    );
  });

  it('no longer uses chrome.desktopCapture at all', () => {
    expect(swJs).not.toContain('chrome.desktopCapture');
    expect(swJs).not.toContain('function getDesktopStreamId(');
  });

  it('routes on CAPTURE_SOURCE; tab mints a streamId, screen does not', () => {
    expect(swJs).toContain('StorageKey.CAPTURE_SOURCE');
    expect(swJs).toContain('await getMediaStreamId(tabId)');
    // Screen path: streamId stays null, offscreen does getDisplayMedia.
    expect(swJs).toContain("if (captureSource !== 'screen')");
    expect(swJs).toMatch(/type:\s*MessageType\.OFFSCREEN_START[\s\S]*?captureSource/);
  });
});

describe('offscreen — getDisplayMedia screen path + mixer invariant', () => {
  it('acquires the screen via getDisplayMedia (no SW streamId)', () => {
    expect(offscreenJs).toContain('async function getDesktopStream(');
    expect(offscreenJs).toContain('navigator.mediaDevices.getDisplayMedia(');
    expect(offscreenJs).not.toContain("chromeMediaSource: 'desktop'");
    expect(offscreenJs).toContain(
      "const isScreen = captureSource === 'screen';",
    );
    // Called with no argument now (offscreen owns the picker).
    expect(offscreenJs).toContain('await getDesktopStream()');
  });

  it('substitutes a silent track when the share has no audio', () => {
    // AudioMixer.createMediaStreamSource throws on a zero-track
    // stream; the helper keeps the pipeline shape identical.
    expect(offscreenJs).toContain('function deriveCaptureAudioStream(');
    expect(offscreenJs).toContain('createMediaStreamDestination()');
    expect(offscreenJs).toContain('silenceCtx');
    // Teardown must close the synthesized context.
    expect(offscreenJs).toContain('await s.silenceCtx.close()');
  });

  it('disables the echo-prone monitor on the screen path', () => {
    // Both the initial mixer and the rotation mixer.
    const matches = offscreenJs.match(/monitorEnabled:\s*!(?:is|old\.is)Screen/g)
      || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('rotation reuses the persisted audio stream', () => {
    expect(offscreenJs).toContain('const tabAudioStream = old.tabAudioStream;');
  });
});

describe('audio-mixer — monitorEnabled opt-out', () => {
  it('defaults monitorEnabled true and guards _attachMonitor', () => {
    expect(mixerJs).toContain('monitorEnabled = true');
    expect(mixerJs).toContain('if (!this.monitorEnabled)');
  });
});

describe('options page — capture source control', () => {
  it('has the select and load/save wiring', () => {
    expect(optionsHtml).toContain('id="capture-source"');
    expect(optionsHtml).toContain('value="screen"');
    expect(optionsJs).toContain('StorageKey.CAPTURE_SOURCE');
    expect(optionsJs).toContain("captureSource.value === 'screen'");
  });
});
