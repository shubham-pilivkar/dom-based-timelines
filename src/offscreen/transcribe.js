// Live-transcription host that runs inside the offscreen document.
//
// Why the offscreen doc (not the service worker)?
// The service worker suspends every ~30s when idle. The transcription
// pipeline needs:
//   * A long-lived WebSocket (would die with the SW)
//   * An AudioContext + AudioWorkletNode (closes with the SW)
//   * A MediaStream from getUserMedia / chrome.tabCapture (released
//     when the holding context is GC'd)
// Offscreen documents persist as long as they have a justification
// ("USER_MEDIA"); they survive SW suspends. That makes them the
// right home for any media-pipeline lifetime.
//
// Two source modes:
//   * SELF: ``getUserMedia({audio: true})`` — user's own mic.
//   * PARTICIPANTS: ``getUserMedia`` with the legacy chrome.tabCapture
//     mandatory-constraints shape, using a streamId resolved by the
//     SW via ``chrome.tabCapture.getMediaStreamId({targetTabId})``.
//
// Both modes feed the same MediaStream → AudioContext → AudioWorklet
// pipeline. The worklet emits Int16 PCM ArrayBuffers via its port;
// the main thread (this script) sends each buffer as a binary frame
// to the backend WS. Provider events flow back as JSON text frames;
// we forward each one to the SW which routes it to the meeting-tab
// content script for rendering in the floating overlay.
//
// Reconnect lifecycle (added in the network-resilience phase):
// when the WS closes with anything other than 1000 (clean) or 1008
// (auth/state, irrecoverable), the audio pipeline stays up and the
// offscreen doc walks a backoff schedule
// (``TRANSCRIBE_RECONNECT_BACKOFFS_MS``), asking the SW for a fresh
// session each attempt. PCM frames are dropped while the WS is down
// so memory doesn't grow unboundedly during a long outage.

import {
  MessageType,
  TELEMETRY_EVENT_NAMES,
  TRANSCRIBE_RECONNECT_BACKOFFS_MS,
  TRANSCRIBE_RECONNECT_MAX_ATTEMPTS,
  TRANSCRIBE_MIN_STABLE_MS,
} from '../constants.js';
import { micConstraints } from '../lib/audio-constraints.js';
import { startHeapWatchdog } from '../lib/heap-watchdog.js';
import { createOpusEncoder, isOpusEncodingSupported } from '../lib/opus-encoder.js';
import { onMessage, sendMessage } from '../lib/messaging.js';

// Single in-flight session. Live-transcribe is mutually exclusive
// with recording (enforced in the SW); inside this offscreen doc the
// transcription side keeps its own ``session`` object so the two
// don't share state.
//
// For ``mode === 'both'`` (Mode 3 — mic + tab audio together) the
// offscreen owns TWO active streams: ``session`` is the MIC
// substream and ``sessionTab`` is the TAB substream. Each has its
// own AudioContext / worklet / WebSocket / heartbeat / reconnect
// loop. Single-mode (self / participants) leaves ``sessionTab`` null
// and behaves exactly like before this refactor.
//
// We deliberately don't `await` the session bootstrap inside the
// message handler — the OFFSCREEN_TRANSCRIBE_START handler returns
// fast and the actual setup runs asynchronously, with progress
// reported via TRANSCRIBE_LIFECYCLE messages.
let session = null;
let sessionTab = null;

// Iterate the currently-attached streams. Used by pause/resume/stop
// fan-out + tearDown so they don't have to repeat the null-check
// pattern. Order is mic-first so a partial mode=both bring-up is
// torn down in the same order it was set up.
function activeStreams() {
  const out = [];
  if (session) out.push(session);
  if (sessionTab) out.push(sessionTab);
  return out;
}

// True when a substream captures TAB audio (so it must be re-emitted
// to a monitor element or the meeting goes silent). Mode "self" is
// mic-only; "participants" is tab-only (single slot, role=null);
// "both" splits into role 'mic' (no monitor) and 'tab' (monitor).
function _isTabSourced({ role, mode }) {
  if (role === 'tab') return true;
  if (role === 'mic') return false;
  return mode === 'participants';
}

// Mirror of the user's IN-MEETING mic mute (Meet/Teams toggle),
// pushed from the SW via OFFSCREEN_MIC_MUTE — the SAME signal the
// recorder uses. Module-scoped (not per-session) so a mute that
// races substream (re)creation / reconnect isn't lost; every
// (re)build calls applyMicGate(). When muted we DROP the mic
// substream's PCM/Opus frames at the pump so the user's own speech
// is not captured or transcribed (parity with the recorder, which
// zeroes the mixer mic gain). TAB-sourced substreams (participants,
// or the 'tab' half of 'both') are NEVER gated — muting your own
// mic must not stop transcribing the other participants.
let meetingMicMuted = false;
function applyMicGate() {
  for (const s of activeStreams()) {
    s.micGated = meetingMicMuted
      && !_isTabSourced({ role: s.role, mode: s.mode });
  }
}


// Test-only seam. chrome.tabCapture + a real getUserMedia can't run in
// headless CI. chrome.storage is NOT exposed in the offscreen document
// (see getMicStream's note), so the SW — which can read storage —
// passes ``e2eSynthetic`` on OFFSCREEN_TRANSCRIBE_START. The handler
// latches it into this module-scoped flag BEFORE startTranscribe runs,
// so getMicStream()/getTabStream() keep their production signatures
// (no call-site changes). Always false in production.
let _e2eSynthetic = false;
function _e2eSyntheticStream() {
  if (!_e2eSynthetic) return null;
  const ctx = new AudioContext();
  const dst = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  // Audible tone (RMS ≈ 0.1, well above the worklet's 0.0035 VAD
  // threshold) so the pump actually emits PCM/Opus frames — lets a
  // test assert that muting the in-meeting mic GATES those frames.
  // Transcript *text* still comes from the mock relay; this only
  // exercises the audio pump. Test-only (gated by ``_e2eSynthetic``).
  gain.gain.value = 0.15;
  osc.frequency.value = 220;
  osc.connect(gain).connect(dst);
  osc.start();
  const stream = dst.stream;
  // Keep the context (and thus the live track) from being GC'd.
  Object.defineProperty(stream, '_e2eCtx', { value: ctx });
  return stream;
}


