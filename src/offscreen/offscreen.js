// Offscreen document — owns the MediaStream, AudioContext, and
// MediaRecorder for one recording session.
//
// We deliberately keep all upload / auth logic in the SW. When a chunk
// is emitted we persist it to IndexedDB ourselves and notify the SW;
// the SW does the actual fetch with backoff.

import {
  AUDIO_BITRATE_PRESETS,
  AUDIO_CONTEXT_ROTATE_MS,
  DEFAULT_AUDIO_BITRATE,
  DEFAULT_VIDEO_BITRATE,
  HEARTBEAT_INTERVAL_MS,
  LEVEL_INTERVAL_MS,
  MessageType,
  StorageKey,
  TELEMETRY_EVENT_NAMES,
  VIDEO_BITRATE_PRESETS,
} from '../constants.js';
import { AudioMixer } from '../lib/audio-mixer.js';
import { micConstraintsForRecording } from '../lib/audio-constraints.js';
import {
  encryptChunk,
  generateMeetingKey,
  getOrCreateMasterKey,
} from '../lib/encryption.js';
import { startHeapWatchdog } from '../lib/heap-watchdog.js';
import { Recorder } from '../lib/recorder.js';
import {
  WebCodecsRecorder,
  isWebCodecsRecorderSupported,
} from '../lib/recorder-webcodecs.js';
import { onMessage, sendMessage } from '../lib/messaging.js';
import { emitEvent, persistChunk } from '../api/client.js';


// `chrome.storage` is not guaranteed in the offscreen-document
// context. The recording-critical knobs (mic/tab gain, capture
// source, e2ee) already arrive on the OFFSCREEN_START message; the
// values read here (webcodecs flag, mic device, bitrates, audio-only)
// are optional refinements, so a missing/throwing storage namespace
// must degrade to defaults rather than abort recording.
async function safeStorageGet(keys) {
  try {
    const s = (typeof chrome !== 'undefined'
      && chrome.storage && chrome.storage.local) || null;
    if (!s) return {};
    return await s.get(keys);
  } catch {
    return {};
  }
}


// Phase E — pick the recorder backend. Returns a constructed
// recorder. The selection logic:
//
//   * MediaRecorder (existing path) when:
//       - audioOnly is false (video recordings stay on MediaRecorder
//         until Phase E v2 adds a video encoder + A+V muxer)
//       - the WebCodecs feature flag is off (default)
//       - the browser doesn't expose WebCodecs (rare on our targets)
//   * WebCodecsRecorder when:
//       - audioOnly is true AND the flag is on AND the browser
//         supports WebCodecs
//
// Telemetry events fire for both the engaged and fallback paths so
// we can see adoption rate + measure quality differences once the
// flag is rolling out.
async function pickRecorder({
  stream, videoBitsPerSecond, audioBitsPerSecond, audioOnly,
  onChunk, onError, startIndex,
}) {
  const got = await safeStorageGet(StorageKey.WEBCODECS_RECORDER_ENABLED);
  const flagOn = !!got[StorageKey.WEBCODECS_RECORDER_ENABLED];
  if (!audioOnly || !flagOn) {
    return new Recorder({
      stream, videoBitsPerSecond, audioBitsPerSecond, audioOnly,
      onChunk, onError, startIndex,
    });
  }
  if (!isWebCodecsRecorderSupported()) {
    emitEvent('webcodecs_recorder_fallback', { reason: 'unsupported' });
    return new Recorder({
      stream, videoBitsPerSecond, audioBitsPerSecond, audioOnly,
      onChunk, onError, startIndex,
    });
  }
  try {
    const rec = new WebCodecsRecorder({
      stream, audioBitsPerSecond, onChunk, onError, startIndex,
    });
    emitEvent('webcodecs_recorder_used', { audioBitsPerSecond });
    return rec;
  } catch (err) {
    // Constructor throw — log + fall back. We never want a feature-
    // flag bug to take down recording.
    const reason = err instanceof Error ? err.message : String(err);
    emitEvent('webcodecs_recorder_fallback', { reason });
    return new Recorder({
      stream, videoBitsPerSecond, audioBitsPerSecond, audioOnly,
      onChunk, onError, startIndex,
    });
  }
}

const monitorEl = /** @type {HTMLAudioElement} */ (document.getElementById('tab-monitor'));

/**
 * Independent pause reasons. The recorder is paused while ANY reason is
 * true, and only resumed when ALL are false. Each reason is set/cleared
 * by exactly one source:
 *   - sw       — OFFSCREEN_PAUSE / OFFSCREEN_RESUME from the service
 *                worker (covers user-pause and queue back-pressure).
 *   - offline  — local navigator offline/online events.
 * Without this multi-reason model, a transient online event would
 * resume an SW-paused recorder and silently override user intent.
 */
const pauseReasons = { sw: false, offline: false };

/**
 * @type {{
 *   meetingId: string,
 *   capture: MediaStream,
 *   mic: MediaStream | null,
 *   mixer: AudioMixer,
 *   recorder: Recorder,
 *   recordingStream: MediaStream,
 *   rotateTimer: number | null,
 *   heartbeatTimer: number | null,
 *   levelsTimer: number | null,
 *   isScreen: boolean,
 *   tabAudioStream: MediaStream,
 *   silenceCtx: AudioContext | null,
 * } | null}
 */
let session = null;

// Mirror of the user's IN-MEETING mic mute (Meet/Teams toggle),
// pushed from the SW via OFFSCREEN_MIC_MUTE. Module-scoped (not on
// ``session``) so a state update that races session (re)creation /
// rotation isn't lost — every mixer (re)build calls applyMicGain().
let meetingMicMuted = false;

