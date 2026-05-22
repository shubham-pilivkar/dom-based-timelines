// Phase C — accuracy. Two correctness additions to the worklet that
// can't run in vitest (no AudioWorkletGlobalScope): an anti-alias
// low-pass before decimation, and an onset pre-roll so the VAD
// doesn't clip word starts. Source-contract tests, same pattern as
// vad-worklet-contract.test.js.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const w = readFileSync(resolve(here, '../public/transcribe-worklet.js'), 'utf8');

describe('Phase C — anti-alias before decimation', () => {
  it('declares a sub-Nyquist low-pass cutoff (< 8 kHz output Nyquist)', () => {
    const m = w.match(/ANTIALIAS_CUTOFF_HZ\s*=\s*(\d+)/);
    expect(m, 'ANTIALIAS_CUTOFF_HZ missing').toBeTruthy();
    const hz = Number(m[1]);
    expect(hz).toBeGreaterThan(3400); // keep all speech energy
    expect(hz).toBeLessThan(8000); // strictly below 16k Nyquist
  });

  it('builds the biquad from the real input sampleRate', () => {
    expect(w).toContain('this._lpInit(ANTIALIAS_CUTOFF_HZ, sampleRate)');
    expect(w).toContain('_lpInit(fc, fs)');
    expect(w).toContain('2 * Math.PI * (fc / fs)');
  });

  it('filters every input sample before the decimation read', () => {
    // The decimator must read the filtered scratch (filt[]), NOT the
    // raw channel — otherwise aliasing is reintroduced.
    expect(w).toContain('filt[n] = this._lp(channel[n])');
    expect(w).toContain('const s0 = filt[i0]');
    expect(w).toMatch(/filt\[i0 \+ 1\]/);
    // Linear interpolation between the two straddling filtered
    // samples (not nearest-sample).
    expect(w).toContain('(s0 + (s1 - s0) * frac) * 32767');
    // The old nearest-sample read must be gone.
    expect(w).not.toContain('channel[i | 0]');
  });

  it('carries IIR state across render quanta (continuous stream)', () => {
    expect(w).toContain('this._z1 = this._b1 * x - this._a1 * y + this._z2');
    expect(w).toContain('this._z2 = this._b2 * x - this._a2 * y');
  });
});

describe('Phase C — onset pre-roll (VAD does not clip word starts)', () => {
  it('keeps a bounded ring of recent RAW blocks', () => {
    expect(w).toContain('_pushPreroll(channel)');
    expect(w).toContain('this._preroll.push(channel.slice())');
    expect(w).toContain('while (this._preroll.length > this._vadPrerollBlocks)');
  });

  it('replays the pre-roll on the silence→speech rising edge', () => {
    expect(w).toContain('if (!this._wasVoiced && this._preroll.length > 0)');
    expect(w).toContain('this._downsampleAndBatch(buffered[k])');
  });

  it('default pre-roll is ~150 ms and configurable at runtime', () => {
    const m = w.match(/vadOpts\.prerollBlocks\s*:\s*(\d+)/);
    expect(m).toBeTruthy();
    const blocks = Number(m[1]);
    // ~2.67 ms/block at 128 samples / 48 kHz → 40–80 blocks ≈ 100-210ms
    expect(blocks).toBeGreaterThanOrEqual(40);
    expect(blocks).toBeLessThanOrEqual(80);
    expect(w).toContain("e.data.vadPrerollBlocks === 'number'");
  });

  it('lowered the VAD threshold so soft speech is not gated out', () => {
    const m = w.match(/vadOpts\.threshold\s*:\s*([\d.]+)/);
    expect(parseFloat(m[1])).toBeLessThanOrEqual(0.0035);
  });
});