async function getMicStream() {
  const fake = _e2eSyntheticStream();
  if (fake) return fake;
  // Honour the saved deviceId if the user picked one in the options
  // page. Fall back to the system default if that device is no longer
  // present (unplugged USB headset, removed Bluetooth).
  //
  // Echo/noise/AGC constraints come from ``micConstraints``, which
  // since Phase 4 is the TRANSCRIBE-shaped builder (16 kHz mono,
  // AEC/NS/AGC ON — the shape STT providers train on). The recording
  // pipeline in offscreen.js explicitly imports
  // ``micConstraintsForRecording`` instead (48 kHz mono, AEC/NS/AGC
  // OFF — preserves the original signal for the saved file). The two
  // pipelines requesting different ``MediaTrackConstraints`` against
  // the same physical device is intentional and supported: each
  // ``getUserMedia`` returns its own ``MediaStreamTrack`` with its
  // own processing settings, even when Chrome shares the underlying
  // capture. The transcribe path must NOT switch to the recording
  // builder — STT accuracy depends on the cleaned-up shape.
  //
  // chrome.storage CAN be undefined in an offscreen document (Chrome
  // exposes a reduced API surface there; offscreen.js guards this the
  // same way via safeStorageGet). An UNGUARDED chrome.storage.local
  // here threw "Cannot read properties of undefined (reading 'local')"
  // → the offscreen tore down mid-OFFSCREEN_TRANSCRIBE_START → the SW
  // saw the closed channel as ``channel_closed`` and live-transcribe
  // (Mode 1 / 3, the mic path) failed every time. Degrade to the
  // system-default mic instead of aborting.
  let deviceId;
  try {
    const store = (typeof chrome !== 'undefined'
      && chrome.storage && chrome.storage.local) || null;
    const got = store ? await store.get(['mm_mic_device_id']) : {};
    deviceId = got['mm_mic_device_id'];
  } catch {
    deviceId = undefined;
  }
  try {
    return await navigator.mediaDevices.getUserMedia(
      micConstraints({ deviceId }),
    );
  } catch (err) {
    if (deviceId) {
      // Preferred device gone — try the default before giving up.
      try {
        return await navigator.mediaDevices.getUserMedia(micConstraints());
      } catch (err2) {
        throw new Error(`mic_denied: ${err2.message || err2}`);
      }
    }
    throw new Error(`mic_denied: ${err.message || err}`);
  }
}


async function getTabStream(streamId) {
  const fake = _e2eSyntheticStream();
  if (fake) return fake;
  // Legacy mandatory-constraints shape — required for chrome.tabCapture
  // streams. The standard MediaTrackConstraints type doesn't model
  // this, hence the loosely-typed object.
  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}


// Heartbeat thresholds. We send a JSON ping after this much inbound
// silence and treat the WS as dead if no inbound (including pong)
// arrives within the longer timeout. Chosen so a healthy session with
// a quiet speaker (no provider events for a few seconds) doesn't
// trigger spurious reconnects, but a TCP-half-open or relay wedge
// surfaces in well under a minute.
const HEARTBEAT_PING_AFTER_IDLE_MS = 20_000;
const HEARTBEAT_DEAD_AFTER_IDLE_MS = 35_000;
const HEARTBEAT_TICK_MS = 5_000;
// Custom WS close code for the client-initiated heartbeat timeout. The
// 4xxx range is reserved for application use. The relay's existing
// close-event handler treats any non-1000 / non-1008 code as
// reconnectable, which is the behaviour we want.
const HEARTBEAT_DEAD_WS_CODE = 4001;