// Last capture-state edge sent to the SW (null = none yet this
// session). The MediaRecorder is the single point where media truly
// stops/starts — whatever the cause (user pause, queue back-pressure,
// offline auto-pause, AudioContext-rotation handoff) it funnels
// through here. We mirror every transition of that real state to the
// SW so the speaker-timeline clock freezes for exactly the spans the
// final mp4 omits. Edge-triggered (deduped by value) so overlapping
// pause causes can't double-count.
let lastCapturing = null;

// Apply the EFFECTIVE mic gain: 0 while the user is muted in the
// meeting, otherwise the configured base gain. Keeps the mic TRACK
// alive (instant unmute, no re-getUserMedia) — only its contribution
// to the mixed recording is silenced. Idempotent + null-safe.
function applyMicGain() {
  if (!session || !session.mixer) return;
  const base = typeof session.baseMicGain === 'number'
    ? session.baseMicGain : 1;
  try {
    session.mixer.setMicGain(meetingMicMuted ? 0 : base);
  } catch { /* mixer torn down — best-effort */ }
}

// Send a capture-state edge to the SW. Deduped by value unless
// ``force`` (used once right after RECORDING_STARTED to sync the
// authoritative initial state — e.g. a recording that booted while
// offline starts paused). Fire-and-forget: a dropped edge would only
// momentarily mis-stamp timeline events, never break recording.
function sendCaptureState(capturing, { force = false } = {}) {
  if (!force && capturing === lastCapturing) return;
  lastCapturing = capturing;
  sendMessage({
    type: MessageType.RECORDER_CAPTURE_STATE,
    capturing,
  }).catch(() => {});
}

// Derive capture state from the LIVE recorder and emit an edge.
function notifyCaptureState(opts) {
  const capturing = !!(
    session && session.recorder && session.recorder.state === 'recording'
  );
  sendCaptureState(capturing, opts);
}

function reconcilePause() {
  if (!session) return;
  const wantPaused = pauseReasons.sw || pauseReasons.offline;
  if (wantPaused && session.recorder.state === 'recording') {
    session.recorder.pause();
  } else if (!wantPaused && session.recorder.state === 'paused') {
    session.recorder.resume();
  }
  // MediaRecorder.pause()/resume() flip ``state`` synchronously, so
  // reading it here reflects the post-transition truth.
  notifyCaptureState();
}

// Clear the sticky grant flag so the SW re-opens the one-time
// permission window on the next start (self-heal if the user revoked
// mic access after granting). Best-effort; storage may be absent.
async function markMicDenied() {
  try {
    const s = (typeof chrome !== 'undefined'
      && chrome.storage && chrome.storage.local) || null;
    if (s) await s.set({ [StorageKey.MIC_GRANTED]: false });
  } catch { /* best-effort */ }
}

async function getMicStream() {
  // Honor the user's explicit device selection from the options page.
  // If the chosen deviceId is no longer present (e.g. unplugged USB
  // headset), fall back to the system default rather than failing the
  // entire recording.
  const got = await safeStorageGet(StorageKey.MIC_DEVICE_ID);
  const preferredId = got[StorageKey.MIC_DEVICE_ID];
  // Recording path asks for raw 48 kHz mono with AEC / NS / AGC
  // DISABLED so the saved file preserves the original signal — see
  // lib/audio-constraints.js for the rationale. Distinct from the
  // live-transcribe mic capture (in offscreen/transcribe.js), which
  // keeps DSP on for STT accuracy.
  //
  // Phase E lets recording + live-transcribe run in parallel against
  // the same physical mic. Each ``getUserMedia`` returns its own
  // ``MediaStreamTrack`` with its own MediaTrackConstraints applied
  // — Chrome shares the underlying capture but exposes independent
  // tracks, so the recording track keeps the raw signal even while
  // the transcribe track applies AEC/NS/AGC. (Verified: WebRTC spec
  // ``getUserMedia`` is per-track; constraints don't leak between
  // tracks of the same device.)
  try {
    return await navigator.mediaDevices.getUserMedia(
      micConstraintsForRecording({ deviceId: preferredId }),
    );
  } catch (err) {
    if (preferredId) {
      console.warn(
        '[offscreen] preferred mic unavailable; falling back to default',
        err,
      );
      try {
        return await navigator.mediaDevices.getUserMedia(
          micConstraintsForRecording(),
        );
      } catch (err2) {
        console.warn('[offscreen] mic denied / unavailable', err2);
        void markMicDenied();
        return null;
      }
    }
    console.warn('[offscreen] mic denied / unavailable', err);
    void markMicDenied();
    return null;
  }
}

/**
 * @param {string} streamId
 */
