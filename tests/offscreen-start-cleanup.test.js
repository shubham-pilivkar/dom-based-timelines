// Fix 1 — handleStart partial-acquisition stream leak.
//
// handleStart acquires the capture + mic MediaStreams and builds the
// mixer/AudioContext BEFORE later awaits that can throw (mixer.ready,
// E2EE keygen, pickRecorder for an unsupported mime, recorder.start).
// Before this fix a throw past acquisition left live MediaStreamTracks
// and a running AudioContext leaking until the whole offscreen doc was
// torn down. The fix hoists the resources and wraps the start body in
// try/catch that disposes them on any pre-session failure.
//
// The real capture APIs can't run under vitest/jsdom, so this is a
// source-contract test (same style as screen-capture.test.js /
// transcribe-mode-3-both.test.js): pin the wiring so a refactor that
// re-opens the leak fails here first.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const offscreen = readFileSync(
  resolve(here, '../src/offscreen/offscreen.js'),
  'utf8',
);

describe('handleStart — partial-acquisition cleanup', () => {
  it('defines a shared _disposeCaptureResources helper', () => {
    expect(offscreen).toMatch(/function _disposeCaptureResources\(\{ capture, mic, mixer, silenceCtx \}\)/);
    // It must best-effort dispose the mixer + stop both stream's tracks
    // + close the silent-fallback context.
    const fnIdx = offscreen.indexOf('function _disposeCaptureResources(');
    const fn = offscreen.slice(fnIdx, fnIdx + 600);
    expect(fn).toMatch(/mixer\.dispose\(\)/);
    expect(fn).toMatch(/capture\.getTracks\(\)/);
    expect(fn).toMatch(/mic\.getTracks\(\)/);
    expect(fn).toMatch(/silenceCtx\.close\(\)/);
  });

  it('hoists the acquired resources so the catch can reach them', () => {
    const start = offscreen.indexOf('async function handleStart(');
    const region = offscreen.slice(start, start + 900);
    // Resources are declared with let (not const inside the try) so the
    // catch at the end can dispose them.
    expect(region).toMatch(/let capture = null;/);
    expect(region).toMatch(/let mic = null;/);
    expect(region).toMatch(/let mixer = null;/);
    expect(region).toMatch(/let silenceCtx = null;/);
  });

  it('wraps the acquisition span and disposes orphaned resources on throw', () => {
    const start = offscreen.indexOf('async function handleStart(');
    const end = offscreen.indexOf('async function rotateAudioContext(');
    const fn = offscreen.slice(start, end);
    // A catch that disposes the orphaned resources, then rethrows so the
    // SW surfaces the failure to the user.
    expect(fn).toMatch(/catch \(err\) \{[\s\S]{0,300}_disposeCaptureResources\(\{ capture, mic, mixer, silenceCtx \}\)/);
    // Must rethrow — swallowing would leave the SW thinking start
    // succeeded.
    expect(fn).toMatch(/_disposeCaptureResources\([\s\S]{0,120}throw err;/);
  });

  it('handleStop still tears the SAME resource set down on the happy path', () => {
    // Defence against drift: the post-session teardown must cover the
    // same resources the pre-session cleanup does.
    const stopIdx = offscreen.indexOf('async function handleStop(');
    const stop = offscreen.slice(stopIdx, stopIdx + 1200);
    expect(stop).toMatch(/s\.mixer\.dispose\(\)/);
    expect(stop).toMatch(/s\.capture\.getTracks\(\)/);
    expect(stop).toMatch(/s\.mic\.getTracks\(\)/);
    expect(stop).toMatch(/s\.silenceCtx/);
  });
});
