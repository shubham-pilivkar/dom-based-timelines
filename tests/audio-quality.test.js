// Tests for Phase 4 (Bug 2 — audio capture quality):
//   * Split mic constraints — recording asks for raw 48 kHz mono with
//     AEC / NS / AGC OFF; transcribe keeps the DSP + 16 kHz mono shape
//     that every STT provider trains on.
//   * Bitrate defaults raised (96 → 128 kbps) and presets shifted
//     (64/96/128 → 96/128/192). Existing storage values stay
//     respected (recorder reads them verbatim); only the default for
//     a fresh install changes.
//   * MIME preference list tries Opus-in-MP4 first so we get
//     significantly better audio quality-per-bit at the new defaults
//     than AAC at the same rate.

import { describe, expect, it } from 'vitest';
import {
  micConstraints,
  micConstraintsForRecording,
  micConstraintsForTranscribe,
} from '../src/lib/audio-constraints.js';
import {
  AUDIO_BITRATE_PRESETS,
  DEFAULT_AUDIO_BITRATE,
  PREFERRED_MIME_TYPES,
} from '../src/constants.js';


describe('micConstraintsForRecording — clean voice, full bandwidth, dynamics preserved', () => {
  it('ENABLES echo cancellation (mic must not re-capture speaker output / double-capture remote audio)', () => {
    // Regression test for "system audio shows in the mic VU meter":
    // a user on speakers had their mic acoustically pick up the
    // meeting playback. AEC stops that AND prevents the saved file
    // double-capturing remote speech (mic echo + tab leg).
    expect(micConstraintsForRecording().audio.echoCancellation).toBe(true);
  });

  it('ENABLES noise suppression (kills the constant mic/room/preamp floor that bled through pre-fix)', () => {
    // Regression test for the "small consistent audio throughout the
    // recording" report: a fully-raw mic recorded ambient noise at
    // ~-30 dBFS for the entire session. WebRTC's RNNoise-based NS is
    // the right knob — it removes the floor without pumping like
    // older spectral-subtraction methods, and with
    // echoCancellation:false Chrome runs only the single software
    // NS pass (no hardware NS stacked on top).
    expect(micConstraintsForRecording().audio.noiseSuppression).toBe(true);
  });

  it('disables auto gain control (preserve dynamic range — AGC was the actual offender for flat-level recordings)', () => {
    expect(micConstraintsForRecording().audio.autoGainControl).toBe(false);
  });

  it('asks for 48 kHz mono so the saved file is full bandwidth', () => {
    const c = micConstraintsForRecording().audio;
    expect(c.sampleRate).toBe(48000);
    expect(c.channelCount).toBe(1);
  });

  it('honours an explicit device id when given', () => {
    const c = micConstraintsForRecording({ deviceId: 'hwid-123' }).audio;
    expect(c.deviceId).toEqual({ exact: 'hwid-123' });
  });

  it('omits deviceId when no preference', () => {
    expect(micConstraintsForRecording().audio.deviceId).toBeUndefined();
  });
});


describe('micConstraintsForTranscribe — DSP on, 16 kHz for STT', () => {
  it('keeps echo cancellation ON (cleaner audio for the model)', () => {
    expect(micConstraintsForTranscribe().audio.echoCancellation).toBe(true);
  });

  it('keeps noise suppression ON', () => {
    expect(micConstraintsForTranscribe().audio.noiseSuppression).toBe(true);
  });

  it('keeps auto gain control ON', () => {
    expect(micConstraintsForTranscribe().audio.autoGainControl).toBe(true);
  });

  it('asks for 16 kHz mono — matches every supported STT provider', () => {
    const c = micConstraintsForTranscribe().audio;
    expect(c.sampleRate).toBe(16000);
    expect(c.channelCount).toBe(1);
  });
});


describe('back-compat: micConstraints alias preserves transcribe shape', () => {
  // The original ``micConstraints`` export was the transcribe-shaped
  // builder (with AEC/NS/AGC + 16 kHz). Phase 4 split it into two
  // explicit builders but kept ``micConstraints`` as an alias to the
  // transcribe one so call sites that haven't migrated still ask for
  // the (correct) STT shape and don't regress.
  it('alias resolves to the transcribe shape', () => {
    const aliased = micConstraints();
    const direct = micConstraintsForTranscribe();
    expect(aliased).toEqual(direct);
  });
});


describe('audio bitrate defaults (Phase 4 raise)', () => {
  it('DEFAULT_AUDIO_BITRATE is at least 128 kbps (transparent for speech)', () => {
    expect(DEFAULT_AUDIO_BITRATE).toBeGreaterThanOrEqual(128_000);
  });

  it('AUDIO_BITRATE_PRESETS includes the new default', () => {
    expect(AUDIO_BITRATE_PRESETS).toContain(DEFAULT_AUDIO_BITRATE);
  });

  it('lowest preset is at least 96 kbps (was 64 — barely above phone quality)', () => {
    const lowest = Math.min(...AUDIO_BITRATE_PRESETS);
    expect(lowest).toBeGreaterThanOrEqual(96_000);
  });

  it('highest preset is at least 192 kbps (archival tier)', () => {
    const highest = Math.max(...AUDIO_BITRATE_PRESETS);
    expect(highest).toBeGreaterThanOrEqual(192_000);
  });

  it('presets are sorted ascending so the options UI renders intuitively', () => {
    const sorted = [...AUDIO_BITRATE_PRESETS].sort((a, b) => a - b);
    expect(AUDIO_BITRATE_PRESETS).toEqual(sorted);
  });
});


describe('PREFERRED_MIME_TYPES — Opus-in-MP4 preferred (Phase 4)', () => {
  it('MP4 + Opus is the FIRST entry when supported', () => {
    // Opus has significantly better quality-per-bit than AAC at the
    // 96-192 kbps tier we ship — picking it first means users on
    // Chrome M130+ get the better codec automatically. Older Chrome
    // builds skip this entry via MediaRecorder.isTypeSupported and
    // fall through to the existing MP4 + AAC entries.
    expect(PREFERRED_MIME_TYPES[0]).toMatch(/^video\/mp4;.*opus/i);
  });

  it('MP4 + AAC entries remain present as fallbacks', () => {
    const hasAac = PREFERRED_MIME_TYPES.some(
      (m) => /mp4a\.40\.2/.test(m) && /mp4/.test(m),
    );
    expect(hasAac).toBe(true);
  });

  it('VP9 / VP8 webm remain in the list (backend remux path still works)', () => {
    expect(PREFERRED_MIME_TYPES).toContain('video/webm;codecs=vp9,opus');
    expect(PREFERRED_MIME_TYPES).toContain('video/webm;codecs=vp8,opus');
  });

  it('MP4 entries are ordered ABOVE webm (backend finalize prefers MP4)', () => {
    const firstMp4 = PREFERRED_MIME_TYPES.findIndex((m) => /^video\/mp4/.test(m));
    const firstWebm = PREFERRED_MIME_TYPES.findIndex((m) => /^video\/webm/.test(m));
    expect(firstMp4).toBeGreaterThanOrEqual(0);
    expect(firstWebm).toBeGreaterThan(firstMp4);
  });
});