// Build a WebSocket attached to the given session and wire its
// listeners. Used both at initial start and during reconnect — pulling
// this out of ``startTranscribe`` means the reconnect path doesn't
// have to keep its handler set in lockstep.
//
// ``isReconnect`` flows through the TRANSCRIBE_LIFECYCLE 'started'
// message so the overlay can skip its destructive state reset
// (speakerMap.reset() blows away the user's name + DOM observation
// timeline — fine for a fresh session, harmful for a re-attach).
//
// ``streamRole`` is the substream identity for mode='both' (Mode 3).
// It rides along on every forwarded TRANSCRIPT_EVENT /
// IMPORTANT_POINTS_UPDATE so the overlay can label mic-origin finals
// as "You" vs tab-origin finals via the participant name map. Null
// for single-mode sessions — the overlay falls back to its existing
// behaviour.
function attachWebSocket(wsUrl, sess, { isReconnect = false, streamRole = null } = {}) {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  // Bug 13.1 — AbortController for blanket WS listener removal at
  // teardown. Modern (2026-spec) pattern: pass ``{signal}`` to every
  // ``addEventListener`` and call ``controller.abort()`` once to
  // detach ALL of them in one shot. Cleaner than tracking each
  // handler reference + manual ``removeEventListener``; matters most
  // for closure GC — without this, the four handlers below retained
  // references to ``sess`` / ``pendingFrames`` / ``heartbeatTimer``
  // even after ``ws.close()``, blocking the substream's MediaStream +
  // AudioContext from being collected until Chrome's eventual WS
  // finalizer fired. Abort doesn't replace ``ws.close()`` — it only
  // removes listeners; the WS resource itself still needs an explicit
  // close (kept in tearDown for that reason).
  // Abort any prior controller before we overwrite the slot — keeps
  // the OLD WS's four handlers from sitting attached (and retaining
  // closure references) until Chrome's WS finalizer runs. Matters on
  // the reconnect path which re-enters ``attachWebSocket`` for the
  // same ``sess`` object.
  if (sess.wsAbort) {
    try { sess.wsAbort.abort(); } catch { /* already aborted */ }
  }
  const wsAbort = new AbortController();
  sess.wsAbort = wsAbort;
  // Passed as the third arg to every ``ws.addEventListener`` below so
  // a single ``wsAbort.abort()`` in tearDown removes all four
  // listeners in one shot.
  const wsListenerOpts = { signal: wsAbort.signal };

  // Buffer PCM frames that arrive before the WS finishes connecting.
  // At 16kHz Int16 mono = 32 KB/sec, the WS handshake takes ~50ms,
  // so worst case we hold ~2 KB. Tiny — fixed cap protects against a
  // wedged handshake.
  const pendingFrames = [];
  const PENDING_FRAMES_MAX = 64; // ~1.3s of audio at typical worklet cadence

  // Heartbeat state. ``lastInboundAt`` is updated on every inbound
  // text frame (provider events, our own pong reply). When silence
  // crosses the ping threshold we send one; when it crosses the dead
  // threshold we close the WS with a custom code, which lets the
  // existing close-handler kick off reconnect.
  let lastInboundAt = Date.now();
  let pingInFlight = false;
  let heartbeatTimer = null;
  // Phase L1 — cold-start telemetry. Stamped at WS ``open``; consumed
  // exactly once on the first inbound provider event (any non-pong
  // text frame) and reset so reconnect-reopens don't double-emit.
  // ``performance.now()`` is monotonic and survives wall-clock skew;
  // safe inside the offscreen doc (a Window context).
  let wsOpenedAtPerf = null;
  let firstEventSeen = false;

  function clearHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      const idle = Date.now() - lastInboundAt;
      if (idle >= HEARTBEAT_DEAD_AFTER_IDLE_MS) {
        // No inbound for too long — close so the close handler
        // re-enters the reconnect loop.
        clearHeartbeat();
        try {
          ws.close(HEARTBEAT_DEAD_WS_CODE, 'heartbeat_timeout');
        } catch {
          /* already closing */
        }
        return;
      }
      if (idle >= HEARTBEAT_PING_AFTER_IDLE_MS && !pingInFlight) {
        // One ping is enough — we don't need a perfectly-paired
        // pong, just any inbound message to reset the idle clock.
        // Guard ws.readyState before send: when the WS is mid-close
        // (CLOSING) or already CLOSED, ws.send synchronously throws
        // InvalidStateError AND fires an 'error' event on the socket
        // which surfaces as "WebSocket is already in CLOSING or
        // CLOSED state" in the console. The try/catch above hides the
        // throw but not the event; checking readyState skips both.
        if (ws.readyState !== WebSocket.OPEN) return;
        pingInFlight = true;
        try {
          ws.send(JSON.stringify({
            type: 'control', action: 'ping', id: `${Date.now()}`,
          }));
        } catch {
          /* WS closing; dead-threshold check above will catch it */
        }
      }
    }, HEARTBEAT_TICK_MS);
  }

  ws.addEventListener('open', () => {
    while (pendingFrames.length > 0) {
      try {
        ws.send(pendingFrames.shift());
      } catch {
        break;
      }
    }
    // Start heartbeat AFTER open — sending control frames pre-open
    // would queue or error depending on the browser.
    lastInboundAt = Date.now();
    // Phase L1 — reset the first-event watch on every fresh open
    // (including reconnects). The popup's "Listening…" pill latches
    // on this signal, so flipping it back to false during reconnect
    // is correct behaviour.
    wsOpenedAtPerf = performance.now();
    firstEventSeen = false;
    startHeartbeat();
    sendMessage({
      type: MessageType.TRANSCRIBE_LIFECYCLE,
      phase: 'started',
      startedAt: Date.now(),
      isReconnect,
      // Mode='both' identity. The SW's lifecycle handler is
      // idempotent on duplicate ``started`` events so two
      // substreams reaching ACTIVE in quick succession is fine; the
      // ``hasFirstEvent: false`` reset re-applies harmlessly.
      streamRole,
    }).catch(() => {});
  }, wsListenerOpts);

  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    // Any inbound message resets the idle clock; pong is the
    // dedicated heartbeat reply but a provider partial does just as
    // well as a "you're still alive" signal.
    lastInboundAt = Date.now();
    pingInFlight = false;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    // Pong is purely a heartbeat artefact — don't forward to the SW
    // / overlay where it would be ignored as an unknown event type
    // anyway.
    if (msg && msg.type === 'pong') return;
    // P5 — server-initiated graceful close because the cumulative
    // audio duration cap was reached. The relay sends this JSON
    // event right before closing the WS with code 1008; we forward
    // the cap details to the SW, mark this substream as ``stopping``
    // so the close handler tears down instead of attempting a
    // reconnect storm against an already-capped recording, then
    // close the WS ourselves to get the chunk drain moving.
    if (msg && msg.type === 'session_closed'
        && msg.code === 'duration_cap_exceeded') {
      sendMessage({
        type: MessageType.TRANSCRIBE_DURATION_CAP_EXCEEDED,
        capSeconds: Number(msg.cap_seconds) || 0,
        consumedSeconds: Number(msg.consumed_seconds) || 0,
        streamRole,
      }).catch(() => {});
      if (sess) sess.stopping = true;
      try { ws.close(1000, 'duration_cap_exceeded'); } catch { /* */ }
      return;
    }
    // Phase L4 — important-points batch from the relay. Different
    // wire shape than a per-turn transcript event (carries a
    // ``points`` array), so it's routed through its own SW message
    // type instead of TRANSCRIPT_EVENT (the overlay/popup paths for
    // transcript events would mis-render this).
    if (msg && msg.type === 'important_points' && Array.isArray(msg.points)) {
      sendMessage({
        type: MessageType.IMPORTANT_POINTS_UPDATE,
        points: msg.points,
        // Tag the origin substream so a future "filter by speaker"
        // UI in the popup could split the two. The SW's dedup-by-id
        // already merges across both streams.
        streamRole,
      }).catch(() => {});
      return;
    }
    // Phase L1 — first inbound provider event of this session: stamp
    // the latency, emit one telemetry event, notify the SW so the
    // popup pill can flip "Listening…" → "Active." Coalesce so a busy
    // session emits at most one per (re-)open.
    if (!firstEventSeen && wsOpenedAtPerf !== null) {
      firstEventSeen = true;
      const latencyMs = Math.round(performance.now() - wsOpenedAtPerf);
      sendMessage({
        type: MessageType.TELEMETRY_EVENT,
        name: TELEMETRY_EVENT_NAMES.TRANSCRIBE_FIRST_PARTIAL_MS,
        payload: { latencyMs, eventType: msg?.type, streamRole },
      }).catch(() => {});
      sendMessage({
        type: MessageType.TRANSCRIBE_FIRST_EVENT,
        latencyMs,
        streamRole,
      }).catch(() => {});
    }
    // Provider events arrive as ``{type, text, speaker, ...}`` per
    // app.routers.transcribe._event_to_json. Forward each to the SW
    // which routes to the meeting-tab content script for rendering.
    // ``streamRole`` tells the overlay whether to label the speaker
    // as "You" (mic substream) or to resolve via the participant
    // name map (tab substream). Null for single-mode sessions.
    sendMessage({
      type: MessageType.TRANSCRIPT_EVENT,
      event: msg,
      streamRole,
    }).catch(() => {});
  }, wsListenerOpts);

  ws.addEventListener('error', () => {
    // The error event itself carries no detail in browsers. The
    // following ``close`` event will have ``code`` + ``reason``.
    sendMessage({
      type: MessageType.OFFSCREEN_ERROR,
      error: 'transcribe_ws_error',
    }).catch(() => {});
  }, wsListenerOpts);

  ws.addEventListener('close', (event) => {
    // Stop the heartbeat regardless of which WS we own — leaving a
    // dangling interval would keep firing against a closed WS.
    clearHeartbeat();
    // Mode='both': ``sess`` may be either ``session`` (mic) or
    // ``sessionTab`` (tab); identify which by reference, not by
    // global. A stale close (the close handler firing AFTER a
    // reconnect already swapped the WS reference, or AFTER tearDown
    // cleared the substream) returns silently.
    if (!sess || sess.ws !== ws) {
      // Stale close — we've already swapped to a new WS or torn
      // down. Ignore so we don't double-fire reconnect / teardown.
      return;
    }
    const code = event.code;
    const reason = event.reason || `ws_closed_${code}`;
    // A heartbeat timeout is worth a dedicated telemetry event so
    // we can distinguish "network died" from "backend hung up" in
    // post-mortems. The reconnect loop kicks in below either way.
    if (code === HEARTBEAT_DEAD_WS_CODE) {
      sendMessage({
        type: MessageType.TELEMETRY_EVENT,
        name: 'ws_heartbeat_timeout',
        payload: { code, reason, idleMs: Date.now() - lastInboundAt },
      }).catch(() => {});
    }
    // 1000 = clean close (intentional, by us or the relay's normal
    //        end-of-session path). 1008 = backend auth/state (token
    //        expired, session already finalised, etc.) — retrying
    //        with the same params would just produce the same 1008,
    //        but the reconnect path mints a NEW session, so it CAN
    //        recover. The exception is ``stopping`` which means we
    //        triggered the close ourselves.
    if (sess.stopping) {
      void tearDown({ reason });
      return;
    }
    if (code === 1000) {
      void tearDown({ reason });
      return;
    }
    // Immediate-drop-fatal guard (mirrors the working desktop client's
    // MIN_STABLE_STREAM_SECONDS). A WS that connected but died in
    // under TRANSCRIBE_MIN_STABLE_MS WITHOUT ever producing a
    // transcript event is a broken endpoint, not a transient blip.
    // Reconnecting would mint a FRESH backend session every attempt;
    // the backend caps 3 concurrent with no cancel API + multi-hour
    // stale-grace, so the storm leaks every slot →
    // "transcribe_concurrency_cap" locks the user out. Fail fast:
    // one start → one session → one clean error, no reconnect.
    if (
      wsOpenedAtPerf !== null
      && !firstEventSeen
      && (performance.now() - wsOpenedAtPerf) < TRANSCRIBE_MIN_STABLE_MS
    ) {
      sendMessage({
        type: MessageType.TELEMETRY_EVENT,
        name: 'transcribe_immediate_drop_fatal',
        payload: {
          code,
          reason,
          uptimeMs: Math.round(performance.now() - wsOpenedAtPerf),
          role: streamRole,
        },
      }).catch(() => {});
      void tearDown({ reason: `immediate_drop_no_progress: ${reason}` });
      return;
    }
    // Anything else — kick off reconnect on THIS substream only.
    // The other substream (if any, in mode=both) stays running so
    // a one-sided network blip doesn't drop the user's mic audio
    // when only the tab side hiccupped (or vice versa).
    sess.ws = null;
    void attemptReconnect(sess, code, reason, streamRole);
  }, wsListenerOpts);

  sess.ws = ws;
  sess.pendingFrames = pendingFrames;
  sess.pendingFramesMax = PENDING_FRAMES_MAX;
  return ws;
}


