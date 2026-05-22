// Contract tests for the worklet-side VAD. The worklet code itself
// can only run inside an AudioWorkletGlobalScope, which vitest can't
// host. We pin the public contract instead: the message types the
// worklet emits (``init``, ``pcm``, ``vad_stats``), the field shapes
// the offscreen handler reads, and the constants the deployed config
// depends on. A real-world regression in the inline VAD math would
// surface via the integration manual-test on a meeting recording;
// these tests catch typos and structural drift.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';


const here = dirname(fileURLToPath(import.meta.url));
const workletSrc = readFileSync(
  resolve(here, '../public/transcribe-worklet.js'),
  'utf8',
);


describe('worklet VAD contract', () => {
  it('emits the documented message types', () => {
    // Each ``port.postMessage({ type: '<name>' })`` call must land
    // here so the offscreen handler can route on it.
    expect(workletSrc).toContain("type: 'init'");
    expect(workletSrc).toContain("type: 'pcm'");
    expect(workletSrc).toContain("type: 'vad_stats'");
  });

  it('vad_stats payload carries the fields the SW telemetry forwards', () => {
    // The offscreen handler does ``{ totalBlocks, droppedBlocks,
    // droppedPct }`` — these names must match in the worklet.
    expect(workletSrc).toContain('totalBlocks');
    expect(workletSrc).toContain('droppedBlocks');
    expect(workletSrc).toContain('droppedPct');
  });

  it('default RMS threshold is in the documented range (~-46 dBFS)', () => {
    // Picked above typical laptop room noise, below any speech.
    // Drifting much higher would silently clip quiet speakers. The
    // ``[\s\S]`` class spans newlines because the inline conditional
    // wraps across two lines in the worklet source.
    const m = workletSrc.match(
      /_vadThreshold\s*=[\s\S]*?vadOpts\.threshold\s*:\s*([\d.]+)/,
    );
    expect(m, 'inline threshold default not found').toBeTruthy();
    const value = parseFloat(m[1]);
    expect(value).toBeGreaterThan(0.002);
    expect(value).toBeLessThan(0.02);
  });

  it('hangover default exceeds 100 blocks so trailing syllables survive', () => {
    // At ~3 ms/block, 100 blocks ≈ 300 ms. We tune to 200 (~600 ms).
    // A regression to single-digit values would clip the end of
    // every utterance.
    const m = workletSrc.match(
      /_vadHangoverBlocks\s*=[\s\S]*?vadOpts\.hangoverBlocks\s*:\s*(\d+)/,
    );
    expect(m, 'inline hangover default not found').toBeTruthy();
    const value = parseInt(m[1], 10);
    expect(value).toBeGreaterThanOrEqual(100);
  });

  it('VAD_REPORT_INTERVAL_MS lines up with the dashboard 60s window', () => {
    // Aggregations on the telemetry dashboard bucket at 1 minute;
    // a smaller interval would flood the buffer with sub-minute
    // entries that the dashboard would re-bucket anyway.
    expect(workletSrc).toMatch(/VAD_REPORT_INTERVAL_MS\s*=\s*60_?000/);
  });

  it('VAD gate runs BEFORE downsampling (cost-saving order)', () => {
    // The whole point of in-worklet VAD is to skip the downsample
    // when the frame is silent. Verify the order in the source: the
    // ``_isVoicedBlock`` call appears before the ``Int16Array``
    // allocation for output.
    const voicedIdx = workletSrc.indexOf('_isVoicedBlock');
    const allocIdx = workletSrc.indexOf('new Int16Array(Math.ceil');
    expect(voicedIdx).toBeGreaterThan(0);
    expect(allocIdx).toBeGreaterThan(voicedIdx);
  });
});


// Reference RMS implementation kept here so a future port to a
// different language / runtime can be sanity-checked against this
// known-good baseline.
function refRms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) {
    sum += buf[i] * buf[i];
  }
  return Math.sqrt(sum / buf.length);
}


describe('VAD reference RMS', () => {
  it('returns 0 for silent buffer', () => {
    expect(refRms(new Float32Array(128))).toBe(0);
  });

  it('returns 1 for a constant-1 buffer (RMS of constant = constant)', () => {
    const buf = new Float32Array(128).fill(1);
    expect(refRms(buf)).toBe(1);
  });

  it('crosses the 0.005 default threshold for typical speech-energy buffers', () => {
    // A sin wave at ~0.05 amplitude is well above the noise floor
    // but quieter than peaky speech; the VAD should treat this as
    // voiced.
    const buf = new Float32Array(128);
    for (let i = 0; i < buf.length; i += 1) {
      buf[i] = Math.sin(i / 4) * 0.05;
    }
    expect(refRms(buf)).toBeGreaterThan(0.005);
  });

  it('stays below threshold for typical room-noise buffers', () => {
    // White noise at amplitude 0.001 is well under the default
    // 0.005 threshold — won't keep the gate open.
    const buf = new Float32Array(128);
    for (let i = 0; i < buf.length; i += 1) {
      buf[i] = (Math.random() - 0.5) * 0.001;
    }
    expect(refRms(buf)).toBeLessThan(0.005);
  });
});
