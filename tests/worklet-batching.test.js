// Phase L2 (item g) — source-level test for the AudioWorklet's PCM
// batching. AudioWorkletGlobalScope is unavailable in jsdom, so we
// can't instantiate the processor. Instead we verify the wiring in
// the source — same pattern as the popup-visibility tests.
//
// What we want to catch:
//
//   1. BATCH_TARGET_MS exists and sits in the 100-250ms band every
//      cloud provider recommends. A regression that drops it back to
//      per-quantum emission (~2.67ms) would tank provider perf.
//   2. BATCH_TARGET_SAMPLES is derived from TARGET_SAMPLE_RATE and
//      BATCH_TARGET_MS (not a magic number that could drift).
//   3. The batch buffer + fill index are stamped on the processor.
//   4. process() appends to the buffer + flushes only when full.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const workletJs = readFileSync(
  resolve(here, '../public/transcribe-worklet.js'),
  'utf8',
);

describe('AudioWorklet PCM batching (Phase L2 item g)', () => {
  it('declares BATCH_TARGET_MS in the provider-recommended 100-250ms band', () => {
    // Extract the numeric literal so a typo (e.g. 12000) shows up here.
    const m = workletJs.match(/BATCH_TARGET_MS\s*=\s*(\d+)/);
    expect(m, 'BATCH_TARGET_MS constant missing').not.toBeNull();
    const ms = Number(m[1]);
    expect(ms).toBeGreaterThanOrEqual(100);
    expect(ms).toBeLessThanOrEqual(250);
  });

  it('derives BATCH_TARGET_SAMPLES from sample rate × ms (not a magic literal)', () => {
    // Verify the expression form rather than the computed value so a
    // future sample-rate change doesn't break this test.
    expect(workletJs).toMatch(
      /BATCH_TARGET_SAMPLES\s*=\s*Math\.round\(\s*TARGET_SAMPLE_RATE\s*\*\s*BATCH_TARGET_MS\s*\/\s*1000/,
    );
  });

  it('allocates the batch buffer + tracks fill index on the processor', () => {
    expect(workletJs).toContain('this._batch = new Int16Array(BATCH_TARGET_SAMPLES)');
    expect(workletJs).toContain('this._batchFill = 0');
  });

  it('flushes a postMessage only when the batch is full', () => {
    // The flush guard reads as "if (this._batchFill >= BATCH_TARGET_SAMPLES)"
    // — make sure neither a typo (e.g. ``> 0``) nor a refactor removes it.
    expect(workletJs).toContain(
      'if (this._batchFill >= BATCH_TARGET_SAMPLES)',
    );
    // And the flushed buffer is sized by the actual fill (handles
    // the future case where flush triggers exactly at the boundary).
    expect(workletJs).toContain('this._batchFill * 2');
  });

  it('uses typed-array .set() for the bulk copy (not a per-element loop)', () => {
    // Per-element copy in a render-thread tight loop is the obvious
    // wrong pattern. .set() is hardware-accelerated. Pin the choice.
    expect(workletJs).toContain('this._batch.set(out.subarray(srcIdx, srcIdx + toCopy)');
  });

  it('still posts a "pcm" typed message (wire-format contract unchanged)', () => {
    // The offscreen/transcribe.js handler keys on ``msg.type === 'pcm'``
    // so a rename here would silently break the audio pipeline.
    expect(workletJs).toContain("type: 'pcm', buffer: transferable");
  });
});