async function attemptReconnect(sess, initialCode, initialReason, streamRole = null) {
  // Called by the WS close handler. Walks the backoff schedule,
  // asking the SW for a fresh ws_url on each attempt. Drops PCM frames
  // via the paused gate so the worklet → WS pump has nowhere to write
  // while we're disconnected.
  //
  // ``streamRole`` is the substream identity for mode='both' so the
  // SW knows whether to refresh the mic-side or tab-side session id.
  // Single-mode reconnects pass null and use the existing primary
  // slot.
  //
  // Liveness check: in mode='both' the OTHER substream is still
  // attached; we must guard on ``sess`` (the substream this
  // reconnect owns) rather than the global ``session`` so a mic
  // reconnect doesn't bail just because the tab side is still live.
  const isOwned = () => sess === session || sess === sessionTab;
  if (!isOwned()) return;
  sess.paused = true;
  for (let attempt = 0; attempt < TRANSCRIBE_RECONNECT_MAX_ATTEMPTS; attempt += 1) {
    // Announce the upcoming attempt so the popup can render
    // "Reconnecting (N of M)…". The SW mirrors this into
    // TranscribeState; if the user hit Stop in the meantime, the SW
    // will refuse the URL request below and we tear down.
    await sendMessage({
      type: MessageType.TRANSCRIBE_RECONNECT_PROGRESS,
      phase: 'reconnecting',
      attempt: attempt + 1,
      maxAttempts: TRANSCRIBE_RECONNECT_MAX_ATTEMPTS,
      initialCode,
      initialReason,
      streamRole,
    }).catch(() => {});

    await sleep(TRANSCRIBE_RECONNECT_BACKOFFS_MS[attempt]);
    if (!isOwned() || sess.stopping) return;

    // Ask the SW for a fresh ws_url. SW mints a new session
    // (POST /api/v1/transcribe/sessions) so the token isn't stale.
    // ``role`` tells the SW which substream this reconnect belongs
    // to so it patches the right slot in TranscribeState.
    let resp;
    try {
      resp = await sendMessage({
        type: MessageType.OFFSCREEN_TRANSCRIBE_GET_RECONNECT_URL,
        role: streamRole,
      });
    } catch (err) {
      resp = { ok: false, error: err?.message || String(err) };
    }
    if (!isOwned() || sess.stopping) return;
    if (resp && resp.ok && resp.ws_url) {
      try {
        // If failover changed the active provider, the wire encoding
        // may have flipped (e.g. Soniox-opus → Deepgram-pcm). Tear
        // down the old encoder and bring up a new one to match.
        const nextFormat = resp.audio_format ?? 'pcm_s16le';
        if (nextFormat !== sess.audioFormat) {
          if (sess.opusEncoder) {
            try { await sess.opusEncoder.close(); } catch { /* idempotent */ }
            sess.opusEncoder = null;
          }
          if (nextFormat === 'opus' && isOpusEncodingSupported()) {
            try {
              sess.opusEncoder = await createOpusEncoder({
                onEncoded: (pkt) => sendOpusPacket(pkt, sess),
                onError: (err) => console.warn('[transcribe] opus error', err),
              });
              sess.audioFormat = 'opus';
            } catch (err) {
              console.warn('[transcribe] opus re-init failed; PCM fallback', err);
              sess.audioFormat = 'pcm_s16le';
            }
          } else {
            sess.audioFormat = nextFormat;
          }
        }
        attachWebSocket(resp.ws_url, sess, {
          isReconnect: true, streamRole,
        });
        sess.paused = false;
        // Don't announce "reconnected" yet — the ``open`` event in
        // attachWebSocket will fire TRANSCRIBE_LIFECYCLE phase=started
        // which the SW interprets as "back to ACTIVE". Send an
        // explicit progress note too so the popup can clear the
        // reconnecting indicator immediately.
        await sendMessage({
          type: MessageType.TRANSCRIBE_RECONNECT_PROGRESS,
          phase: 'reconnected',
          attempt: attempt + 1,
          maxAttempts: TRANSCRIBE_RECONNECT_MAX_ATTEMPTS,
          streamRole,
        }).catch(() => {});
        return;
      } catch (err) {
        // attachWebSocket itself doesn't throw on connect failure —
        // the WS open is async and the close handler will re-enter
        // this loop. But ``new WebSocket(badUrl)`` can throw
        // synchronously on a malformed URL; treat as a failed
        // attempt and continue the schedule.
        console.warn('[transcribe] reconnect attach failed', err);
      }
    }
    // Auth errors are irrecoverable — re-running the loop won't
    // help. SW signals this via ``error: 'auth'``.
    if (resp && resp.error === 'auth') break;
  }
  // Exhausted attempts — surface and tear down. For mode='both' we
  // tear down BOTH substreams: partial-mode operation (only mic OR
  // only tab transcribing under a "You + others" picker) is more
  // confusing for the user than a clean stop with a visible error.
  await sendMessage({
    type: MessageType.TRANSCRIBE_RECONNECT_PROGRESS,
    phase: 'failed',
    attempt: TRANSCRIBE_RECONNECT_MAX_ATTEMPTS,
    maxAttempts: TRANSCRIBE_RECONNECT_MAX_ATTEMPTS,
    initialCode,
    initialReason,
    streamRole,
  }).catch(() => {});
  await tearDown({ reason: `reconnect_failed_after_${TRANSCRIBE_RECONNECT_MAX_ATTEMPTS}_attempts` });
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// Send one already-Opus-encoded packet over the WS. Mirrors the PCM
// path's backpressure / pending-buffer behaviour so the encoder
// doesn't have to know about reconnect state. Called from the
// encoder's ``onEncoded`` callback set up in ``startTranscribe``;
// ``sess`` identifies which substream's WS to push to (the mic or
// tab side, in mode='both').
function sendOpusPacket(packet, sess) {
  if (!sess || sess.paused || sess.micGated) return;
  sess.bytesSent += packet.byteLength;
  const ws = sess.ws;
  if (!ws) {
    sess.dropped += 1;
    return;
  }
  if (ws.readyState === WebSocket.OPEN) {
    if (ws.bufferedAmount > 1024 * 1024) {
      sess.dropped += 1;
      return;
    }
    try {
      // ``ws.send`` with a Uint8Array view is correct; the WS
      // serialiser handles the underlying buffer slice.
      ws.send(packet);
    } catch {
      /* close handler tears us down */
    }
  } else if (ws.readyState === WebSocket.CONNECTING) {
    if (sess.pendingFrames.length < sess.pendingFramesMax) {
      // ``pendingFrames`` holds raw ArrayBuffer-like items; slice the
      // typed array's underlying buffer so the WS open handler can
      // ``ws.send(buf)`` it as-is.
      sess.pendingFrames.push(packet.buffer.slice(
        packet.byteOffset, packet.byteOffset + packet.byteLength,
      ));
    } else {
      sess.dropped += 1;
    }
  }
}


// Per-substream pipeline construction. Builds the AudioContext +
// worklet + (optional) Opus encoder + worklet→WS pump closure +
// opens the WebSocket. Returns the fully-wired streamSession object
// so the orchestrator can stash it in the appropriate global slot.
//
// ``role`` is null for single-mode (legacy 'self' / 'participants')
// or 'mic' / 'tab' for Mode 3 substreams. The role flows into
// attachWebSocket so the forwarded TRANSCRIPT_EVENT / lifecycle
// messages carry the origin to the overlay.
async function _setupStream({ role, mode, mediaStream, wsUrl, audioFormat }) {
  // Each substream owns its own AudioContext + worklet. We could in
  // principle share one AudioContext between mic + tab in mode=both
  // (they're independent MediaStreamSources), but separate contexts
  // keep teardown trivially correct — closing one doesn't disturb
  // the other's worklet — and avoid a class of "what if one context
  // gets suspended" foot-guns.
  const audioContext = new AudioContext({ sampleRate: 48000 });
  try {
    // Shipped via public/ → copied verbatim to the extension root at
    // a STABLE, unhashed path. It must NOT be a bundled/hashed asset
    // or a src/ path: crxjs/Vite can't statically see this runtime
    // getURL string, so a src/ path is never emitted and addModule
    // 404s ("audio_worklet_load_failed") — which silently broke ALL
    // live transcription. public/ guarantees the file exists here.
    await audioContext.audioWorklet.addModule(
      chrome.runtime.getURL('transcribe-worklet.js'),
    );
  } catch (err) {
    audioContext.close().catch(() => {});
    mediaStream.getTracks().forEach((t) => t.stop());
    throw new Error(`audio_worklet_load_failed: ${err.message || err}`);
  }
  const source = audioContext.createMediaStreamSource(mediaStream);
  const tabSourced = _isTabSourced({ role, mode });
  // System / tab audio reaching us is already Opus-compressed and
  // AGC-attenuated by Meet/Teams, so it lands at a noticeably LOWER
  // level than a raw mic. Two consequences for STT quality on
  // modes 2/3: (a) the energy VAD (tuned for mic level) gates quiet
  // remote speech → clipped/garbled words; (b) the provider gets a
  // low-amplitude signal → worse WER. Fix: a makeup GainNode lifts
  // tab audio into a healthy range BEFORE the worklet, and the
  // worklet runs a gentler VAD for tab substreams (lower threshold +
  // longer onset pre-roll) so soft remote talkers aren't dropped.
  // The mic path already has the browser's AGC, so it's unchanged.
  const worklet = new AudioWorkletNode(audioContext, 'pcm-downsampler', {
    processorOptions: tabSourced
      ? { vad: { threshold: 0.0018, prerollBlocks: 96, hangoverBlocks: 260 } }
      : {},
  });
  let makeupGain = null;
  if (tabSourced) {
    makeupGain = audioContext.createGain();
    makeupGain.gain.value = 2.0; // ≈ +6 dB makeup for captured tab audio
    source.connect(makeupGain);
    makeupGain.connect(worklet);
  } else {
    source.connect(worklet);
  }
  // We do NOT connect the worklet to ``audioContext.destination`` —
  // that would re-emit the captured audio to the user's speakers,
  // creating echo for the mic and a feedback loop for the tab.
  //
  // BUT: chrome.tabCapture MUTES the source tab while we hold its
  // stream. For TAB-sourced substreams (mode "participants", or the
  // 'tab' half of "both") that means the user can no longer hear the
  // other participants — the #6 bug. Re-emit the captured tab audio
  // through a dedicated hidden <audio> monitor so the meeting stays
  // audible. NEVER do this for the mic substream (it would echo the
  // user's own voice back at them).
  let monitorEl = null;
  if (_isTabSourced({ role, mode })) {
    monitorEl = document.getElementById('transcribe-tab-monitor');
    if (monitorEl) {
      try {
        monitorEl.srcObject = mediaStream;
        // Autoplay is set in the HTML; play() guards against a
        // suspended element after a previous session detached it.
        const p = monitorEl.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (err) {
        console.warn('[transcribe] tab monitor attach failed', err);
        monitorEl = null;
      }
    }
  }

  const sess = {
    role,                       // null for single-mode; 'mic'/'tab' in mode=both
    mode,                       // mirror of the user-facing mode for diagnostics
    mediaStream,
    audioContext,
    worklet,
    source,
    // Makeup-gain node spliced before the worklet for tab-sourced
    // substreams (null for mic). Tracked so tearDown disconnects it.
    makeupGain,
    ws: null,
    pendingFrames: [],
    pendingFramesMax: 64,
    bytesSent: 0,
    dropped: 0,
    paused: false,
    // True while the user's in-meeting mic is muted AND this is a
    // mic-sourced substream — frames are dropped at the pump. Set
    // initially from the module mirror so a mute that arrived before
    // this substream existed still takes effect.
    micGated: meetingMicMuted && !_isTabSourced({ role, mode }),
    stopping: false,
    heapWatchdog: null,
    audioFormat,
    opusEncoder: null,
    // Hidden <audio> re-emitting tab capture so the meeting stays
    // audible (tab-sourced substreams only; null for mic).
    monitorEl,
  };

  // Phase C — Opus encoder, falling back to PCM on failure. Each
  // substream gets its own encoder so a failure on one side doesn't
  // poison the other.
  if (audioFormat === 'opus') {
    if (!isOpusEncodingSupported()) {
      console.warn('[transcribe] WebCodecs Opus unavailable; PCM fallback');
      sess.audioFormat = 'pcm_s16le';
    } else {
      try {
        sess.opusEncoder = await createOpusEncoder({
          onEncoded: (packet) => sendOpusPacket(packet, sess),
          onError: (err) => console.warn('[transcribe] opus encoder error', err),
        });
      } catch (err) {
        console.warn('[transcribe] opus encoder init failed; PCM fallback', err);
        sess.audioFormat = 'pcm_s16le';
        sess.opusEncoder = null;
      }
    }
  }

  // Worklet → WS pump. Closure captures ``sess`` so a mode=both
  // installation has two independent pumps writing into their own
  // substream's WS without globals.
  worklet.port.onmessage = (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'pcm' && msg.buffer instanceof ArrayBuffer) {
      if (sess.paused || sess.micGated) return;
      if (sess.audioFormat === 'opus' && sess.opusEncoder) {
        try {
          const int16 = new Int16Array(msg.buffer);
          sess.opusEncoder.encodeInt16Frame(int16, 16_000);
        } catch (err) {
          console.warn('[transcribe] opus encode failed', err);
        }
        return;
      }
      sess.bytesSent += msg.buffer.byteLength;
      const ws = sess.ws;
      if (!ws) {
        sess.dropped += 1;
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 1024 * 1024) {
          sess.dropped += 1;
          return;
        }
        try {
          ws.send(msg.buffer);
        } catch {
          /* close handler tears us down */
        }
      } else if (ws.readyState === WebSocket.CONNECTING) {
        if (sess.pendingFrames.length < sess.pendingFramesMax) {
          sess.pendingFrames.push(msg.buffer);
        } else {
          sess.dropped += 1;
        }
      }
    } else if (msg.type === 'init') {
      // Worklet handshake — sample-rate reported but not actionable.
      // No console output in the production build; the per-substream
      // role + sample rate are already covered by the start
      // telemetry event upstream.
    } else if (msg.type === 'vad_stats') {
      // Forward worklet's rolling VAD-drop report. Tag with role so
      // mode=both surfaces VAD per substream rather than mixing the
      // mic's silence-skip rate with the tab's.
      sendMessage({
        type: MessageType.TELEMETRY_EVENT,
        name: TELEMETRY_EVENT_NAMES.VAD_STATS,
        payload: {
          totalBlocks: msg.totalBlocks,
          droppedBlocks: msg.droppedBlocks,
          droppedPct: msg.droppedPct,
          streamRole: role,
        },
      }).catch(() => {});
    }
  };

  // Open the WebSocket. ``attachWebSocket`` wires the close handler
  // which drives the per-substream reconnect loop.
  attachWebSocket(wsUrl, sess, { isReconnect: false, streamRole: role });
  return sess;
}


