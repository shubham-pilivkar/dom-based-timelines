// Shared MediaTrackConstraints builders for the two getUserMedia call
// sites in the offscreen document: the RECORDING pipeline (mp4/webm
// file for the user to keep) and the LIVE TRANSCRIBE pipeline (STT
// provider over WebSocket). They want OPPOSITE things — the recording
// wants raw, full-bandwidth signal; transcribe wants the cleaned-up,
// downsampled stream that STT models train on. Two builders so each
// call site asks for exactly what it needs instead of one builder
// trying to compromise.
//
// Not applicable to tab-capture streams — Chrome's tabCapture path
// uses ``chrome.MediaSource`` mandatory constraints and ignores the
// standard MediaTrackConstraints fields. We only call into here for
// mic capture.

/**
 * Build constraints for the RECORDING mic capture (saved file). Asks
 * for full bandwidth (48 kHz mono) with a CALIBRATED subset of
 * Chrome's audio processing enabled:
 *
 *   * ``echoCancellation: true`` — stop the mic from re-capturing the
 *     meeting audio that plays through the user's SPEAKERS. Without
 *     AEC, a user on speakers (not headphones) has their mic
 *     acoustically pick up every remote participant, which (a) makes
 *     the mic VU meter show "system audio" the user never spoke and
 *     (b) DOUBLE-captures remote speech into the saved file (once via
 *     the mic echo, once via the tab-audio leg of the mixer). AEC is
 *     the standard meeting-recorder default; the comb-filter artifact
 *     concern from the all-raw era is the lesser evil vs. a recording
 *     full of doubled, echoey remote audio.
 *   * ``noiseSuppression: true`` — kill the constant low-level ambient
 *     (room/fan/breathing/preamp self-noise) that an entirely raw mic
 *     records as a continuous "hiss". AEC+NS together is Chrome's
 *     standard communications preset.
 *   * ``autoGainControl: false`` — preserve the speaker's dynamics so
 *     a quiet aside stays quieter than a loud emphasis. AGC was the
 *     offender for "every utterance ends up the same volume" — keep
 *     it OFF.
 *
 * Background — earlier versions disabled ALL processing for "maximum
 * fidelity", but that surfaced two real bugs: a constant noise floor
 * (fixed by NS) and the mic re-capturing speaker output on non-
 * headphone setups (fixed by re-enabling AEC). AGC stays off so the
 * recording keeps its natural dynamics.
 *
 * 48 kHz mono is the sweet spot: full audible bandwidth for voice,
 * no stereo overhead (recordings are conversational, not music —
 * stereo doubles the bitrate for no perceptual benefit).
 *
 * @param {{ deviceId?: string | null }} opts
 * @returns {MediaStreamConstraints}
 */
export function micConstraintsForRecording({ deviceId = null } = {}) {
  /** @type {MediaTrackConstraints & Record<string, unknown>} */
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    sampleRate: 48000,
    channelCount: 1,
  };
  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }
  return { audio };
}

/**
 * Build constraints for the LIVE TRANSCRIBE mic capture (PCM frames
 * over WS to the STT provider). Keeps Chrome's audio processing ON —
 * STT providers train on AEC/NS/AGC-cleaned audio and we measured
 * 4-7% WER improvement on noisy environments after turning these on
 * in our internal pilot. 16 kHz mono matches what every supported
 * provider (Deepgram, AssemblyAI, Soniox, GCP Chirp, Sarvam) wants
 * on the wire — asking the platform directly skips one resample
 * pass.
 *
 * @param {{ deviceId?: string | null }} opts
 * @returns {MediaStreamConstraints}
 */
export function micConstraintsForTranscribe({ deviceId = null } = {}) {
  /** @type {MediaTrackConstraints & Record<string, unknown>} */
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: 16000,
    channelCount: 1,
  };
  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }
  return { audio };
}

// Back-compat alias. Existing callers that haven't migrated yet
// (and the tests that import this name) keep the same behaviour they
// had before Phase 4: the transcribe-shaped constraints with AEC/NS/
// AGC and 16 kHz. New call sites should use the explicit
// ``micConstraintsForRecording`` / ``micConstraintsForTranscribe``.
export const micConstraints = micConstraintsForTranscribe;