async function getTabStream(streamId) {
  // Chrome's legacy mandatory-constraints shape — required for tabCapture
  // streams. The standard MediaTrackConstraints type doesn't model this,
  // hence the loosely-typed object.
  const constraints = {
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
    video: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * CaptureSource.SCREEN path — MV3-correct: call getDisplayMedia()
 * HERE, in the offscreen document (it owns the DISPLAY_MEDIA reason).
 * We deliberately do NOT consume a desktopCapture streamId minted in
 * the service worker — Chrome does not let an offscreen document use
 * such a streamId (documented limitation, postponed since Chrome 116),
 * which is why the old chromeMediaSource:'desktop' getUserMedia path
 * silently failed in real Chrome.
 *
 * ``audio: true`` surfaces the picker's "Also share tab/system audio"
 * checkbox (the only way an extension can get system/tab audio for a
 * screen/tab share — a *window* share never has audio). Audio is
 * best-effort: the deriveCaptureAudioStream() helper splices a silent
 * track when none was shared, so the mixer/recorder invariant holds.
 * A dismissed picker rejects with NotAllowedError → surfaced as a
 * clean "screen share canceled" error by the caller.
 */
async function getDesktopStream() {
  // Offer EVERY surface type so "entire screen", an app "window", or a
  // browser "tab" all work:
  //   • monitorTypeSurfaces:'include' → entire-screen / monitors listed
  //   • selfBrowserSurface:'include'  → the user may pick a tab incl.
  //     this very browser
  //   • surfaceSwitching:'include'    → user can switch the shared
  //     tab mid-recording without us restarting capture
  //   • systemAudio:'include'         → the "Share tab/system audio"
  //     checkbox is offered (screen/tab shares only; a *window* share
  //     has no audio — deriveCaptureAudioStream splices a silent track
  //     so the mixer/recorder invariant still holds).
  // video:true accepts whichever surface the user chooses;
  // buildRecordingStream() then adds ALL of that surface's video
  // tracks to the recording, so screen/window/tab are each captured.
  const opts = {
    video: true,
    audio: true,
    // @ts-ignore — non-standard but honoured by Chromium.
    systemAudio: 'include',
    selfBrowserSurface: 'include',
    monitorTypeSurfaces: 'include',
    surfaceSwitching: 'include',
  };
  try {
    return await navigator.mediaDevices.getDisplayMedia(opts);
  } catch (err) {
    // A genuine user-cancel (NotAllowedError) must propagate so the
    // SW surfaces "screen share canceled". But some environments
    // reject the audio-inclusive request for certain surfaces; retry
    // video-only so the recording still starts (silent track spliced).
    if (err && err.name === 'NotAllowedError') throw err;
    return navigator.mediaDevices.getDisplayMedia({
      video: true,
      // @ts-ignore — non-standard but honoured by Chromium.
      selfBrowserSurface: 'include',
      monitorTypeSurfaces: 'include',
      surfaceSwitching: 'include',
    });
  }
}

/**
 * AudioMixer requires a non-empty audio MediaStream (it calls
 * createMediaStreamSource, which throws on zero tracks). The tab path
 * always yields tab audio; the screen path may not (window share /
 * "share audio" unticked). When the capture has no audio track we
 * splice in a silent track so the pipeline shape is identical and the
 * mixer / VU-meter / recorder code stays untouched. Returns the audio
 * stream plus an optional AudioContext to close on teardown.
 *
 * @param {MediaStream} captureStream
 * @returns {{ stream: MediaStream, silenceCtx: AudioContext | null }}
 */
function deriveCaptureAudioStream(captureStream) {
  const tracks = captureStream.getAudioTracks();
  if (tracks.length > 0) {
    return { stream: new MediaStream(tracks), silenceCtx: null };
  }
  const ctx = new AudioContext();
  const dst = ctx.createMediaStreamDestination();
  // A zero-gain node with no upstream source emits a continuous
  // silent audio track — enough to satisfy createMediaStreamSource.
  const g = ctx.createGain();
  g.gain.value = 0;
  g.connect(dst);
  return { stream: dst.stream, silenceCtx: ctx };
}

/**
 * Build a recording MediaStream: the mixed audio track from AudioMixer,
 * plus (unless audioOnly) the captured tab's video track.
 *
 * In audio-only mode we still capture the tab video track (tabCapture
 * always returns one for the requested constraints) but we don't add it
 * to the recording stream — the encoder skips video entirely so we save
 * ~10x bandwidth and match what Otter / Fireflies offer.
 */
function buildRecordingStream(captureStream, audioTrack, audioOnly) {
  const stream = new MediaStream();
  if (!audioOnly) {
    for (const t of captureStream.getVideoTracks()) stream.addTrack(t);
  }
  if (audioTrack) stream.addTrack(audioTrack);
  return stream;
}

/**
 * Pick which audio track the MediaRecorder records.
 *
 * - With a microphone we MUST mix (mic + tab) → the AudioMixer's
 *   processed destination track.
 * - With NO microphone there is nothing to mix, so we record the
 *   captured tab/system audio track DIRECTLY. This bypasses the Web
 *   Audio graph entirely, so system audio is captured even if the
 *   offscreen AudioContext fails to leave the "suspended" state
 *   (a real failure mode that previously yielded a silent recording —
 *   "system audio not captured"). The mixer is still built for the
 *   monitor playback + VU meters.
 */
function pickRecordedAudioTrack({ mic, mixer, tabAudioStream }) {
  if (mic) return mixer.audioTrack;
  const raw = tabAudioStream.getAudioTracks()[0];
  return raw || mixer.audioTrack;
}

function makeMonitorCallbacks() {
  return {
    onMonitorBlocked: (err) => {
      const reason = err instanceof Error ? err.message : String(err);
      sendMessage({ type: MessageType.AUDIO_MONITOR_BLOCKED, reason }).catch(() => {});
    },
    onMonitorRestored: () => {
      sendMessage({ type: MessageType.AUDIO_MONITOR_RESTORED }).catch(() => {});
    },
  };
}

// Snap a stored bitrate to a known preset. The options page only ever
// writes values from ``presets``, but a legacy install or a hand-edited
// storage value could carry anything; an out-of-range bitrate handed to
// MediaRecorder is at best ignored and at worst rejected. Unknown →
// the default the options UI shows.
function _validBitrate(value, presets, fallback) {
  return presets.includes(value) ? value : fallback;
}

// Best-effort teardown of capture-pipeline resources acquired during
// handleStart BEFORE they were handed off to ``session``. The
// handleStart catch calls this so a failure partway through start
// (mic stream error, mixer AudioContext resume reject, no supported
// MediaRecorder mime, E2EE keygen error) doesn't leak live
// MediaStreamTracks + a running AudioContext until the whole offscreen
// document is torn down. Mirrors the pre-session subset of handleStop.
function _disposeCaptureResources({ capture, mic, mixer, silenceCtx }) {
  try { if (mixer) mixer.dispose(); } catch { /* best-effort */ }
  try {
    if (capture) for (const t of capture.getTracks()) t.stop();
  } catch { /* track already ended */ }
  try {
    if (mic) for (const t of mic.getTracks()) t.stop();
  } catch { /* track already ended */ }
  try { if (silenceCtx) silenceCtx.close(); } catch { /* already closed */ }
}

async function handleStart({
  streamId, meetingId, micGain, tabGain, captureSource, e2eeEnabled,
}) {
  if (session) throw new Error('already_recording');

  const isScreen = captureSource === 'screen';
  // Resources acquired during start are hoisted so the catch at the
  // end can tear them down if any step before ``session`` is assigned
  // throws — otherwise they leak (see _disposeCaptureResources). The
  // body below stays at its original indentation inside the try for a
  // minimal, reviewable diff.
  let capture = null;
  let mic = null;
  let mixer = null;
  let silenceCtx = null;
  let tabAudioStream = null;
  let recorder = null;
  let recordingStream = null;
  let recordingStartedAt = 0;
  try {
  // SCREEN → getDisplayMedia() here (no SW streamId); TAB → consume
  // the SW-minted tabCapture streamId via getUserMedia.
  capture = isScreen
    ? await getDesktopStream()
    : await getTabStream(streamId);
  mic = await getMicStream();

  // Bitrates come from the options page; the SW could pre-resolve them
  // and pass via the OFFSCREEN_START message but reading directly here
  // keeps the message envelope small and avoids stale values across a
  // rotation where the user changed the option mid-recording.
  const settingsGet = await safeStorageGet([
    StorageKey.VIDEO_BITRATE,
    StorageKey.AUDIO_BITRATE,
    StorageKey.AUDIO_ONLY,
  ]);
  // Validate against the options-page presets, not just ``?? DEFAULT``:
  // a stale legacy value or a DevTools-injected out-of-range number
  // would otherwise be handed straight to MediaRecorder. Snap any
  // unknown value back to the default the options UI would show.
  let videoBitsPerSecond = _validBitrate(
    settingsGet[StorageKey.VIDEO_BITRATE], VIDEO_BITRATE_PRESETS, DEFAULT_VIDEO_BITRATE,
  );
  let audioBitsPerSecond = _validBitrate(
    settingsGet[StorageKey.AUDIO_BITRATE], AUDIO_BITRATE_PRESETS, DEFAULT_AUDIO_BITRATE,
  );
  const audioOnly = !!settingsGet[StorageKey.AUDIO_ONLY];

  // Adaptive bitrate at session start. If the browser reports a slow
  // connection (slow-2g, 2g, 3g), downshift to the smallest preset so we
  // don't immediately blow back-pressure thresholds. We only adapt at
  // start — live mid-recording adaptation would force a rotation and
  // the user-visible audio gap that comes with it is rarely worth it.
  // Back-pressure (queue depth thresholds → pause/resume MediaRecorder)
  // already handles the live-degradation case without rotating.
  //
  // R1 minor — wire a one-shot ``connection.onchange`` listener on
  // the session so we get observability without disrupting UX: when
  // the network shifts mid-session, fire a ``connection_changed``
  // telemetry event. Lets us measure how often back-pressure carries
  // the load AND whether to revisit the no-rotation decision later.
  // Cleaned up on session teardown alongside the other window listeners.
  const conn = /** @type {any} */ (navigator).connection;
  if (conn && (conn.effectiveType === 'slow-2g' || conn.effectiveType === 'cellular' || conn.effectiveType === '2g' || conn.effectiveType === '3g' || conn.saveData === true)) {
    const downV = Math.min(videoBitsPerSecond, 1_000_000);
    const downA = Math.min(audioBitsPerSecond, 64_000);
    if (downV !== videoBitsPerSecond || downA !== audioBitsPerSecond) {
      sendMessage({
        type: MessageType.TELEMETRY_EVENT,
        name: 'bitrate_downshift',
        payload: {
          effectiveType: conn.effectiveType,
          saveData: !!conn.saveData,
          videoFrom: videoBitsPerSecond,
          videoTo: downV,
          audioFrom: audioBitsPerSecond,
          audioTo: downA,
        },
      }).catch(() => {});
      videoBitsPerSecond = downV;
      audioBitsPerSecond = downA;
    }
  }

  // Split the capture stream's audio out for mixing — keep video on the
  // capture stream as the recorder's video source. The screen path may
  // yield no audio (window share / "share audio" unticked); the helper
  // substitutes a silent track so the mixer invariant holds.
  ({ stream: tabAudioStream, silenceCtx } = deriveCaptureAudioStream(capture));

  mixer = new AudioMixer({
    tabAudioStream,
    micStream: mic,
    micGain,
    tabGain,
    monitorEl,
    // System audio isn't muted at the source, so monitoring it would
    // echo. Only the tab path needs the monitor.
    monitorEnabled: !isScreen,
    ...makeMonitorCallbacks(),
  });

  // A/V-SYNC CRITICAL: do not start the MediaRecorder until the
  // mixer's AudioContext is actually running. Otherwise the mixed
  // ``audioTrack`` emits silence for the first few hundred ms while
  // video records from frame 0 → audio is offset behind video for
  // the entire recording AND the speaker timeline (anchored at
  // recorder start) is shifted by the same gap. Bounded internally.
  await mixer.ready();

  const recordedAudioTrack = pickRecordedAudioTrack({
    mic, mixer, tabAudioStream,
  });
  recordingStream = buildRecordingStream(
    capture, recordedAudioTrack, audioOnly,
  );

  // Phase F — set up encryption when the flag is on. Both keys
  // (master + meeting) live in this offscreen scope; the master is
  // non-extractable in IDB, the meeting key is held in-memory for
  // the duration of the session. A failure here surfaces but does
  // NOT fall back to plaintext — silently shipping plaintext when
  // the user opted into encryption would be a worse outcome than
  // failing to record.
  let meetingKey = null;
  if (e2eeEnabled) {
    try {
      const masterKey = await getOrCreateMasterKey();
      // ``masterKey`` is intentionally unused after this — we only
      // use it as a key-encryption-key in v2 when the wrapped
      // meeting key starts shipping to the backend. v1 keeps the
      // meeting key entirely in offscreen memory.
      void masterKey;
      meetingKey = await generateMeetingKey();
      sendMessage({
        type: MessageType.TELEMETRY_EVENT,
        name: 'e2ee_session_started',
        payload: { meetingId },
      }).catch(() => {});
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      sendMessage({
        type: MessageType.TELEMETRY_EVENT,
        name: 'e2ee_crypto_failed',
        payload: { phase: 'init', reason },
      }).catch(() => {});
      sendMessage({
        type: MessageType.OFFSCREEN_ERROR,
        error: `e2ee_init_failed: ${reason}`,
      }).catch(() => {});
      throw err;
    }
  }

  recorder = await pickRecorder({
    stream: recordingStream,
    videoBitsPerSecond,
    audioBitsPerSecond,
    audioOnly,
    onChunk: async (blob, index, isFinal, mimeType) => {
      // Encrypt before persisting when a meeting key is set. The
      // ciphertext Blob is typed ``application/octet-stream``, which
      // the backend chunk allowlist REJECTS (415). We keep the
      // original recorder mime in the persistChunk record; the
      // uploader (client.js#pickAllowedContentType) relabels the
      // multipart part with that original container type so the
      // upload passes the allowlist — and so future v2 decryption can
      // reconstruct the original blob shape.
      let payload = blob;
      if (meetingKey) {
        try {
          payload = await encryptChunk(blob, meetingKey);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          sendMessage({
            type: MessageType.TELEMETRY_EVENT,
            name: 'e2ee_crypto_failed',
            payload: { phase: 'encrypt', chunkIndex: index, reason },
          }).catch(() => {});
          // Hard fail — never silently downgrade to plaintext.
          throw err;
        }
      }
      await persistChunk({
        meetingId, chunkIndex: index, isFinal, blob: payload, mimeType,
      });
      await sendMessage({
        type: MessageType.CHUNK_PERSISTED,
        chunkIndex: index,
        isFinal,
      });
    },
    onError: (err) => {
      const reason = err instanceof Error ? err.message : String(err);
      sendMessage({
        type: MessageType.OFFSCREEN_ERROR,
        error: `media_recorder_error: ${reason}`,
      }).catch(() => {});
    },
  });

  recorder.start();
  // Capture the media epoch at the EXACT instant recording begins.
  // This is the single zero that the speaker timeline is anchored to
  // (broadcast as t0 via RECORDING_STARTED → RECORDING_LIFECYCLE), so
  // timeline seconds line up with the final mp4's playhead.
  recordingStartedAt = Date.now();
  } catch (err) {
    // Start failed before ``session`` took ownership — dispose any
    // resources we managed to acquire so they don't leak, then
    // rethrow so the SW handler surfaces the error to the user.
    _disposeCaptureResources({ capture, mic, mixer, silenceCtx });
    throw err;
  }

  // Rotate the AudioContext every hour to mitigate clock drift between
  // the tab and microphone sources on long sessions.
  const rotateTimer = setInterval(() => {
    rotateAudioContext().catch((err) => {
      console.error('[offscreen] rotate failed', err);
    });
  }, AUDIO_CONTEXT_ROTATE_MS);

  // Heartbeat — the SW uses this to detect crashes.
  const heartbeatTimer = setInterval(() => {
    sendMessage({ type: MessageType.OFFSCREEN_HEARTBEAT }).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  // Audio level emitter — fires AUDIO_LEVELS at LEVEL_INTERVAL_MS so the
  // popup can animate a VU meter for mic + tab audio. The SW relays
  // these to an open popup; if the popup is closed the message just
  // resolves with no_receiver and is dropped.
  const levelsTimer = setInterval(() => {
    if (!session) return;
    const levels = session.mixer.getLevels();
    // The meters must reflect what is ACTUALLY being captured:
    //   • Recorder paused (user pause / back-pressure / offline) →
    //     nothing is being recorded, so BOTH bars read 0. Without
    //     this the analysers keep animating while paused and the
    //     user thinks pause didn't work.
    //   • Mic muted in-meeting → mic contribution is zeroed
    //     (applyMicGain). The analyser taps POST-gain, so muting
    //     already zeros it; forcing mic:0 here is redundant belt-and-
    //     suspenders that also covers the gain-transition frames.
    const paused = !!session.recorder
      && session.recorder.state === 'paused';
    sendMessage({
      type: MessageType.AUDIO_LEVELS,
      tab: paused ? 0 : levels.tab,
      mic: (paused || meetingMicMuted) ? 0 : levels.mic,
    }).catch(() => {});
  }, LEVEL_INTERVAL_MS);

  // Heap watchdog — Phase B. Samples ``performance.memory`` every
  // 60s, emits ``heap_high_water_mark`` when crossing thresholds,
  // and triggers an early rotateAudioContext() if heap sustains
  // above the recycle threshold. The rotation drops the holding
  // MediaStream / mixer / recorder so GC can reclaim them, which
  // is the surest fix for sneaky leaks in long meetings.
  const heapWatchdog = startHeapWatchdog({
    onHighWatermark: ({ thresholdBytes, heapBytes }) => {
      emitEvent(TELEMETRY_EVENT_NAMES.HEAP_HIGH_WATER_MARK, {
        thresholdBytes,
        heapBytes,
        context: 'recording',
        meetingId,
      });
    },
    onSustainedHigh: ({ heapBytes, consecutiveSamples }) => {
      console.warn('[offscreen] heap sustained-high; forcing rotation', {
        heapBytes, consecutiveSamples,
      });
      emitEvent(TELEMETRY_EVENT_NAMES.HEAP_HIGH_WATER_MARK, {
        thresholdBytes: heapBytes, heapBytes,
        context: 'recording', meetingId, forcedRotation: true,
      });
      rotateAudioContext().catch((err) => {
        console.error('[offscreen] forced rotation failed', err);
      });
    },
  });

  // Refresh the connection_changed listener baseline so its first
  // in-session telemetry event reports the network at session-start
  // (not the stale value captured at module load — which could be
  // hours old for a long-lived offscreen doc).
  resetConnectionBaseline();
  session = {
    meetingId,
    capture,
    mic,
    mixer,
    recorder,
    recordingStream,
    rotateTimer,
    heartbeatTimer,
    levelsTimer,
    heapWatchdog,
    // Persisted so rotateAudioContext reuses the SAME audio stream
    // (incl. the silent fallback, which isn't derivable from
    // ``capture.getAudioTracks()``) instead of re-deriving it.
    isScreen,
    tabAudioStream,
    silenceCtx,
    // Base (configured) mic gain. The EFFECTIVE gain applied to the
    // mixer is 0 whenever the user has muted themselves in the
    // meeting (see applyMicGain), else this. Tracked on the session
    // so rotation + options-gain-change recompute correctly.
    baseMicGain: micGain,
  };
  applyMicGain();

  // If we boot while offline, set the offline reason and reconcile so
  // we don't accumulate unsendable chunks in memory. The drain pump's
  // waitForOnline() handles the network gating on the upload side; this
  // handles it on the recording side.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    pauseReasons.offline = true;
    reconcilePause();
  }

  await sendMessage({
    type: MessageType.RECORDING_STARTED,
    // The recorder-start epoch, not "now" (which is after timer/
    // watchdog setup) — keeps the timeline anchor tight to media zero.
    startedAt: recordingStartedAt,
    micAvailable: mic !== null,
  });

  // Sync the authoritative initial capture state now that the SW is in
  // RECORDING (it ignores capture-state edges while STARTING). ``force``
  // because in the normal case capturing===true matches the dedup
  // default and we still need the SW to know; the SW only acts on a
  // genuine pause, so a "capturing:true" sync is a harmless no-op while
  // a recording that booted offline correctly starts the clock frozen.
  notifyCaptureState({ force: true });
}

async function rotateAudioContext() {
  if (!session) return;
  const old = session;

  // The rotation handoff is a real media gap: the old recorder stops
  // before the new one starts, so the final mp4 omits this ~sub-second
  // span. Freeze the timeline clock for it (resumed below) so the
  // speaker timeline doesn't drift ahead of the mp4 by the cumulative
  // gap on long, multi-rotation meetings.
  sendCaptureState(false);

  // Stop the current recorder WITHOUT marking the trailing chunk as
  // final — we're handing off mid-meeting. The new recorder picks up
  // chunkIndex = old.nextIndex once the in-flight handlers settle.
  await old.recorder.stop({ final: false });
  await old.mixer.dispose();

  // Build a fresh mixer + recorder from the still-live tab/mic streams.
  // Reuse the persisted audio stream (the screen path's silent
  // fallback isn't recoverable from ``capture.getAudioTracks()``).
  // Re-read settings so option-page changes mid-recording apply on the
  // next rotation (gains and bitrates).
  const tabAudioStream = old.tabAudioStream;
  const settings = await safeStorageGet([
    StorageKey.MIC_GAIN,
    StorageKey.TAB_GAIN,
    StorageKey.VIDEO_BITRATE,
    StorageKey.AUDIO_BITRATE,
    StorageKey.AUDIO_ONLY,
  ]);
  const audioOnly = !!settings[StorageKey.AUDIO_ONLY];

  const mixer = new AudioMixer({
    tabAudioStream,
    micStream: old.mic,
    micGain: settings[StorageKey.MIC_GAIN] ?? 1,
    tabGain: settings[StorageKey.TAB_GAIN] ?? 1,
    monitorEl,
    monitorEnabled: !old.isScreen,
    ...makeMonitorCallbacks(),
  });

  // Same A/V-sync guard as handleStart: the fresh rotation mixer's
  // AudioContext must be running before the new recorder starts, or
  // the chunk at the rotation boundary gets video-without-audio for
  // the resume gap → a per-rotation desync that accumulates.
  await mixer.ready();

  const recordingStream = buildRecordingStream(
    old.capture,
    pickRecordedAudioTrack({ mic: old.mic, mixer, tabAudioStream }),
    audioOnly,
  );
  // Rotation goes through the same recorder picker so flipping the
  // WebCodecs flag mid-session takes effect on the next rotation
  // instead of requiring a stop-and-restart.
  const recorder = await pickRecorder({
    stream: recordingStream,
    videoBitsPerSecond:
      settings[StorageKey.VIDEO_BITRATE] ?? DEFAULT_VIDEO_BITRATE,
    audioBitsPerSecond:
      settings[StorageKey.AUDIO_BITRATE] ?? DEFAULT_AUDIO_BITRATE,
    audioOnly,
    onChunk: old.recorder.onChunk,
    onError: old.recorder.onError,
    startIndex: old.recorder.nextIndex,
  });
  recorder.start();

  session.mixer = mixer;
  session.recorder = recorder;
  session.recordingStream = recordingStream;
  // The fresh mixer was built with the configured base gain; re-apply
  // the in-meeting mute so a rotation while muted stays silent.
  session.baseMicGain = settings[StorageKey.MIC_GAIN] ?? 1;
  applyMicGain();

  // The new MediaRecorder always starts in 'recording'. If the session
  // was paused (user / back-pressure / offline) when the rotation timer
  // fired, re-apply that pause to the fresh recorder — otherwise a
  // rotation would silently un-pause and record audio the timeline
  // (still frozen) believes is paused. reconcilePause() also emits the
  // capture-state edge: it resolves to 'resumed' (folding the rotation
  // gap into the timeline) only when the session is genuinely live, and
  // stays 'paused' (clock stays frozen) when a pause reason is active.
  reconcilePause();

  emitEvent('audio_context_rotated', {
    meetingId: session.meetingId,
    nextChunkIndex: recorder.nextIndex,
  });
}

async function handleStop() {
  if (!session) return;
  const s = session;
  if (s.rotateTimer) clearInterval(s.rotateTimer);
  if (s.heartbeatTimer) clearInterval(s.heartbeatTimer);
  if (s.levelsTimer) clearInterval(s.levelsTimer);
  if (s.heapWatchdog) s.heapWatchdog.stop();
  try {
    await s.recorder.stop({ final: true });
  } catch (err) {
    console.warn('[offscreen] recorder stop error', err);
  }
  try {
    await s.mixer.dispose();
  } catch (err) {
    console.warn('[offscreen] mixer dispose error', err);
  }
  for (const t of s.capture.getTracks()) t.stop();
  if (s.mic) for (const t of s.mic.getTracks()) t.stop();
  if (s.silenceCtx) {
    // Closing the context stops the synthesized silent track.
    try {
      await s.silenceCtx.close();
    } catch (err) {
      console.warn('[offscreen] silence ctx close error', err);
    }
  }
  session = null;
  pauseReasons.sw = false;
  pauseReasons.offline = false;
  // Reset so the next session's first capture-state sync is treated as
  // a fresh edge (the SW also gets a clean 'started' for the new t0).
  lastCapturing = null;

  await sendMessage({ type: MessageType.RECORDING_STOPPED });
}

async function handleRetryMonitor() {
  if (!session) return { ok: false, error: 'no_session' };
  const ok = await session.mixer.retryMonitor();
  return { ok };
}

function handlePause() {
  if (!session) return { ok: false, error: 'no_session' };
  pauseReasons.sw = true;
  reconcilePause();
  return { ok: true, state: session.recorder.state };
}

function handleResume() {
  if (!session) return { ok: false, error: 'no_session' };
  pauseReasons.sw = false;
  reconcilePause();
  return { ok: true, state: session.recorder.state };
}

onMessage({
  [MessageType.OFFSCREEN_START]: async (message) => {
    await handleStart(message);
    return { ok: true };
  },
  [MessageType.OFFSCREEN_STOP]: async () => {
    await handleStop();
    return { ok: true };
  },
  [MessageType.OFFSCREEN_PING]: () => ({
    alive: !!session,
    // Diagnostic mirror of the in-meeting mic gate. Reads the LIVE
    // Web Audio gain param (not the cached ``meetingMicMuted`` flag) so
    // a health-check / e2e caller can confirm the offscreen actually
    // zeroed the mic's contribution to the recording.
    meetingMicMuted,
    micEffectiveGain:
      session && session.mixer && session.mixer.micGainNode
        ? session.mixer.micGainNode.gain.value
        : null,
    baseMicGain: session ? session.baseMicGain ?? null : null,
  }),
  [MessageType.OFFSCREEN_PAUSE]: () => handlePause(),
  [MessageType.OFFSCREEN_RESUME]: () => handleResume(),
  [MessageType.OFFSCREEN_MIC_MUTE]: (message) => {
    // User toggled their in-meeting mic. Zero / restore the mic's
    // contribution to the mixed recording (track stays live).
    meetingMicMuted = !!message.muted;
    applyMicGain();
    return { ok: true, micMuted: meetingMicMuted };
  },
  [MessageType.RETRY_MONITOR]: () => handleRetryMonitor(),
});

// Live updates from the options page — gain changes apply immediately
// to the running mixer; bitrate changes require recreating the
// MediaRecorder, so we trigger an early rotation. Rotation preserves
// chunkIndex and keeps the meeting open, so the user just sees a brief
// (sub-second) gap in audio at the rotation boundary.
function onLocalStorageChanged(changes, area) {
  if (area !== 'local' || !session) return;
  let needsRotation = false;
  if (StorageKey.MIC_GAIN in changes && session.mixer) {
    const v = changes[StorageKey.MIC_GAIN].newValue;
    // Update the BASE gain + re-derive effective (stays 0 if the
    // user is currently muted in the meeting).
    if (typeof v === 'number') { session.baseMicGain = v; applyMicGain(); }
  }
  if (StorageKey.TAB_GAIN in changes && session.mixer) {
    const v = changes[StorageKey.TAB_GAIN].newValue;
    if (typeof v === 'number') session.mixer.setTabGain(v);
  }
  if (
    StorageKey.VIDEO_BITRATE in changes ||
    StorageKey.AUDIO_BITRATE in changes ||
    StorageKey.AUDIO_ONLY in changes
  ) {
    needsRotation = true;
  }
  if (needsRotation) {
    rotateAudioContext().catch((err) => {
      console.error('[offscreen] storage-triggered rotation failed', err);
    });
  }
}

// Same guard as client.js: `chrome.storage.onChanged` isn't exposed in
// every offscreen context. Registering it unguarded at module top
// level threw an uncaught TypeError that aborted offscreen evaluation
// → "Start recording" failed. Live gain/bitrate updates simply won't
// apply where storage events are unavailable; recording still runs.
if (typeof chrome !== 'undefined'
  && chrome.storage
  && chrome.storage.onChanged
  && typeof chrome.storage.onChanged.addListener === 'function') {
  chrome.storage.onChanged.addListener(onLocalStorageChanged);
}

// Pause the recorder while offline — chunks that can't ship pile up in
// memory, and we'd rather lose audio than blow IndexedDB. We use the
// pauseReasons tracker so a separate SW-driven pause (user-pause or
// back-pressure) coexists correctly: the recorder stays paused until
// BOTH reasons are clear.
window.addEventListener('offline', () => {
  if (!session || pauseReasons.offline) return;
  pauseReasons.offline = true;
  reconcilePause();
  // Telemetry for observability; the SW relays to /extension/events.
  // Deliberately not OFFSCREEN_ERROR — offline is recoverable, not a
  // recording failure.
  sendMessage({
    type: MessageType.TELEMETRY_EVENT,
    name: 'offline_pause',
    payload: {},
  }).catch(() => {});
});

window.addEventListener('online', () => {
  if (!session || !pauseReasons.offline) return;
  pauseReasons.offline = false;
  reconcilePause();
  sendMessage({
    type: MessageType.TELEMETRY_EVENT,
    name: 'online_resume',
    payload: {},
  }).catch(() => {});
});

// R1 minor — observability for mid-session network shifts (without
// forcing a rotation). The existing design intentionally skips
// live bitrate adaptation because rotation introduces a sub-second
// audio gap and back-pressure already handles degraded networks via
// queue pause/resume. Emit a telemetry event when the effective
// connection type changes during a recording so we can measure
// whether the no-rotation policy holds up in practice or whether
// the next iteration should revisit it.
//
// Baseline state (lastEffectiveType / lastSaveData) is module-scoped
// AND refreshed at session start via ``resetConnectionBaseline``.
// Without that refresh, the listener compared the FIRST in-session
// change against whatever the network was at MODULE LOAD time — which
// can be hours stale for a long-lived offscreen doc. Refreshing at
// session start ensures the ``from`` field of the first
// ``connection_changed`` event reflects the actual network at the
// moment recording began, not the historical module-load value.
let _connLastEffectiveType = null;
let _connLastSaveData = false;
function resetConnectionBaseline() {
  try {
    const conn = /** @type {any} */ (navigator).connection;
    if (!conn) return;
    _connLastEffectiveType = conn.effectiveType ?? null;
    _connLastSaveData = !!conn.saveData;
  } catch { /* navigator.connection unavailable */ }
}
(() => {
  try {
    const conn = /** @type {any} */ (navigator).connection;
    if (!conn || typeof conn.addEventListener !== 'function') return;
    resetConnectionBaseline();
    conn.addEventListener('change', () => {
      if (!session) return;
      const nextType = conn.effectiveType ?? null;
      const nextSaveData = !!conn.saveData;
      if (nextType === _connLastEffectiveType
        && nextSaveData === _connLastSaveData) {
        return; // no actual change
      }
      sendMessage({
        type: MessageType.TELEMETRY_EVENT,
        name: 'connection_changed',
        payload: {
          from: _connLastEffectiveType,
          to: nextType,
          saveDataFrom: _connLastSaveData,
          saveDataTo: nextSaveData,
          downlinkMbps:
            typeof conn.downlink === 'number' ? conn.downlink : null,
        },
      }).catch(() => {});
      _connLastEffectiveType = nextType;
      _connLastSaveData = nextSaveData;
    });
  } catch { /* best-effort — non-standard connection objects */ }
})();

// Announce ready so the SW knows it can send OFFSCREEN_START.
sendMessage({ type: MessageType.OFFSCREEN_READY }).catch(() => {});

// Surface unhandled errors so the SW can transition to ERROR.
window.addEventListener('error', (event) => {
  sendMessage({
    type: MessageType.OFFSCREEN_ERROR,
    error: event.message,
  }).catch(() => {});
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  sendMessage({ type: MessageType.OFFSCREEN_ERROR, error: reason }).catch(() => {});
});