async function startTranscribe({
  mode,
  wsUrl,
  tabStreamId,
  audioFormat = 'pcm_s16le',
  wsUrlTab = null,
  audioFormatTab = null,
}) {
  if (session || sessionTab) {
    // Bug 2 — a fast stop→start (user finishes mode 1, immediately
    // starts mode 2) can arrive while the previous session's async
    // tearDown (WS close, AudioContext close) is still in flight.
    // Throwing ``already_transcribing`` here made the new session
    // fail ("won't start"). Instead, tear the stale one down NOW and
    // continue — tearDown is idempotent and nulls the slots.
    for (const s of activeStreams()) s.stopping = true;
    await tearDown({ reason: 'superseded_by_new_session' });
  }

  if (mode === 'both') {
    // Mode 3: capture mic + tab in parallel as two independent
    // substreams. The two backend sessions are already minted by
    // the SW (see ``startTranscribe`` in service-worker.js); we
    // just bring up the local capture pipelines and the WS for each.
    if (!wsUrlTab || !tabStreamId) {
      throw new Error('both_mode_requires_both_ws_urls_and_tab_stream_id');
    }
    let micStream;
    let tabStream;
    {
      // A3 — ``Promise.all`` rejects on the FIRST failure, but the
      // sibling capture can still resolve a LIVE MediaStream that
      // then leaks: the mic stays "in use" / Chrome's tab-capture
      // indicator stays lit, and ``tearDown`` can't reach it because
      // ``session``/``sessionTab`` aren't assigned yet (they're set
      // by ``_setupStream`` below). ``allSettled`` lets us explicitly
      // stop whichever side succeeded before surfacing the failure.
      const [micRes, tabRes] = await Promise.allSettled([
        getMicStream(),
        getTabStream(tabStreamId),
      ]);
      if (micRes.status === 'rejected' || tabRes.status === 'rejected') {
        for (const r of [micRes, tabRes]) {
          if (r.status === 'fulfilled' && r.value) {
            try {
              for (const t of r.value.getTracks()) t.stop();
            } catch { /* track already ended */ }
          }
        }
        // Preserve the historical Promise.all bias (mic failure
        // reported first) so the user-facing message is stable.
        throw micRes.status === 'rejected'
          ? micRes.reason
          : tabRes.reason;
      }
      micStream = micRes.value;
      tabStream = tabRes.value;
    }
    try {
      session = await _setupStream({
        role: 'mic',
        mode,
        mediaStream: micStream,
        wsUrl,
        audioFormat,
      });
      sessionTab = await _setupStream({
        role: 'tab',
        mode,
        mediaStream: tabStream,
        wsUrl: wsUrlTab,
        audioFormat: audioFormatTab ?? 'pcm_s16le',
      });
    } catch (err) {
      // Bring-up failure on either substream → tear everything
      // down. Partial mode=both (only mic OR only tab) is more
      // surprising for the user than a clean stop with the error.
      await tearDown({ reason: `both_mode_setup_failed: ${err?.message || err}` })
        .catch(() => {});
      throw err;
    }
  } else if (mode === 'self' || mode === 'participants') {
    let mediaStream;
    if (mode === 'self') {
      mediaStream = await getMicStream();
    } else {
      if (!tabStreamId) {
        throw new Error('participants_mode_requires_tab_stream_id');
      }
      mediaStream = await getTabStream(tabStreamId);
    }
    session = await _setupStream({
      role: null,
      mode,
      mediaStream,
      wsUrl,
      audioFormat,
    });
  } else {
    throw new Error(`unknown_mode: ${mode}`);
  }

  // Single heap watchdog at the orchestrator level — it polls
  // ``performance.memory.usedJSHeapSize`` which is per-process, so
  // running two would be redundant. On sustained-high it recycles
  // the WS(es) by closing them with a custom code; the per-stream
  // close handlers route to reconnect.
  const primary = session;
  primary.heapWatchdog = startHeapWatchdog({
    onHighWatermark: ({ thresholdBytes, heapBytes }) => {
      sendMessage({
        type: MessageType.TELEMETRY_EVENT,
        name: TELEMETRY_EVENT_NAMES.HEAP_HIGH_WATER_MARK,
        payload: { thresholdBytes, heapBytes, context: 'transcribe' },
      }).catch(() => {});
    },
    onSustainedHigh: ({ heapBytes, consecutiveSamples }) => {
      console.warn('[transcribe] heap sustained-high; forcing WS recycle', {
        heapBytes, consecutiveSamples,
      });
      sendMessage({
        type: MessageType.TELEMETRY_EVENT,
        name: TELEMETRY_EVENT_NAMES.HEAP_HIGH_WATER_MARK,
        payload: {
          thresholdBytes: heapBytes, heapBytes,
          context: 'transcribe', forcedRecycle: true,
        },
      }).catch(() => {});
      // Recycle BOTH substreams in mode=both — heap is a process-
      // wide signal so leaving one open while the other reconnects
      // wouldn't free much.
      for (const s of activeStreams()) {
        if (s.ws) {
          try { s.ws.close(4002, 'heap_recycle'); } catch { /* already closing */ }
        }
      }
    },
  });
}


