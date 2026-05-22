// Phase 3 — hygiene fixes (low-priority audit items).
//
//   Fix 7  — offscreen validates stored bitrates against the options
//            presets instead of trusting any stored value.
//   Fix 8  — dead looksLikeName / UI_LABEL removed from both content
//            scripts (name resolution lives in caption-speaker-observer).
//   Fix 11 — MEETING_ENDED finalizes during STARTING too, not only
//            RECORDING (a meeting that ends mid-boot used to keep
//            recording into an empty room).
//
// Offscreen + SW + content scripts can't run under vitest, so these are
// source-contract tests (the established style for those modules).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUDIO_BITRATE_PRESETS,
  DEFAULT_AUDIO_BITRATE,
  VIDEO_BITRATE_PRESETS,
} from '../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), 'utf8');
const offscreen = read('../src/offscreen/offscreen.js');
const meet = read('../src/content/meet.js');
const teams = read('../src/content/teams.js');
const sw = read('../src/background/service-worker.js');

describe('Fix 7 — bitrate validation against presets', () => {
  it('offscreen imports the preset lists', () => {
    expect(offscreen).toMatch(/VIDEO_BITRATE_PRESETS/);
    expect(offscreen).toMatch(/AUDIO_BITRATE_PRESETS/);
  });

  it('defines a _validBitrate(value, presets, fallback) snapper', () => {
    expect(offscreen).toMatch(/function _validBitrate\(value, presets, fallback\)/);
    const fnIdx = offscreen.indexOf('function _validBitrate(');
    const fn = offscreen.slice(fnIdx, fnIdx + 200);
    expect(fn).toMatch(/presets\.includes\(value\) \? value : fallback/);
  });

  it('routes BOTH stored bitrates through _validBitrate at start', () => {
    expect(offscreen).toMatch(
      /_validBitrate\(\s*settingsGet\[StorageKey\.VIDEO_BITRATE\], VIDEO_BITRATE_PRESETS/,
    );
    expect(offscreen).toMatch(
      /_validBitrate\(\s*settingsGet\[StorageKey\.AUDIO_BITRATE\], AUDIO_BITRATE_PRESETS/,
    );
  });

  it('the snapper logic itself: unknown → fallback, known → passthrough', () => {
    // Recreate the one-liner to pin its semantics (it isn't exported).
    const valid = (v, presets, fallback) => (presets.includes(v) ? v : fallback);
    expect(valid(64_000, AUDIO_BITRATE_PRESETS, DEFAULT_AUDIO_BITRATE))
      .toBe(DEFAULT_AUDIO_BITRATE); // legacy 64k → default
    expect(valid(128_000, AUDIO_BITRATE_PRESETS, DEFAULT_AUDIO_BITRATE))
      .toBe(128_000); // valid → kept
    expect(valid(undefined, VIDEO_BITRATE_PRESETS, 1))
      .toBe(1); // missing → fallback
    expect(valid(VIDEO_BITRATE_PRESETS[0], VIDEO_BITRATE_PRESETS, 1))
      .toBe(VIDEO_BITRATE_PRESETS[0]);
  });
});

describe('Fix 8 — dead looksLikeName / UI_LABEL removed', () => {
  it('meet.js no longer defines looksLikeName or UI_LABEL', () => {
    expect(meet).not.toMatch(/function looksLikeName\(/);
    expect(meet).not.toMatch(/const UI_LABEL =/);
  });
  it('teams.js no longer defines looksLikeName or UI_LABEL', () => {
    expect(teams).not.toMatch(/function looksLikeName\(/);
    expect(teams).not.toMatch(/const UI_LABEL =/);
  });
});

describe('Fix 11 — MEETING_ENDED finalizes during STARTING too', () => {
  it('the handler stops on RECORDING OR STARTING', () => {
    const idx = sw.indexOf('case MessageType.MEETING_ENDED:');
    const block = sw.slice(idx, idx + 600);
    expect(block).toMatch(/RecordingState\.RECORDING/);
    expect(block).toMatch(/RecordingState\.STARTING/);
    expect(block).toMatch(/stopRecording\(\{ reason: 'meeting_ended' \}\)/);
  });
});