/**
 * Forward a DOM caption-author observation to every active transcribe
 * WS as a JSON control frame. The relay accumulates these to drive
 * ``name_by_label`` correlation for important-points attribution when
 * the session is NOT paired with a recording (Mode 2 transcribe-only).
 *
 * Best-effort: dropped silently when the WS isn't OPEN (CONNECTING or
 * CLOSING), when there's no active session, or on a send error — the
 * relay tolerates missing frames and falls back to per-letter labels
 * for unmapped speakers. mode='both' sends to BOTH substreams; the
 * relay on each side dedupes independently.
 *
 * @param {{ name: string, wallClockMs?: number, source?: string }} payload
 */
function sendSpeakerObservation(payload) {
  const name = payload && typeof payload.name === 'string'
    ? payload.name.trim()
    : '';
  if (!name) return;
  const wallClockMs = typeof payload.wallClockMs === 'number'
    && Number.isFinite(payload.wallClockMs) && payload.wallClockMs > 0
    ? Math.floor(payload.wallClockMs)
    : Date.now();
  const source = typeof payload.source === 'string' && payload.source
    ? payload.source
    : undefined;
  const frame = JSON.stringify({
    type: 'speaker_observation',
    name,
    wall_clock_ms: wallClockMs,
    ...(source ? { source } : {}),
  });
  for (const s of activeStreams()) {
    if (!s.ws || s.ws.readyState !== WebSocket.OPEN) continue;
    try {
      s.ws.send(frame);
    } catch {
      /* best-effort — the next observation will retry */
    }
  }
}


async function tearDown({ reason } = {}) {
  // Snapshot both substream handles BEFORE clearing globals so a
  // racing close-handler (which checks ``sess === session`` to
  // distinguish stale closes) bails out on the second teardown call.
  const streams = activeStreams();
  session = null;
  sessionTab = null;
  if (streams.length === 0) return;

  // Per-substream cleanup. Each step is wrapped in try/catch — a
  // failure tearing down one substream MUST NOT block the cleanup
  // of the other.
  let bytesSentTotal = 0;
  let droppedTotal = 0;
  for (const s of streams) {
    s.stopping = true;

    if (s.heapWatchdog) {
      try { s.heapWatchdog.stop(); } catch { /* idempotent */ }
    }
    if (s.opusEncoder) {
      try { await s.opusEncoder.close(); } catch { /* idempotent */ }
    }
    try {
      if (s.worklet) {
        s.worklet.port.onmessage = null;
        s.worklet.disconnect();
      }
    } catch {
      /* already disconnected */
    }
    try {
      if (s.source) s.source.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      if (s.makeupGain) s.makeupGain.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      if (s.audioContext && s.audioContext.state !== 'closed') {
        await s.audioContext.close();
      }
    } catch {
      /* already closed */
    }
    // Detach the tab monitor BEFORE stopping tracks so the element
    // doesn't hold a reference to ended tracks (Chrome keeps a
    // muted-but-live element around otherwise, and a stale srcObject
    // would block the next session's monitor on the shared element).
    if (s.monitorEl) {
      try {
        s.monitorEl.pause();
        s.monitorEl.srcObject = null;
      } catch { /* element already detached */ }
    }
    try {
      if (s.mediaStream) {
        s.mediaStream.getTracks().forEach((t) => t.stop());
      }
    } catch {
      /* tracks already stopped */
    }
    if (s.ws && s.ws.readyState <= WebSocket.OPEN) {
      try {
        s.ws.close(1000, reason ?? 'client_stop');
      } catch {
        /* already closing */
      }
    }
    // Bug 13.1 — blanket-remove all four WS listeners (open / message /
    // error / close) in one shot. ``ws.close()`` above schedules the
    // socket teardown but the listeners stay ATTACHED to the closed
    // WS until Chrome's WS finalizer runs; aborting their signal
    // detaches them now so their closures over ``sess`` /
    // ``pendingFrames`` / ``heartbeatTimer`` are eligible for GC
    // immediately. The abort signal removes listeners only; the
    // ``ws.close()`` above is still required to free the socket
    // resource itself (abort + close are two different cleanups).
    if (s.wsAbort) {
      try { s.wsAbort.abort(); } catch { /* already aborted */ }
      s.wsAbort = null;
    }

    bytesSentTotal += s.bytesSent || 0;
    droppedTotal += s.dropped || 0;
  }

  // One ``stopped`` lifecycle event covers the whole logical
  // session. For mode=both we sum the byte / dropped counters so
  // the SW telemetry isn't double-counted.
  await sendMessage({
    type: MessageType.TRANSCRIBE_LIFECYCLE,
    phase: 'stopped',
    reason: reason ?? 'client_stop',
    bytesSent: bytesSentTotal,
    dropped: droppedTotal,
  }).catch(() => {});
}


onMessage({
  [MessageType.OFFSCREEN_TRANSCRIBE_START]: async (message) => {
    try {
      // Test-only: latch the synthetic-capture flag (SW read it from
      // storage; the offscreen has none) BEFORE startTranscribe so
      // getMicStream()/getTabStream() keep production signatures.
      _e2eSynthetic = message.e2eSynthetic === true;
      await startTranscribe({
        mode: message.mode,
        wsUrl: message.wsUrl,
        tabStreamId: message.tabStreamId,
        audioFormat: message.audioFormat,
        // Mode='both' ride-along. Single-mode starts pass null and
        // ``startTranscribe`` ignores both.
        wsUrlTab: message.wsUrlTab ?? null,
        audioFormatTab: message.audioFormatTab ?? null,
      });
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Make sure no half-built state leaks.
      await tearDown({ reason }).catch(() => {});
      await sendMessage({
        type: MessageType.TRANSCRIBE_LIFECYCLE,
        phase: 'error',
        reason,
      }).catch(() => {});
      return { ok: false, error: reason };
    }
  },
  [MessageType.OFFSCREEN_TRANSCRIBE_STOP]: async () => {
    // Mark BOTH substreams stopping (mode=both) so their in-flight
    // close handlers don't re-enter attemptReconnect.
    for (const s of activeStreams()) s.stopping = true;
    await tearDown({ reason: 'client_stop' });
    return { ok: true };
  },
  [MessageType.OFFSCREEN_TRANSCRIBE_PAUSE]: () => {
    // Drop PCM frames at the worklet → WS boundary on every active
    // substream. AudioContext + WebSocket stay alive so resume is
    // instant. The worklet keeps running because stopping it would
    // orphan the AudioContext's upstream MediaStream (Chrome warns
    // about that); a no-op worklet costs <0.1% CPU.
    for (const s of activeStreams()) s.paused = true;
    return { ok: true };
  },
  [MessageType.OFFSCREEN_TRANSCRIBE_RESUME]: () => {
    // Re-enable the frame pump on every active substream. If a
    // provider closed its WS during the pause (idle-timeout), the
    // worklet send hits the ws.readyState gate and silently drops;
    // the close handler already transitioned that substream to
    // stopped/error so the popup state reflects reality.
    for (const s of activeStreams()) s.paused = false;
    return { ok: true };
  },
  [MessageType.OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION]: (message) => {
    // Bug 11.1 — SW forwarded a DOM caption-author change for relay
    // ingestion. Best-effort; ``sendSpeakerObservation`` no-ops when
    // no transcribe session is active or the WS isn't OPEN.
    sendSpeakerObservation({
      name: message.name,
      wallClockMs: message.wallClockMs,
      source: message.source,
    });
    return { ok: true };
  },
  [MessageType.OFFSCREEN_MIC_MUTE]: (message) => {
    // The user toggled their IN-MEETING mic. Gate mic-sourced
    // substreams so their audio is NOT transcribed while muted
    // (parity with the recorder's mic-gain zeroing). The recording
    // offscreen handles this same message independently; both
    // contexts no-op when they have no relevant session.
    meetingMicMuted = !!message.muted;
    applyMicGate();
    return { ok: true, micMuted: meetingMicMuted };
  },
});
