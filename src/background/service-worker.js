// Service worker — orchestrator for the recording state machine.
//
// Responsibilities:
//   - Owns the state machine (IDLE | STARTING | RECORDING | STOPPING |
//     ERROR | NEEDS_REAUTH) and persists it to chrome.storage.session so
//     it survives SW suspension.
//   - Resolves the tabCapture streamId and hands it to the offscreen
//     document; creates and tears down the offscreen on demand.
//   - Drains the IndexedDB chunk queue with exponential backoff and
//     finalizes the meeting once the queue is empty.
//   - Watches tab navigation / closure and offscreen heartbeats; both
//     can force a transition to STOPPING / ERROR. The heartbeat
//     watchdog runs on chrome.alarms so it survives SW suspension —
//     a setInterval timer would die with the SW and never trip.
//   - Routes messages between popup, content scripts and offscreen via
//     a single onMessage handler.

import {
  BADGE,
  DEFAULT_MIC_GAIN,
  DEFAULT_TAB_GAIN,
  FEATURES_REFRESH_ALARM_NAME,
  FEATURES_REFRESH_PERIOD_MIN,
  HEARTBEAT_ALARM_NAME,
  HEARTBEAT_ALARM_PERIOD_MIN,
  HEARTBEAT_TIMEOUT_MS,
  IMPORTANT_POINTS_MAX,
  PERIODIC_SYNC_ALARM_NAME,
  PERIODIC_SYNC_PERIOD_MIN,
  TELEMETRY_EVENT_NAMES,
  MessageType,
  QUEUE_DEPTH_PAUSE,
  QUEUE_DEPTH_RESUME,
  QUEUE_DEPTH_WARN,
  RecordingState,
  Source,
  STOP_FORCE_ALARM_DELAY_MIN,
  STOP_FORCE_ALARM_NAME,
  STOP_FORCE_TIMEOUT_MS,
  StorageKey,
} from '../constants.js';
import {
  AuthError,
  authenticateWithProvider,
  drainChunkQueue,
  emitEvent,
  finalizeMeeting,
  FinalizeConflictError,
  getRecordingStatus,
  listUnfinalizedMeetings,
  markMeetingFinalized,
  parseDurationCap,
  pendingChunkCount,
  postRecordingEvent,
  recordMeeting,
  refreshFeaturesInfo,
  refreshUserName,
  startMeeting,
  startTranscribeSession,
} from '../api/client.js';
import {
  bufferEvent,
  flushTimeline,
  startTimelineFlusher,
} from '../api/timeline-buffer.js';
import { startTelemetryFlusher } from '../api/telemetry-buffer.js';
import { BridgeClient } from '../lib/bridge-client.js';
import { ensureMicPermission } from '../lib/mic-permission.js';
import {
  openControlWindow,
  closeControlWindow,
  handleWindowRemoved,
} from '../lib/control-window.js';
// STATIC import — must NOT be a dynamic import(). A dynamic import in
// the MV3 service worker makes Rollup wrap it in Vite's __vitePreload
// helper, which references ``document`` (undefined in a SW) and throws
// "An unknown error occurred when fetching the script", killing the
// SW (popup then shows channel_closed). The per-message replay tap
// fires constantly during record/transcribe, so this crashed every
// real session. Lazy-loading bought ~nothing (it's a tiny lib).
import * as sessionReplay from '../lib/session-replay.js';
import { onMessage, sendMessage, sendToTab } from '../lib/messaging.js';

// Single module-level bridge instance — paired or idle depending on
// options-page config. Survives SW restarts: on boot we re-read the
// stored config below and call ``setConfig`` so the WS attempts a
// fresh connect with no user interaction needed.
const bridge = new BridgeClient();
// When a pair lands or drops, tell every Meet/Teams content script so
// they activate/deactivate detection. The extension may NOT be recording
// in this case — the desktop is. Union with RECORDING_LIFECYCLE on the
// content side.
bridge.onPairedChange((paired) => {
  void broadcastBridgeLifecycle(paired);
});

async function broadcastBridgeLifecycle(paired) {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://meet.google.com/*', 'https://teams.microsoft.com/*', 'https://teams.live.com/*'],
    });
    for (const t of tabs) {
      if (t.id == null) continue;
      await sendToTab(t.id, {
        type: MessageType.BRIDGE_LIFECYCLE,
        phase: paired ? 'started' : 'stopped',
        t0: paired ? Date.now() : null,
      });
    }
  } catch {
    // chrome.tabs.query can fail when the SW races extension reload —
    // the next bridge transition (or the content script's own message
    // sync) will repair the lifecycle state.
  }
}

async function loadAndApplyBridgeConfig() {
  try {
    const got = await chrome.storage.local.get([
      StorageKey.BRIDGE_ENABLED,
      StorageKey.BRIDGE_TOKEN,
    ]);
    bridge.setConfig({
      enabled: !!got[StorageKey.BRIDGE_ENABLED],
      token: got[StorageKey.BRIDGE_TOKEN] || '',
    });
  } catch {
    // Storage occasionally throws during SW cold start; the next
    // BRIDGE_CONFIG_CHANGED or a follow-up boot will resync.
  }
}

// Boot — apply the persisted bridge config so a relaunch / SW wake
// re-attaches without the user toggling anything.
void loadAndApplyBridgeConfig();

// Boot — backfill the user's backend display name for installs that
// signed in before mm_user_name existed (or whose previous
// /user/profile fetch was lost). One-shot: only fires if we have an
// auth bundle but no
// cached name yet. refreshUserName is best-effort + tolerates the
// signed-out / no-token case (call returns null).
(async () => {
  try {
    const got = await chrome.storage.local.get([
      StorageKey.AUTH_TOKEN,
      StorageKey.USER_NAME,
    ]);
    if (got[StorageKey.AUTH_TOKEN] && !got[StorageKey.USER_NAME]) {
      void refreshUserName();
    }
  } catch {
    /* storage may be unavailable mid cold-start — next wake retries */
  }
})();

// Boot — refresh the subscription feature-gate snapshot if we have
// an auth bundle. Fire-and-forget; the popup default-allows when the
// snapshot is missing, so a slow / failed refresh never blocks the
// UI. A periodic alarm (below) keeps it warm.
(async () => {
  try {
    const got = await chrome.storage.local.get(StorageKey.AUTH_TOKEN);
    if (got[StorageKey.AUTH_TOKEN]) {
      void refreshFeaturesInfo();
    }
  } catch {
    /* storage may be unavailable mid cold-start — alarm covers it */
  }
})();

// Install the periodic feature-gate refresh alarm. Survives SW
// suspension (chrome.alarms). Idempotent — re-create only if absent
// so a SW restart doesn't reset the schedule.
async function ensureFeaturesRefreshAlarm() {
  try {
    const existing = await chrome.alarms.get(FEATURES_REFRESH_ALARM_NAME);
    if (existing) return;
    await chrome.alarms.create(FEATURES_REFRESH_ALARM_NAME, {
      periodInMinutes: FEATURES_REFRESH_PERIOD_MIN,
      // Slight initial delay so a SW cold-start doesn't double-fire
      // alongside the boot-time backfill above.
      delayInMinutes: FEATURES_REFRESH_PERIOD_MIN,
    });
  } catch { /* alarms unavailable in some test shims */ }
}
void ensureFeaturesRefreshAlarm();

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

// Live-transcribe state machine. Independent of RecordingState
// because the two features have separate lifecycles; mutual
// exclusion is enforced at the message-handler boundary so a
// half-finished transition can't deadlock the other feature.
const TranscribeState = Object.freeze({
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  // WS dropped — offscreen is walking the backoff schedule. See the
  // constants.js entry for the full state-machine doc.
  RECONNECTING: 'RECONNECTING',
  STOPPING: 'STOPPING',
  ERROR: 'ERROR',
});

const INITIAL_TRANSCRIBE_STATE = Object.freeze({
  state: TranscribeState.IDLE,
  // For ``mode === 'self' | 'participants'``: the one session id.
  // For ``mode === 'both'``: the MIC-substream session id. Existing
  // single-substream code paths read ``sessionId`` and keep working
  // unchanged when in mode='both' (they operate on the mic stream).
  sessionId: null,
  // Only populated for ``mode === 'both'`` — the TAB-substream session
  // id. Backend treats it as an independent session; the pairing
  // lives in SW state. Each substream has its own WS, its own
  // reconnect lifecycle, and its own billable audio_seconds.
  sessionIdTab: null,
  // The ws_url(s) for the live substream(s) — kept so ``stopTranscribe``
  // can DEFENSIVELY release the backend row even when the offscreen's
  // own WS close never reached the server (stop during STARTING with a
  // still-CONNECTING socket, offscreen unreachable, or a reconnect
  // that just minted a fresh row whose WS hadn't opened yet). The
  // backend has NO REST cancel — a ``live`` row is freed ONLY by a
  // WS open→close — so without this the row lingered ``live`` for the
  // 5h stale-grace and burned the per-user concurrency cap (3),
  // surfacing as "max 3 concurrent live-transcribe sessions reached".
  // Updated by reconnect (refreshTranscribeReconnectUrl) too.
  wsUrl: null,
  wsUrlTab: null,
  mode: null,         // 'self' | 'participants' | 'both'
  language: null,
  sourceHint: null,   // 'google_meet' | 'ms_teams' | null
  tabId: null,        // for routing transcript events to the overlay
  startedAt: null,
  error: null,
  // Reconnect progress mirror — populated only while state is
  // RECONNECTING. The popup uses these to render "Reconnecting (N/M)…".
  reconnectAttempt: 0,
  reconnectMaxAttempts: 0,
  // Phase U2 — last reported VAD drop% from the worklet. Updated on
  // every ``vad_stats`` telemetry event (every 60s while transcribing).
  // Popup renders a "Voice activity: 38%" indicator so the user can
  // see Phase C's cost lever working in real time.
  vadDroppedPct: null,
  // Last heap-watermark threshold crossed in the offscreen transcribe
  // pipeline (100/200/300 MB) — the popup uses this for a "Memory:
  // 180 MB" subtle warning. Updated by the heap watchdog via
  // ``heap_high_water_mark`` telemetry.
  heapMb: 0,
  // Phase L1 — flips true on the first inbound provider event
  // (TRANSCRIBE_FIRST_EVENT message from offscreen). The popup pill
  // labels the ACTIVE state as "Listening…" while this is false and
  // "Active" once it flips, giving the user a visible beat during
  // the cold-start window (today: 200-500ms while the backend opens
  // its upstream provider WS lazily). Reset to false on each fresh
  // open (including reconnect) so the indicator behaves consistently.
  hasFirstEvent: false,
  // Phase L4 — cumulative list of extracted action items / decisions
  // / questions / key takeaways from the live transcript. The relay
  // sends only NEW point IDs in each IMPORTANT_POINTS_UPDATE message
  // (it tracks the sent set server-side); the SW appends to this
  // list, deduping by id as a defence-in-depth in case the relay
  // resends after a reconnect. Reset on each fresh start (NOT on
  // reconnect — points accumulated before the WS drop are still
  // valid; the user shouldn't lose them when the network blips).
  importantPoints: [],
  // P5 — server-controlled per-session duration cap. Populated from
  // the first successful ``startTranscribeSession`` response; the
  // popup hides its countdown UX when ``durationCapSeconds`` is 0
  // (cap disabled / older backend). ``capExceeded`` latches when
  // the relay sends ``session_closed`` with ``duration_cap_exceeded``
  // so the popup can render a persistent "limit reached" banner.
  durationCapSeconds: 0,
  durationCapConsumedSeconds: 0,
  durationCapWarningAtSecondsRemaining: 0,
  capExceeded: false,
});

const INITIAL_STATE = Object.freeze({
  state: RecordingState.IDLE,
  meetingId: null,
  // User-supplied (or default "Meeting at … IST") name for the active
  // recording. Persisted in session state so the popup keeps showing
  // it across popup re-opens for the whole recording.
  meetingName: null,
  tabId: null,
  source: null,
  url: null,
  recordingStartedAt: null,
  micAvailable: false,
  uploadQueueDepth: 0,
  currentSpeaker: null,
  errorMessage: null,
  lastChunkIndex: -1,
  lastHeartbeatAt: 0,
  monitorBlocked: false,
  queueWarning: false,
  recordingPaused: false,
  // Independent of recordingPaused (which is back-pressure driven).
  // MediaRecorder is paused when EITHER is true, resumed only when BOTH
  // are false. Lets the user override or augment the auto-pause.
  userPaused: false,
  // Pause-aware elapsed clock. ``pausedAt`` = Date.now() of the
  // current user-pause (null while running); ``accumulatedPausedMs``
  // = total prior paused time this session. The popup + on-page
  // banner compute elapsed as
  // now − recordingStartedAt − accumulatedPausedMs − (paused? now−pausedAt :0)
  // so the timer FREEZES on pause and continues from the frozen value
  // on resume.
  pausedAt: null,
  accumulatedPausedMs: 0,
  // Phase U2 — visible-work indicators. ``isEncrypted`` is set from
  // the E2EE feature flag at start; popup renders a lock icon next
  // to the state pill. ``heapMb`` is the highest recent watermark
  // crossed (0 / 100 / 200 / 300); popup renders a subtle "Memory:
  // 180 MB" warning above the queue depth.
  isEncrypted: false,
  heapMb: 0,
  // P5 — server-controlled duration cap. ``durationCapSeconds`` is
  // the recording's hard maximum (default 3 h, configurable per
  // deployment); ``durationCapConsumedAtStart`` is the audio-seconds
  // already on the row when this session began — non-zero on a
  // resume-after-crash so the popup countdown doesn't reset to full
  // budget. ``capWarningEmitted`` latches so the toast doesn't
  // spam every tick. All zero / false means cap disabled (older
  // backend / deploy without the cap surface); the popup hides its
  // countdown badge entirely in that case.
  durationCapSeconds: 0,
  durationCapConsumedAtStart: 0,
  durationCapWarningAtSecondsRemaining: 0,
  capWarningEmitted: false,
  // Latched once an auto-stop is triggered (server 403 OR client-side
  // tick crosses zero) so the popup can show a persistent "limit
  // reached" banner separately from generic ERROR state.
  capExceeded: false,
});

// Volatile (in-memory) handles. These are intentionally NOT persisted —
// after a SW restart we re-derive what we can from storage and let the
// offscreen document re-announce itself via OFFSCREEN_READY.
//
// drainsInFlight is keyed by meetingId so live recording and orphan
// recovery can run concurrently against different meetings without
// blocking each other, and a second kickDrain for the same meetingId
// just returns the in-flight promise instead of starting a duplicate
// fetch loop.
const drainsInFlight = new Map();
let stopTimelineFlusher = null;
let stopForceTimer = null;
// Single-flight guard for finalizeAfterStop. It's invoked from three
// racing paths (RECORDING_STOPPED fire-and-forget, the stop force
// setTimeout, and the STOP_FORCE alarm) and internally awaits the
// chunk drain for seconds while state stays STOPPING — without this
// two paths reach finalizeMeeting()+markMeetingFinalized() for the
// same meeting → duplicate POST /finalize.
let finalizeInFlight = null;

// ---------------------------------------------------------------------------
// State helpers

async function getState() {
  const got = await chrome.storage.session.get(StorageKey.SESSION_STATE);
  return { ...INITIAL_STATE, ...(got[StorageKey.SESSION_STATE] ?? {}) };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ [StorageKey.SESSION_STATE]: next });
  paintBadge(next);
  // Best-effort broadcast — popup may be closed.
  await sendMessage({ type: MessageType.STATE_UPDATE, state: next });
  return next;
}

/**
 * Paint the toolbar action icon with a state-specific badge so the user
 * can see "recording" without opening the popup. Both a UX win and a
 * privacy/consent best practice — clear visual indication recording is on.
 *
 * Awaiting these would force the rest of setState() to wait on chrome.action
 * IPC; we fire-and-forget instead since a missed paint is purely cosmetic.
 */
function paintBadge(state) {
  const conf = BADGE[state.state] ?? BADGE.IDLE;
  void chrome.action.setBadgeText({ text: conf.text });
  void chrome.action.setBadgeBackgroundColor({ color: conf.color });
  // Hint text on hover. The default title (manifest action.default_title)
  // is restored when state goes IDLE.
  let title = 'MeetMinutes';
  if (state.state === RecordingState.RECORDING) {
    title = state.uploadQueueDepth > 0
      ? `MeetMinutes — recording • ${state.uploadQueueDepth} chunk(s) pending`
      : 'MeetMinutes — recording';
  } else if (state.state === RecordingState.STARTING) {
    title = 'MeetMinutes — starting…';
  } else if (state.state === RecordingState.STOPPING) {
    title = 'MeetMinutes — stopping…';
  } else if (state.state === RecordingState.NEEDS_REAUTH) {
    title = 'MeetMinutes — session expired, sign in again';
  } else if (state.state === RecordingState.ERROR) {
    title = `MeetMinutes — error: ${state.errorMessage ?? 'unknown'}`;
  }
  void chrome.action.setTitle({ title });
}

/**
 * Show a desktop notification that finalize completed. Best-effort —
 * notifications may be denied or muted; we don't surface that to the
 * user since the toolbar badge already reflects success (back to IDLE).
 */
function notifyFinalized(meetingId) {
  if (!chrome.notifications || !chrome.notifications.create) return;
  try {
    chrome.notifications.create(`mm_finalized_${meetingId}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('public/icons/icon-128.png'),
      title: 'MeetMinutes — recording uploaded',
      message: 'Your meeting has been finalized and is ready to process.',
      priority: 0,
    });
  } catch (err) {
    console.warn('[sw] notification failed', err);
  }
}

// setState variant that writes to storage but skips the STATE_UPDATE
// broadcast. Used for high-frequency internal-only fields (heartbeat
// timestamps) so we don't churn 30 messages + popup re-renders per minute.
// Anything the UI displays must go through setState().
async function setStateSilent(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ [StorageKey.SESSION_STATE]: next });
  return next;
}

// ---------------------------------------------------------------------------
// Live-transcribe state helpers — separate keyspace from recording so
// the popup can render both feature panels independently.

async function getTranscribeState() {
  const got = await chrome.storage.session.get(StorageKey.TRANSCRIBE_STATE);
  return {
    ...INITIAL_TRANSCRIBE_STATE,
    ...(got[StorageKey.TRANSCRIBE_STATE] ?? {}),
  };
}

async function setTranscribeState(patch) {
  const next = { ...(await getTranscribeState()), ...patch };
  await chrome.storage.session.set({ [StorageKey.TRANSCRIBE_STATE]: next });
  // Best-effort broadcast — popup may be closed; that's fine.
  await sendMessage({
    type: MessageType.TRANSCRIBE_STATE_UPDATE,
    state: next,
  }).catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Offscreen lifecycle

async function offscreenExists() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    // USER_MEDIA → tab/mic capture (chrome.tabCapture streamId +
    // getUserMedia). DISPLAY_MEDIA → CaptureSource.SCREEN, which in
    // MV3 MUST use getDisplayMedia() *inside the offscreen document*
    // (a desktopCapture streamId minted in the service worker is NOT
    // consumable by an offscreen doc — documented Chrome limitation,
    // postponed since 116). Declaring both reasons lets the single
    // shared offscreen serve recording (tab OR screen) + transcribe.
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
    justification:
      'Owns the AudioContext + MediaRecorder for tab/microphone capture and '
      + 'getDisplayMedia screen capture; must outlive the popup.',
  });
}

async function destroyOffscreen() {
  if (!(await offscreenExists())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (err) {
    console.warn('[sw] closeDocument failed', err);
  }
}

// Phase E — recording and live-transcription SHARE the one offscreen
// doc (MV3 allows exactly one). A feature-scoped teardown must NOT
// close the doc while the OTHER feature is still using it, or
// stopping a recording would kill a live transcription mid-sentence
// (and vice-versa). This is the reference-count: derive "is the
// other feature still busy" from the two existing state machines
// rather than a separate persisted counter (the SW is ephemeral —
// state.session is the durable source of truth). Close only when
// BOTH are idle.
async function destroyOffscreenIfIdle() {
  const [rec, tr] = await Promise.all([getState(), getTranscribeState()]);
  const recBusy =
    rec.state === RecordingState.RECORDING ||
    rec.state === RecordingState.STARTING ||
    rec.state === RecordingState.STOPPING;
  const trBusy =
    tr.state === TranscribeState.ACTIVE ||
    tr.state === TranscribeState.STARTING ||
    tr.state === TranscribeState.PAUSED ||
    tr.state === TranscribeState.RECONNECTING ||
    tr.state === TranscribeState.STOPPING;
  if (recBusy || trBusy) return; // the other feature still needs it
  await destroyOffscreen();
}

// ---------------------------------------------------------------------------
// tabCapture streamId

function getMediaStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      const err = chrome.runtime.lastError;
      if (err || !streamId) {
        // ``lastError.message`` is sometimes an EMPTY string (Chrome
        // refuses without a reason), which ``?? fallback`` doesn't
        // catch — that produced the bare "Could not capture the tab —"
        // with no cause. Coalesce on falsiness so a real reason always
        // shows. The most common empty-reason case is the missing
        // activeTab gesture / a tab already being captured.
        const reason = (err && err.message)
          || (!streamId ? 'no stream id returned' : '')
          || 'tab capture refused by Chrome (is the meeting tab the active, '
             + 'focused tab? is it already being captured/recorded?)';
        reject(new Error(reason));
        return;
      }
      resolve(streamId);
    });
  });
}

// CaptureSource.SCREEN no longer uses the desktop-capture chooser
// API: a stream id minted for it in the service worker cannot be
// consumed by an offscreen document (MV3 limitation). The offscreen
// document calls getDisplayMedia() directly instead (it owns the
// DISPLAY_MEDIA reason) — see getDesktopStream() in offscreen.js.
// getDisplayMedia needs no extension permission, so that manifest
// permission was dropped (least privilege).

// ---------------------------------------------------------------------------
// Heartbeat watchdog (chrome.alarms — survives SW suspension)
//
// We persist `lastHeartbeatAt` into session state so a wake-up can
// answer "how long has offscreen been silent?" without relying on
// in-memory variables. On the first wake after a cold start we record
// `now` and skip the threshold check — that gives the offscreen one
// alarm period (~30s) to phone home before we declare it dead.

async function ensureWatchdogAlarm() {
  const existing = await chrome.alarms.get(HEARTBEAT_ALARM_NAME);
  if (existing) return;
  await chrome.alarms.create(HEARTBEAT_ALARM_NAME, {
    periodInMinutes: HEARTBEAT_ALARM_PERIOD_MIN,
  });
}

async function clearWatchdogAlarm() {
  await chrome.alarms.clear(HEARTBEAT_ALARM_NAME);
}

// P5 — duration-cap alarms. Two scheduled fires: one for the optional
// "X minutes left" warning toast, one for the hard auto-stop. Both
// alarms are absolute (chrome.alarms.create with ``when``) so SW
// suspension doesn't drift the fire time. Pause-aware: cleared in
// :py:meth:`onUserPause` (well, the message handler) and re-scheduled
// on resume with the updated remaining budget.
//
// We could compute everything from one alarm, but two named alarms
// keeps the code path obvious: ``DURATION_CAP_WARNING_ALARM_NAME``
// fires the toast, ``DURATION_CAP_AUTOSTOP_ALARM_NAME`` ends the
// recording. Each has its own min-delay clamp because chrome.alarms
// rounds delays below a minimum threshold up to that threshold.
const DURATION_CAP_WARNING_ALARM_NAME = 'duration-cap-warning';
const DURATION_CAP_AUTOSTOP_ALARM_NAME = 'duration-cap-autostop';

async function scheduleDurationCapAlarm({
  capSeconds, consumedAtStart, warningAtSecondsRemaining,
}) {
  // Always clear before scheduling so a reschedule (resume after
  // pause, or a re-init via setState) doesn't leave a stale alarm
  // tied to the previous remaining-budget calculation.
  await clearDurationCapAlarms();
  if (!capSeconds || capSeconds <= 0) return;
  const remainingSeconds = Math.max(0, capSeconds - consumedAtStart);
  if (remainingSeconds <= 0) {
    // Already past the cap (resume-after-crash hit a row past its
    // budget) — fire the auto-stop synchronously rather than
    // scheduling for "now" which chrome.alarms would silently
    // round up to ~30 s.
    await fireDurationCapAutostop();
    return;
  }
  const now = Date.now();
  const autostopAt = now + remainingSeconds * 1000;
  await chrome.alarms.create(DURATION_CAP_AUTOSTOP_ALARM_NAME, {
    when: autostopAt,
  });
  // Warning toast — only schedule if (a) threshold > 0 and (b)
  // there's enough budget left for the warning to land before the
  // auto-stop. A new install / 5-min meeting with a 5-min warning
  // would otherwise fire the warning + auto-stop on top of each other.
  if (
    warningAtSecondsRemaining > 0
    && warningAtSecondsRemaining < remainingSeconds
  ) {
    const warnAt = autostopAt - warningAtSecondsRemaining * 1000;
    await chrome.alarms.create(DURATION_CAP_WARNING_ALARM_NAME, {
      when: warnAt,
    });
  }
}

async function clearDurationCapAlarms() {
  await chrome.alarms.clear(DURATION_CAP_WARNING_ALARM_NAME);
  await chrome.alarms.clear(DURATION_CAP_AUTOSTOP_ALARM_NAME);
}

async function fireDurationCapAutostop() {
  const cur = await getState();
  // Idempotent — the chunk-upload 403 path or a user-initiated stop
  // can race us. Both end with finalize; we just need the cap details
  // surfaced so the popup shows the limit-reached banner.
  if (cur.capExceeded) return;
  await setState({ capExceeded: true });
  emitEvent('cap_exceeded_from_alarm', {
    meetingId: cur.meetingId,
    capSeconds: cur.durationCapSeconds,
    consumedAtStart: cur.durationCapConsumedAtStart,
  });
  // ``stopRecording`` is a no-op outside RECORDING/STARTING; safe
  // regardless of what state we wake into.
  await stopRecording({ reason: 'duration_cap_exceeded' });
}

async function fireDurationCapWarning() {
  const cur = await getState();
  if (cur.capWarningEmitted || cur.capExceeded) return;
  if (cur.state !== RecordingState.RECORDING) return;
  await setState({ capWarningEmitted: true });
  // Broadcast a popup-friendly message; the popup renders a toast
  // and the in-page banner adds a "minutes-left" label.
  await sendMessage({
    type: MessageType.CAP_WARNING,
    capSeconds: cur.durationCapSeconds,
    warningAtSecondsRemaining: cur.durationCapWarningAtSecondsRemaining,
  });
}


// Live-transcribe duration-cap BACKSTOP.
//
// The relay is the PRECISE enforcer: it sends
// ``TRANSCRIBE_DURATION_CAP_EXCEEDED`` at the exact cap boundary. But
// if that signal never arrives (relay bug, or the WS already dropped
// right at the boundary) a transcribe session could run past the cap
// with nothing client-side to stop it. This alarm is the safety net.
//
// DISTINCT alarm name from the recording cap because recording AND
// transcribe can run at the same time (Phase E) — sharing the name
// would let one clobber the other's schedule. A grace margin
// (TRANSCRIBE_CAP_BACKSTOP_GRACE_MS) lands the backstop AFTER the
// relay's cap so it never cuts a session early under normal operation;
// re-arming on resume with the full remaining budget keeps it
// generous-on-pause (a backstop should err toward NOT cutting a
// legitimate session, since the relay does the precise accounting).
const TRANSCRIBE_DURATION_CAP_AUTOSTOP_ALARM_NAME =
  'transcribe-duration-cap-autostop';
const TRANSCRIBE_CAP_BACKSTOP_GRACE_MS = 90_000;

async function scheduleTranscribeDurationCapAlarm({
  capSeconds, consumedAtStart,
}) {
  await chrome.alarms.clear(TRANSCRIBE_DURATION_CAP_AUTOSTOP_ALARM_NAME);
  if (!capSeconds || capSeconds <= 0) return;
  const remainingSeconds = Math.max(0, capSeconds - (consumedAtStart || 0));
  const when = Date.now()
    + remainingSeconds * 1000
    + TRANSCRIBE_CAP_BACKSTOP_GRACE_MS;
  await chrome.alarms.create(TRANSCRIBE_DURATION_CAP_AUTOSTOP_ALARM_NAME, {
    when,
  });
}

async function clearTranscribeDurationCapAlarm() {
  await chrome.alarms.clear(TRANSCRIBE_DURATION_CAP_AUTOSTOP_ALARM_NAME);
}

async function fireTranscribeDurationCapAutostop() {
  const cur = await getTranscribeState();
  // Idempotent vs the relay's TRANSCRIBE_DURATION_CAP_EXCEEDED path and
  // a user stop — only act if a session is actually live.
  if (cur.state === TranscribeState.IDLE) return;
  emitEvent('transcribe_cap_exceeded_from_alarm', {
    sessionId: cur.sessionId,
    capSeconds: cur.durationCapSeconds,
  });
  await stopTranscribe({ reason: 'duration_cap_exceeded' });
}


// Periodic background-sync alarm — Phase D #4. Long period so the
// SW barely wakes (battery + Chrome's freezing budget); just enough
// to drain any orphan chunks left over from a session that ended
// while the network was down. Installed once at module load so it
// persists across SW restarts AND chrome restarts.
async function ensurePeriodicSyncAlarm() {
  const existing = await chrome.alarms.get(PERIODIC_SYNC_ALARM_NAME);
  if (existing) return;
  await chrome.alarms.create(PERIODIC_SYNC_ALARM_NAME, {
    periodInMinutes: PERIODIC_SYNC_PERIOD_MIN,
    // Slight jitter on the FIRST fire so multiple installs don't
    // synchronize on the same wall-clock tick. ``delayInMinutes``
    // overrides the implicit "next period" of the first fire.
    delayInMinutes: PERIODIC_SYNC_PERIOD_MIN,
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === STOP_FORCE_ALARM_NAME) {
    const cur = await getState();
    if (cur.state !== RecordingState.STOPPING) return;
    console.warn('[sw] stop timeout (alarm) — forcing finalize after SW suspend');
    await finalizeAfterStop({ forced: true });
    return;
  }
  if (alarm.name === DURATION_CAP_AUTOSTOP_ALARM_NAME) {
    await fireDurationCapAutostop();
    return;
  }
  if (alarm.name === DURATION_CAP_WARNING_ALARM_NAME) {
    await fireDurationCapWarning();
    return;
  }
  if (alarm.name === TRANSCRIBE_DURATION_CAP_AUTOSTOP_ALARM_NAME) {
    await fireTranscribeDurationCapAutostop();
    return;
  }
  if (alarm.name === FEATURES_REFRESH_ALARM_NAME) {
    // Periodic refresh of the subscription feature-gate snapshot.
    // Skip when signed out (no token → no API call). Best-effort;
    // refreshFeaturesInfo handles its own errors and leaves the
    // existing cache intact on failure.
    try {
      const got = await chrome.storage.local.get(StorageKey.AUTH_TOKEN);
      if (got[StorageKey.AUTH_TOKEN]) {
        await refreshFeaturesInfo();
      }
    } catch { /* best-effort */ }
    return;
  }
  if (alarm.name === PERIODIC_SYNC_ALARM_NAME) {
    // Phase D #4 — periodic orphan drain. Skip if a session is
    // active; the live drain pump already covers that case and
    // running both at once would just contend on IDB.
    const rec = await getState();
    if (rec.state === RecordingState.RECORDING || rec.state === RecordingState.STARTING) {
      emitEvent(TELEMETRY_EVENT_NAMES.PERIODIC_SYNC_TICK, { skipped: 'recording' });
      return;
    }
    const tr = await getTranscribeState();
    if (tr.state === TranscribeState.ACTIVE || tr.state === TranscribeState.STARTING) {
      emitEvent(TELEMETRY_EVENT_NAMES.PERIODIC_SYNC_TICK, { skipped: 'transcribing' });
      return;
    }
    // Best-effort listing for the telemetry payload — exact counts
    // help us tell "alarm fires every 30 min but never sees work"
    // (good — the live drain pump handled everything) from "alarm
    // is catching real backlog every cycle" (bad — investigate the
    // live drain).
    let pendingMeetings = 0;
    try {
      const orphans = await listUnfinalizedMeetings();
      pendingMeetings = orphans.length;
    } catch {
      /* best-effort instrumentation */
    }
    emitEvent(TELEMETRY_EVENT_NAMES.PERIODIC_SYNC_TICK, {
      pendingMeetings,
    });
    if (pendingMeetings > 0) {
      void recoverOrphans();
    }
    return;
  }
  if (alarm.name !== HEARTBEAT_ALARM_NAME) return;
  const cur = await getState();
  // Phase B — the alarm now keeps the SW warm for BOTH active
  // recording AND active transcription. For transcription we don't
  // run a heartbeat-lost check (the offscreen has its own WS
  // ping/pong from Phase A), but periodic alarm firings prevent the
  // SW from being suspended during long stretches of inbound
  // provider events that aren't sufficient to keep it alive on
  // their own.
  const t = await getTranscribeState();
  const transcribeBusy =
    t.state === TranscribeState.ACTIVE
    || t.state === TranscribeState.STARTING
    || t.state === TranscribeState.PAUSED
    || t.state === TranscribeState.RECONNECTING;
  const recordingBusy = cur.state === RecordingState.RECORDING;
  if (!recordingBusy && !transcribeBusy) {
    // Nothing to watch — clean up the alarm so we don't churn.
    await clearWatchdogAlarm();
    return;
  }
  if (!recordingBusy) {
    // Transcribe-only — alarm's primary job is keeping the SW warm
    // during long sessions where inbound provider events alone don't
    // qualify. We also opportunistically detect a dead offscreen
    // here: USER_MEDIA-reasoned offscreens normally stay alive while
    // media flows, but a renderer crash / OOM kill / extension
    // reload can still drop the doc. Without this check the SW
    // state hangs at ACTIVE indefinitely with no transcripts
    // arriving and no UI signal. The backend's 45 s liveness
    // watchdog tears down the relay server-side, but the client
    // never learns about it.
    if (!(await offscreenExists())) {
      console.error('[sw] offscreen lost while transcribing — forcing teardown');
      await clearWatchdogAlarm();
      await setTranscribeState({
        state: TranscribeState.ERROR,
        error: 'offscreen_lost — transcription stopped; click Start to retry',
      });
    }
    return;
  }
  // MV3-correct timeline flush. ``startTimelineFlusher`` uses
  // ``setInterval``, which does NOT survive SW suspension — on a
  // typical recording the SW is evicted between the ~20s chunk POSTs
  // and that interval never fires again, so the ONLY surviving flush
  // was the one in ``stopRecording``. If the SW was asleep at stop
  // (or stop raced finalize) the entire buffered timeline was
  // stranded → no /timeline POST → no speaker_timelines row → no
  // timelines.json (mp4 still finalized fine since it doesn't depend
  // on this). This heartbeat alarm runs on chrome.alarms, which DOES
  // survive suspension, so piggy-back a best-effort drain here.
  // Swallow everything (incl. AuthError): an alarm tick must never
  // tear down a live recording — the stop path + chunk drain own
  // reauth.
  if (cur.meetingId) {
    try { await flushTimeline(cur.meetingId); } catch { /* best-effort */ }
  }

  const now = Date.now();
  if (cur.lastHeartbeatAt === 0) {
    // Cold-wake grace period — give offscreen one cycle to ping.
    await setStateSilent({ lastHeartbeatAt: now });
    return;
  }
  if (now - cur.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
    console.error('[sw] offscreen heartbeat lost', {
      idleMs: now - cur.lastHeartbeatAt,
    });
    await clearWatchdogAlarm();
    await setState({
      state: RecordingState.ERROR,
      errorMessage:
        'offscreen_heartbeat_lost — recording halted; pending chunks preserved on disk',
    });
  }
});

// ---------------------------------------------------------------------------
// Chunk drain pump + queue back-pressure
//
// onProgress(depth) is called by the drain pump on every iteration with
// the current pending count. We use it to:
//   - flip queueWarning on / off as depth crosses QUEUE_DEPTH_WARN
//   - send OFFSCREEN_PAUSE / OFFSCREEN_RESUME so MediaRecorder stops
//     producing new chunks while the queue is too deep, and resumes
//     once the network catches up. Hysteresis (PAUSE > RESUME > WARN)
//     keeps us from oscillating around a single threshold.

async function applyBackPressure(depth) {
  const cur = await getState();
  const patch = { uploadQueueDepth: depth };

  // Warn band — purely cosmetic; no recorder change.
  if (depth >= QUEUE_DEPTH_WARN && !cur.queueWarning) {
    patch.queueWarning = true;
  } else if (depth < QUEUE_DEPTH_WARN && cur.queueWarning) {
    patch.queueWarning = false;
  }

  // Pause band. The recorder is paused when EITHER recordingPaused (this
  // back-pressure flag) or userPaused is true; only resume the recorder
  // when both are clear. That way a user-paused recording stays paused
  // even if the queue drains, and a back-pressure pause persists across
  // user click cycles.
  if (
    depth >= QUEUE_DEPTH_PAUSE &&
    !cur.recordingPaused &&
    cur.state === RecordingState.RECORDING
  ) {
    if (!cur.userPaused) {
      // Already paused by user → MediaRecorder is paused; no-op.
      await sendMessage({ type: MessageType.OFFSCREEN_PAUSE });
    }
    patch.recordingPaused = true;
  } else if (
    depth <= QUEUE_DEPTH_RESUME &&
    cur.recordingPaused &&
    cur.state === RecordingState.RECORDING
  ) {
    if (!cur.userPaused) {
      await sendMessage({ type: MessageType.OFFSCREEN_RESUME });
    }
    patch.recordingPaused = false;
  }

  await setState(patch);
}

/**
 * Single-flight drain. If a drain for `meetingId` is already running,
 * returns its promise; otherwise starts a new one.
 *
 * `config` is forwarded to drainChunkQueue. The two callsites are:
 *   - kickLiveDrain — applies queue back-pressure + transitions to
 *     NEEDS_REAUTH on 401.
 *   - recoverOrphans — no-op progress, no-op auth handler (the next
 *     user-initiated start will surface the auth issue).
 */
function scheduleDrain(meetingId, config) {
  if (!meetingId) return null;
  const existing = drainsInFlight.get(meetingId);
  if (existing) return existing;
  const promise = (async () => {
    try {
      await drainChunkQueue({
        meetingId,
        shouldContinue: () => true,
        ...config,
      });
    } catch (err) {
      console.error('[sw] drain failed', err);
    } finally {
      drainsInFlight.delete(meetingId);
    }
  })();
  drainsInFlight.set(meetingId, promise);
  return promise;
}

function kickLiveDrain(meetingId) {
  return scheduleDrain(meetingId, {
    onProgress: applyBackPressure,
    onAuthLost: async () => {
      await clearWatchdogAlarm();
      await setState({
        state: RecordingState.NEEDS_REAUTH,
        errorMessage: 'auth_expired — re-enter token in options',
      });
    },
    // P5 — the server rejected a chunk because the recording hit its
    // cumulative duration cap. The drain has already stopped pumping;
    // we surface the cap details on state and pivot to stopRecording
    // so finalize runs against the truncated recording. Idempotent vs
    // the SW-side ticker auto-stop (whichever fires first wins; the
    // STATE_UPDATE for ``capExceeded`` is the same either way).
    onCapExceeded: async ({ capSeconds, consumedSeconds }) => {
      const cur = await getState();
      if (cur.capExceeded) return;
      await setState({
        capExceeded: true,
        durationCapSeconds: capSeconds,
        durationCapConsumedAtStart: Math.max(
          cur.durationCapConsumedAtStart || 0, consumedSeconds,
        ),
      });
      emitEvent('cap_exceeded_from_chunk_upload', {
        meetingId, capSeconds, consumedSeconds,
      });
      // ``stopRecording`` itself guards on state — calling from this
      // async path is safe regardless of what concurrent handlers do.
      await stopRecording({ reason: 'duration_cap_exceeded' });
    },
  });
}

// ---------------------------------------------------------------------------
// Orphan recovery
//
// When the SW (or browser) restarts mid-recording, the offscreen doc dies
// with its MediaStream — there's no way to revive the recording itself.
// But chunks already on disk can still be uploaded, and the meeting can
// be /finalize'd so the backend doesn't sit forever in "in progress".
//
// recordMeeting() is called from startRecording when /meetings/start
// succeeds; markMeetingFinalized() is called when /finalize succeeds.
// Anything left in the meetings store with finalized=false on the next
// startup is an orphan we try to recover here.

// W2/W3 — finalize + reconcile, shared by the stop path and orphan
// recovery so both behave identically.
//   'finalized' → server accepted (202); poll said finalized / still
//                 finalizing / terminal server failure. In all three
//                 the recording is tombstoned so orphan recovery stops
//                 re-POSTing /finalize (it's server-idempotent anyway).
//   'abandoned' → terminal 409/422 (no chunks / count disagreement);
//                 unrecoverable → tombstone, stop the orphan loop.
//   'missing'   → recoverable 409 with a missing[] list; left
//                 un-finalized for orphan recovery to retry later.
// AuthError propagates unchanged (caller parks in re-auth).
const FINALIZE_STATUS_POLLS = 6;       // bounded — don't block stop long
const FINALIZE_STATUS_POLL_MS = 3_000; // ≈18s ceiling, best-effort

async function settleFinalize(meetingId) {
  try {
    await finalizeMeeting(meetingId);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    if (err instanceof FinalizeConflictError) {
      if (err.terminal) {
        emitEvent(TELEMETRY_EVENT_NAMES.FINALIZE_ABANDONED, {
          meetingId, detail: String(err.detail || '').slice(0, 120),
        });
        return 'abandoned';
      }
      emitEvent(TELEMETRY_EVENT_NAMES.FINALIZE_MISSING_CHUNKS, {
        meetingId, missing: err.missing.slice(0, 50),
      });
      return 'missing';
    }
    throw err; // network / 5xx — caller leaves it for the next retry
  }
  // 202 accepted: the server stitches mp4 + thumbnail asynchronously.
  // Best-effort bounded poll so a server-terminal failure surfaces its
  // error_code and we stop treating it as recoverable. If it's still
  // finalizing when the budget runs out we hand off — finalize is
  // server-idempotent and keeps progressing without us.
  for (let i = 0; i < FINALIZE_STATUS_POLLS; i += 1) {
    let s;
    try {
      s = await getRecordingStatus(meetingId);
    } catch (e) {
      if (e instanceof AuthError) throw e;
      break; // status read failed — treat finalize as handed off
    }
    const st = s && s.status;
    if (st === 'failed' || st === 'error') {
      emitEvent(TELEMETRY_EVENT_NAMES.FINALIZE_SERVER_FAILED, {
        meetingId, errorCode: (s && s.error_code) ?? null,
      });
      return 'finalized'; // server-terminal → tombstone, never retry
    }
    if (st === 'finalized') return 'finalized';
    await new Promise((r) => setTimeout(r, FINALIZE_STATUS_POLL_MS));
  }
  return 'finalized';
}

async function recoverOrphans() {
  let orphans;
  try {
    orphans = await listUnfinalizedMeetings();
  } catch (err) {
    console.warn('[sw] orphan listing failed', err);
    return;
  }
  if (orphans.length === 0) return;
  console.info(`[sw] recovering ${orphans.length} orphan meeting(s)`);
  for (const m of orphans) {
    try {
      // Drain whatever chunks remain on disk via the same scheduler the
      // live path uses, so a concurrent kickLiveDrain for a different
      // meetingId runs alongside but a duplicate orphan-recovery call
      // for the same id just awaits the in-flight promise.
      const before = await pendingChunkCount(m.meetingId);
      if (before > 0) {
        const promise = scheduleDrain(m.meetingId, {
          onProgress: () => {},
          onAuthLost: () => {
            // Caller will discover NEEDS_REAUTH on next user start.
            console.warn('[sw] orphan recovery hit auth — deferring');
          },
        });
        if (promise) await promise;
      }
      const remaining = await pendingChunkCount(m.meetingId);
      if (remaining === 0) {
        const outcome = await settleFinalize(m.meetingId);
        if (outcome === 'missing') {
          // Server still expects chunks but the blobs were deleted on
          // their original successful upload — unrecoverable here.
          // Telemetry already emitted in settleFinalize; leave it for
          // the next startup (visible now via FINALIZE_MISSING_CHUNKS).
          console.warn(
            `[sw] orphan ${m.meetingId} finalize reports missing chunks`,
          );
        } else {
          // 'finalized' or 'abandoned' → tombstone so we stop retrying.
          await markMeetingFinalized(m.meetingId);
          emitEvent('orphan_recovered', {
            meetingId: m.meetingId,
            ageMs: Date.now() - (m.createdAt ?? Date.now()),
            chunksReplayed: before,
          });
        }
      } else {
        console.warn(
          `[sw] orphan ${m.meetingId} still has ${remaining} chunk(s); will retry next startup`,
        );
      }
    } catch (err) {
      if (err instanceof AuthError) {
        console.warn('[sw] orphan recovery auth lost; user must re-enter token');
        return;
      }
      console.warn(`[sw] orphan recovery failed for ${m.meetingId}`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Start / stop

async function startRecording({ tabId, url, source, name }) {
  const cur = await getState();
  if (cur.state !== RecordingState.IDLE && cur.state !== RecordingState.ERROR) {
    // Don't throw — give the popup the active session info so it can
    // offer a "switch to that tab" affordance instead of a generic error.
    return {
      code: 'busy',
      activeTabId: cur.tabId,
      activeUrl: cur.url,
      activeState: cur.state,
    };
  }
  // Phase E — recording and live-transcription may now run AT THE
  // SAME TIME. They already use independent MediaStream / AudioContext
  // / WS pipelines inside the one shared offscreen doc; the only
  // thing that made them mutually exclusive was (a) this guard and
  // (b) a stop on one tearing down the shared doc. (b) is fixed by
  // destroyOffscreenIfIdle (refcount), so the cross-feature guard is
  // removed. The same-feature guard above (already recording → busy)
  // still stands. The genuinely impossible combo — screen-capture
  // recording + screen-source transcription (two getDisplayMedia
  // pickers in one doc) — can't occur: transcription only ever
  // captures mic or tab, never the screen.
  await setState({
    ...INITIAL_STATE,
    state: RecordingState.STARTING,
    tabId,
    url,
    source,
    // Show the chosen name in the popup for the whole session, even
    // after the popup is closed and reopened.
    meetingName: (name && name.trim()) || null,
    errorMessage: null,
  });

  // A2 — the tabCapture streamId is short-lived (it must be consumed
  // by ``getUserMedia`` in the offscreen doc within a few seconds of
  // being minted). It is acquired LATER, immediately before the
  // OFFSCREEN_START dispatch, NOT here: ``startMeeting`` below is a
  // backend round-trip that on a slow / mobile network can take long
  // enough that a streamId minted now would be dead by the time the
  // offscreen consumes it (recording then fails silently mid-setup).
  // Fetching it last shrinks the staleness window to ~0.

  // Phase F — read the E2EE flag once at start. The offscreen doc
  // owns the encryption hot path; we only need to communicate the
  // policy choice down + tell the backend so its transcription
  // worker can skip encrypted meetings (decryption isn't wired in
  // v1).
  const e2eeGot = await chrome.storage.local.get(StorageKey.E2EE_ENABLED);
  const e2eeEnabled = !!e2eeGot[StorageKey.E2EE_ENABLED];

  let meetingId;
  let durationCap = {
    maxDurationSeconds: 0,
    consumedSeconds: 0,
    warningAtSecondsRemaining: 0,
  };
  try {
    // Unified `POST /api/v1/recordings`: server mints the id; the old
    // `source`/`url` fields no longer exist (RecordingCreate is
    // extra="forbid"). Prefer the user-supplied / default meeting
    // name (popup sends a readable "Meeting at … IST" default when
    // blank); fall back to the URL only if no name came through.
    // ``isEncrypted`` is a server-side hint, not a security signal —
    // the backend treats encrypted chunks as opaque blobs either way;
    // it just lets the worker decide whether to attempt transcription.
    const result = await startMeeting({
      name: name || url,
      isEncrypted: e2eeEnabled,
    });
    // startMeeting aliases recording_id → meeting_id so the rest of
    // the SW (orphan recovery, IDB keying) is unchanged.
    meetingId = result.meeting_id;
    // P5 — capture the server-controlled duration cap. Older backends
    // / cap-disabled deploys yield zeros, which the popup interprets
    // as "no countdown UX". Resume-after-crash gets a non-zero
    // ``consumed_seconds`` so the popup picks up the countdown where
    // the previous run left off.
    durationCap = parseDurationCap(result);
  } catch (err) {
    if (err instanceof AuthError) {
      await setState({
        state: RecordingState.NEEDS_REAUTH,
        errorMessage: 'auth_expired — re-enter token in options',
      });
      return { code: 'auth' };
    }
    await setState({
      state: RecordingState.ERROR,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { code: 'error' };
  }

  await setState({
    meetingId,
    isEncrypted: e2eeEnabled,
    durationCapSeconds: durationCap.maxDurationSeconds,
    durationCapConsumedAtStart: durationCap.consumedSeconds,
    durationCapWarningAtSecondsRemaining:
      durationCap.warningAtSecondsRemaining,
    capWarningEmitted: false,
    capExceeded: false,
  });
  // P5 — schedule a single delayed alarm that fires when the cap would
  // be reached. Pause-aware via reschedule on pause/resume; the
  // user-visible countdown rendered by the popup reads consumed +
  // elapsed locally so it stays smooth even when the SW suspends
  // between alarms.
  if (durationCap.maxDurationSeconds > 0) {
    await scheduleDurationCapAlarm({
      capSeconds: durationCap.maxDurationSeconds,
      consumedAtStart: durationCap.consumedSeconds,
      warningAtSecondsRemaining: durationCap.warningAtSecondsRemaining,
    });
  } else {
    await clearDurationCapAlarms();
  }
  // Record metadata for orphan recovery — best-effort; a failure here
  // shouldn't block the recording.
  try {
    await recordMeeting({ meetingId, source, url });
  } catch (err) {
    console.warn('[sw] recordMeeting failed (continuing)', err);
  }
  // W8 — server-side lifecycle marker. Fire-and-forget: the helper
  // swallows every error and must never delay the recording start.
  void postRecordingEvent(meetingId, 'START_RECORDING');

  const gains = await chrome.storage.local.get([StorageKey.MIC_GAIN, StorageKey.TAB_GAIN]);
  const micGain = gains[StorageKey.MIC_GAIN] ?? DEFAULT_MIC_GAIN;
  const tabGain = gains[StorageKey.TAB_GAIN] ?? DEFAULT_TAB_GAIN;

  // Ensure the extension has mic permission BEFORE the offscreen doc
  // tries getUserMedia (it can't prompt itself). One-time window;
  // best-effort — a denial just means the recording is tab-audio
  // only, never a hard failure.
  await ensureMicPermission();

  await ensureOffscreen();

  // A2 — mint the tabCapture streamId NOW, the last thing before we
  // hand it to the offscreen doc, so it can't go stale during the
  // ``startMeeting`` round-trip / offscreen bootstrap above. A
  // tabCapture refusal (no activeTab grant, restricted page, user
  // dismiss) surfaces as ERROR so the popup shows something
  // actionable; the backend meeting created above is left for the
  // orphan-recovery sweep to finalize (same as offscreen_start_failed).
  // Capture-source choice (options page; default 'tab' so existing
  // installs are unaffected). 'screen' routes through desktopCapture
  // for the spec's "Screen sharing" + "System audio" capabilities.
  const capGot = await chrome.storage.local.get(StorageKey.CAPTURE_SOURCE);
  const captureSource =
    capGot[StorageKey.CAPTURE_SOURCE] === 'screen' ? 'screen' : 'tab';

  // TAB capture: the SW mints the tabCapture streamId (short-lived,
  // consumed by the offscreen's getUserMedia). SCREEN capture: there
  // is NO SW-side streamId — a desktopCapture streamId from the SW
  // can't be used in an offscreen doc (MV3 limitation), so the
  // offscreen document calls getDisplayMedia() itself (it owns the
  // DISPLAY_MEDIA reason). The picker is shown there.
  let streamId = null;
  if (captureSource !== 'screen') {
    try {
      streamId = await getMediaStreamId(tabId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await destroyOffscreenIfIdle();
      await setState({
        state: RecordingState.ERROR,
        errorMessage: `tabCapture_failed: ${message}`,
      });
      return { code: 'error' };
    }
  }

  // Offscreen may take a tick to become a message recipient.
  let started = false;
  let lastErr = 'offscreen_start_no_response';
  for (let i = 0; i < 20; i++) {
    const res = await sendMessage({
      type: MessageType.OFFSCREEN_START,
      streamId,
      meetingId,
      micGain,
      tabGain,
      // 'tab' → offscreen consumes ``streamId`` via getUserMedia
      // (chromeMediaSource:'tab'). 'screen' → ``streamId`` is null and
      // the offscreen calls getDisplayMedia() itself (DISPLAY_MEDIA
      // reason); the OS share-picker is shown there.
      captureSource,
      // Phase F — offscreen owns the encryption hot path so the
      // master key + meeting key never leave the offscreen doc's
      // crypto context. SW only forwards the policy bit.
      e2eeEnabled,
    });
    if (res.ok) {
      started = true;
      break;
    }
    if (res.error === 'no_receiver') {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    lastErr = res.error;
    break;
  }
  if (!started) {
    await destroyOffscreenIfIdle();
    await setState({
      state: RecordingState.ERROR,
      errorMessage: `offscreen_start_failed: ${lastErr}`,
    });
    return { code: 'error' };
  }

  // Lifecycle "started" with t0 is sent from the RECORDING_STARTED
  // handler below — only then do we have the authoritative timestamp.

  stopTimelineFlusher = startTimelineFlusher(
    () => meetingId,
    async (err) => {
      if (err instanceof AuthError) {
        await setState({ state: RecordingState.NEEDS_REAUTH });
      }
    },
  );

  kickLiveDrain(meetingId);
  return { code: 'started' };
}

async function stopRecording({ reason } = {}) {
  const cur = await getState();
  if (cur.state !== RecordingState.RECORDING && cur.state !== RecordingState.STARTING) {
    return;
  }
  await setState({
    state: RecordingState.STOPPING,
    errorMessage: reason ?? cur.errorMessage,
  });
  // P5 — once we're STOPPING the cap clock is academic; drop the
  // alarms so a slow finalize doesn't trip another stop attempt.
  await clearDurationCapAlarms();
  // Bug 3 — hide the user-visible recording UI IMMEDIATELY, before the
  // (potentially slow) final chunk drain + finalize. Previously the
  // in-page "● MeetMinutes • REC" banner and the detached control
  // window only went away inside finalizeAfterStop AFTER awaiting the
  // drain, so on a long recording the pill lingered for many seconds
  // and looked stuck. The drain/finalize still runs in the
  // background; these calls are idempotent so the backstop broadcast
  // in finalizeAfterStop is harmless.
  if (cur.tabId) {
    await sendToTab(cur.tabId, {
      type: MessageType.RECORDING_LIFECYCLE,
      phase: 'stopped',
    });
  }
  await closeControlWindow();
  await sendMessage({ type: MessageType.OFFSCREEN_STOP });
  scheduleStopForceTimeout();
}

function scheduleStopForceTimeout() {
  if (stopForceTimer) clearTimeout(stopForceTimer);
  stopForceTimer = setTimeout(async () => {
    stopForceTimer = null;
    const cur = await getState();
    if (cur.state !== RecordingState.STOPPING) return;
    console.warn('[sw] stop timeout — forcing finalize without offscreen ack');
    await finalizeAfterStop({ forced: true });
  }, STOP_FORCE_TIMEOUT_MS);
  // Backup alarm — survives SW suspension. Fast path (setTimeout) cancels
  // it via cancelStopForceTimeout; if the SW suspended, the alarm fires
  // after 30s and runs the same finalize path.
  void chrome.alarms.create(STOP_FORCE_ALARM_NAME, {
    delayInMinutes: STOP_FORCE_ALARM_DELAY_MIN,
  });
}

function cancelStopForceTimeout() {
  if (stopForceTimer) {
    clearTimeout(stopForceTimer);
    stopForceTimer = null;
  }
  void chrome.alarms.clear(STOP_FORCE_ALARM_NAME);
}

async function finalizeAfterStop(opts = {}) {
  // Single-flight: coalesce the three racing callers so finalize +
  // markFinalized run exactly once per stop (no duplicate /finalize).
  if (finalizeInFlight) return finalizeInFlight;
  finalizeInFlight = (async () => {
    try {
      await _finalizeAfterStopImpl(opts);
    } finally {
      finalizeInFlight = null;
    }
  })();
  return finalizeInFlight;
}

async function _finalizeAfterStopImpl({ forced = false } = {}) {
  cancelStopForceTimeout();
  const cur = await getState();
  if (!cur.meetingId) return;
  // Terminal-state guard: a clean finalize is only valid FROM
  // ``STOPPING``. A late/stale RECORDING_STOPPED arriving after the
  // session already went ERROR / NEEDS_REAUTH / IDLE (e.g. heartbeat-
  // lost watchdog, drain onAuthLost) must NOT run finalize nor
  // downgrade that terminal state back to IDLE. The forced paths
  // (timeout/alarm) already re-check STOPPING before calling us.
  if (cur.state !== RecordingState.STOPPING) return;

  // W8 — server-side lifecycle marker, emitted once the stop is
  // confirmed for this meeting (before the final drain/finalize).
  // Fire-and-forget; never delays teardown.
  void postRecordingEvent(cur.meetingId, 'STOP_RECORDING');

  // Wait for any in-flight drain, then drain again to ensure the final
  // chunk reaches the backend.
  const existing = drainsInFlight.get(cur.meetingId);
  if (existing) await existing;
  const followup = kickLiveDrain(cur.meetingId);
  if (followup) await followup;

  if (cur.tabId) {
    await sendToTab(cur.tabId, {
      type: MessageType.RECORDING_LIFECYCLE,
      phase: 'stopped',
    });
  }

  if (stopTimelineFlusher) {
    stopTimelineFlusher();
    stopTimelineFlusher = null;
  }

  // Helper: close out the SW-side resources (watchdog + offscreen) and
  // park us in NEEDS_REAUTH. Called from any AuthError branch below so
  // we don't leak the alarm or leave an offscreen doc consuming streams
  // for a recording that can't continue.
  const parkInReauth = async () => {
    await clearWatchdogAlarm();
    await destroyOffscreenIfIdle();
    await setState({
      state: RecordingState.NEEDS_REAUTH,
      errorMessage: 'auth_expired — re-enter token in options',
    });
  };

  try {
    await flushTimeline(cur.meetingId);
  } catch (err) {
    if (err instanceof AuthError) {
      await parkInReauth();
      return;
    }
  }

  // Only finalize on the backend once every chunk is shipped. If chunks
  // remain (NEEDS_REAUTH path), leave the meeting un-finalized so the
  // user can re-auth and resume; orphan recovery will retry on next
  // SW startup.
  const remaining = await pendingChunkCount(cur.meetingId);
  let finalized = false;
  if (remaining === 0) {
    try {
      const outcome = await settleFinalize(cur.meetingId);
      if (outcome === 'missing') {
        // Server still expects chunks — leave un-finalized; orphan
        // recovery retries on the next SW startup.
        console.warn(
          '[sw] finalize: server reports missing chunks; deferring',
        );
      } else {
        // 'finalized' (incl. server-terminal failure) or 'abandoned'
        // (terminal 409/422) → tombstone so we never re-POST finalize.
        await markMeetingFinalized(cur.meetingId);
        finalized = outcome === 'finalized';
      }
    } catch (err) {
      if (err instanceof AuthError) {
        await parkInReauth();
        return;
      }
      console.error('[sw] finalize failed', err);
    }
  }
  if (finalized) notifyFinalized(cur.meetingId);

  await clearWatchdogAlarm();
  await destroyOffscreenIfIdle();
  await setState({
    ...INITIAL_STATE,
    state: forced && remaining > 0 ? RecordingState.ERROR : RecordingState.IDLE,
    errorMessage: forced && remaining > 0
      ? 'stop_forced_with_pending_chunks'
      : null,
  });
  // The session is over — tear down the detached control window.
  // control.js also self-closes on the IDLE STATE_UPDATE; this is the
  // backstop for when that message wasn't delivered (window busy /
  // SW asleep). Idempotent + best-effort.
  await closeControlWindow();
}

// ---------------------------------------------------------------------------
// Tab event watchers

// Forget the detached control window if the user closes it manually,
// so a later "Open controls" recreates it instead of focusing a dead
// id. Guarded — chrome.windows is unavailable in some test shims.
if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    handleWindowRemoved(windowId);
  });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const cur = await getState();
  if (cur.tabId !== tabId) return;
  if (cur.state === RecordingState.RECORDING || cur.state === RecordingState.STARTING) {
    await stopRecording({ reason: 'recording_tab_closed' });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'loading' || !info.url) return;
  const cur = await getState();
  if (cur.tabId !== tabId) return;
  if (cur.state !== RecordingState.RECORDING) return;
  if (info.url === cur.url) return;
  await stopRecording({ reason: 'recording_tab_navigated' });
});

// Mirror for live-transcribe — if the meeting tab the transcript
// overlay lives in goes away, tear down the session so the offscreen
// doc can release the AudioContext + WebSocket.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const t = await getTranscribeState();
  if (t.tabId !== tabId) return;
  if (
    t.state === TranscribeState.ACTIVE
    || t.state === TranscribeState.STARTING
    || t.state === TranscribeState.PAUSED
    || t.state === TranscribeState.RECONNECTING
  ) {
    await stopTranscribe({ reason: 'transcribe_tab_closed' });
  }
});

// ---------------------------------------------------------------------------
// Live-transcribe start / stop

/**
 * Release a backend transcribe session that was minted but whose
 * audio WebSocket never ran. The backend has NO REST cancel — a
 * ``live`` row is only freed when its WS opens then disconnects, at
 * which point the relay ends the (empty) session and the row leaves
 * ``live`` so it stops counting against the per-user concurrency cap.
 * So we briefly open the ws_url and immediately close it. Strictly
 * best-effort + bounded; never throws.
 *
 * @param {string|null|undefined} wsUrl
 */
async function releaseTranscribeSession(wsUrl) {
  if (!wsUrl || typeof WebSocket === 'undefined') return;
  try {
    await new Promise((resolve) => {
      let done = false;
      let ws;
      const fin = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws && ws.close(1000, 'release'); } catch { /* noop */ }
        resolve();
      };
      const timer = setTimeout(fin, 6000);
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        fin();
        return;
      }
      ws.addEventListener('open', () => {
        // Opening then closing is enough — the relay marks the row
        // ended/error on disconnect, releasing the cap.
        try { ws.close(1000, 'release'); } catch { /* noop */ }
      });
      ws.addEventListener('close', fin);
      ws.addEventListener('error', fin);
    });
  } catch { /* best-effort — worst case the server stale-sweep gets it */ }
}

// The overlay content script's BUILT file path(s), read from the
// LIVE manifest at runtime. crxjs emits a content-hashed loader
// (``assets/overlay.js-loader-XXXX.js``) whose hash changes every
// build — hardcoding it would rot. Reading getManifest() keeps this
// correct across every rebuild.
function overlayContentScriptFiles() {
  try {
    const cs = chrome.runtime.getManifest().content_scripts || [];
    for (const entry of cs) {
      const js = entry.js || [];
      if (js.some((f) => /overlay/i.test(f))) return js;
    }
  } catch { /* manifest unreadable — caller falls back to plain send */ }
  return [];
}

// THE root-cause fix for "popup says Listening… but no overlay
// appears": MV3 does NOT auto-inject content scripts into tabs that
// were already open when the extension was installed/updated/
// reloaded. The popup is a fresh context so the SW reports ACTIVE,
// but ``chrome.tabs.sendMessage`` to the meeting tab fails silently
// ("Receiving end does not exist") and the overlay never mounts. We
// ping the tab; if the overlay script isn't answering we
// programmatically (re)inject it, then proceed. Idempotent: the
// overlay sets a global marker so a double-injection doesn't double-
// bind its message listener.
async function ensureOverlayInjected(tabId) {
  if (!tabId) return;
  const pong = await sendToTab(tabId, { type: MessageType.OVERLAY_PING });
  if (pong && pong.ok && pong.overlay) return; // already present
  const files = overlayContentScriptFiles();
  if (files.length === 0 || !chrome.scripting) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files,
    });
  } catch (err) {
    // Not a meeting tab, restricted page, or tab gone — nothing we
    // can do; the plain send below is a best-effort no-op then.
    console.warn('[sw] overlay inject failed', tabId, String(err));
  }
}

// Bug 4 — mount / unmount the in-tab overlay independently of the WS.
// The overlay used to appear only when the offscreen emitted 'started'
// on WS-open; for modes participants/both any failure BEFORE that
// (tabCapture refusal, no meeting tab, mint failure) meant the user
// saw nothing at all. We mount it the instant the session goes
// STARTING and explicitly unmount (with the reason) on every failure
// path so the panel either shows progress or shows WHY it failed.
async function mountTranscribeOverlay(tabId, mode) {
  if (!tabId) return;
  // Guarantee the content script is live in THIS tab first (handles
  // the extension-reloaded / pre-existing-tab case for every mode).
  await ensureOverlayInjected(tabId);
  // Test-only seam: when set, the overlay attaches its shadow root in
  // 'open' mode so an e2e harness can read the rendered turns. Unset
  // in production → overlay stays a closed shadow root as before.
  let e2eOpenShadow = false;
  try {
    const g = await chrome.storage.local.get('mm_e2e_open_shadow');
    e2eOpenShadow = g.mm_e2e_open_shadow === true;
  } catch { /* storage unavailable — default closed */ }
  await sendToTab(tabId, {
    type: MessageType.TRANSCRIBE_LIFECYCLE,
    phase: 'started',
    mode,
    isReconnect: false,
    e2eOpenShadow,
  });
}
async function unmountTranscribeOverlay(tabId, reason) {
  if (!tabId) return;
  await sendToTab(tabId, {
    type: MessageType.TRANSCRIBE_LIFECYCLE,
    phase: 'stopped',
    reason: reason ?? null,
  });
}

async function startTranscribe({ mode, language, tabId, url }) {
  // Phase E — transcription may run alongside an active recording
  // (independent pipelines in the shared offscreen doc; the doc is
  // refcounted by destroyOffscreenIfIdle). The old ``busy_recording``
  // cross-feature guard is removed. We still reject a SECOND
  // transcription session (same-feature) — one transcribe pipeline
  // at a time is a real constraint (the offscreen ``session`` /
  // ``sessionTab`` slots are singletons).
  const cur = await getTranscribeState();
  if (cur.state === TranscribeState.ACTIVE || cur.state === TranscribeState.STARTING) {
    return { code: 'busy_transcribing', activeTabId: cur.tabId };
  }

  const sourceHint = url ? detectSourceHint(url) : null;
  // Test-only: read the synthetic-capture flag here (the offscreen
  // doc has no chrome.storage) and forward it on the offscreen start
  // message. Never set in production.
  let e2eSyntheticCapture = false;
  try {
    const g = await chrome.storage.local.get('mm_e2e_synthetic_capture');
    e2eSyntheticCapture = g.mm_e2e_synthetic_capture === true;
  } catch { /* storage unavailable — stays false */ }
  await setTranscribeState({
    ...INITIAL_TRANSCRIBE_STATE,
    state: TranscribeState.STARTING,
    mode,
    language,
    sourceHint,
    tabId: tabId ?? null,
  });

  // Bug 4 — show the overlay NOW, before any step that can fail, for
  // EVERY mode. It renders "Listening…"; on failure we unmount it
  // with the reason (the overlay surfaces a non-benign reason).
  await mountTranscribeOverlay(tabId, mode);

  // Resource order mirrors the recording A2 pattern: acquire the mic
  // grant + offscreen doc, mint the backend session, then mint the
  // short-lived tabCapture streamId LAST (step 4.5) — immediately
  // before handing it + ws_url to the offscreen.
  //
  // WHY mint the session before the streamId (and not the reverse):
  // a backend session row is created in ``live`` state by POST
  // /transcribe/sessions and is ONLY released when its WebSocket
  // opens then closes (there is NO REST cancel). If the session is
  // minted first and a later step fails (offscreen never answers,
  // popup/channel closed) the row lingers ``live`` for the full
  // server stale-grace (5h) and counts against the per-user
  // concurrency cap (3) — three such leaks lock the user out of
  // live-transcribe entirely ("transcribe_concurrency_cap"). The two
  // remaining post-mint failure paths (tabCapture refusal at 4.5,
  // offscreen never answers at 5) BOTH explicitly release the row.
  //
  // WHY the streamId is dead-last (after the session, not before):
  // the tabCapture streamId must be consumed by the offscreen's
  // getUserMedia within a few seconds. mode='both' calls
  // ensureMicPermission() above, which can hold a permission window
  // open for up to 90s — a streamId minted before that is guaranteed
  // stale by the time the offscreen uses it ("Could not capture the
  // tab —"). It MUST be the last acquisition before the handoff.

  // 1. Validate the meeting tab for participants/both. The tabCapture
  //    streamId itself is minted LAST (step 4.5, just before the
  //    offscreen handoff) — see the A2 note there. Only the cheap
  //    no-tab guard runs here; no streamId, no session yet.
  let tabStreamId;
  const needsTabCapture = mode === 'participants' || mode === 'both';
  if (needsTabCapture && !tabId) {
    await setTranscribeState({
      state: TranscribeState.ERROR,
      error: 'mode_requires_meeting_tab',
    });
    await unmountTranscribeOverlay(tabId, 'mode_requires_meeting_tab');
    return { code: 'no_meeting_tab' };
  }

  // 2. mode 'self'/'both' captures the mic in the offscreen doc —
  //    ensure the one-time mic grant first (it can't prompt itself;
  //    the window can take up to 90s, so doing it pre-mint matters).
  if (mode === 'self' || mode === 'both') {
    await ensureMicPermission();
  }

  // 3. Offscreen doc up (still no backend session).
  await ensureOffscreen();

  // 4. NOW mint the backend session(s) — LAST, so nothing above could
  //    have leaked a live row. mode='both' = two independent sessions
  //    (mic=self, tab=participants); if either mint fails, the other
  //    is explicitly released so a partial both-mint can't leak.
  // Pair with the active recording (if any) so the relay can resolve
  // diarization labels ("Speaker A/B") to real participant names from
  // the recording's speaker timeline. Null when no recording is
  // running — the backend just strips placeholder labels.
  const recForPair = await getState();
  const pairedRecordingId = recForPair.meetingId || null;
  // D11 — pass the user's backend display name so the relay can
  // pre-bind the mic substream's first speaker number to it and skip
  // the user in the tab substream's diarization. Null/omitted is
  // backward-compatible: older backends ignore the field. Read raw
  // from storage (NOT email-derived) so we either send the real name
  // or nothing — the backend already has user.name server-side via
  // the bearer token, so omitting just lets it use that.
  let selfNameForSession = null;
  try {
    const got = await chrome.storage.local.get(StorageKey.USER_NAME);
    if (typeof got[StorageKey.USER_NAME] === 'string'
      && got[StorageKey.USER_NAME].trim()) {
      selfNameForSession = got[StorageKey.USER_NAME].trim();
    }
  } catch { /* storage unavailable — backend has it server-side */ }
  let session;       // self/participants → primary; both → mic
  let sessionTab;    // both → tab substream; null otherwise
  try {
    if (mode === 'both') {
      const [micR, tabR] = await Promise.allSettled([
        startTranscribeSession({
          mode: 'self', language, source_hint: sourceHint,
          recording_id: pairedRecordingId,
          self_name: selfNameForSession,
        }),
        startTranscribeSession({
          mode: 'participants', language, source_hint: sourceHint,
          recording_id: pairedRecordingId,
          self_name: selfNameForSession,
        }),
      ]);
      if (micR.status !== 'fulfilled' || tabR.status !== 'fulfilled') {
        if (micR.status === 'fulfilled') await releaseTranscribeSession(micR.value.ws_url);
        if (tabR.status === 'fulfilled') await releaseTranscribeSession(tabR.value.ws_url);
        throw (micR.reason ?? tabR.reason);
      }
      session = micR.value;
      sessionTab = tabR.value;
    } else {
      session = await startTranscribeSession({
        mode, language, source_hint: sourceHint,
        recording_id: pairedRecordingId,
        self_name: selfNameForSession,
      });
    }
  } catch (err) {
    if (err instanceof AuthError) {
      await setTranscribeState({
        state: TranscribeState.ERROR,
        error: 'auth_expired',
      });
      await unmountTranscribeOverlay(tabId, 'auth_expired');
      return { code: 'auth' };
    }
    await setTranscribeState({
      state: TranscribeState.ERROR,
      error: err?.code ? `${err.code}: ${err.detail ?? err.message}` : String(err),
    });
    await unmountTranscribeOverlay(
      tabId, err?.code ? `${err.code}` : 'transcribe_start_failed',
    );
    return { code: 'error', detail: err?.code ?? 'unknown' };
  }

  // (Overlay was already mounted at STARTING — see Bug 4 above. The
  // offscreen's own WS-open 'started' that follows is deduped by the
  // overlay's per-session idempotency guard, so it won't wipe the
  // transcript.)

  // 4.5 — mint the tabCapture streamId NOW, the LAST thing before the
  // offscreen consumes it via getUserMedia. A2: the streamId is
  // short-lived (must be consumed within a few seconds). The OLD code
  // minted it at step 1, BEFORE ensureMicPermission() — which for
  // mode='both' opens a mic-permission window of up to 90s — so by the
  // time the offscreen used it, it was dead and Chrome refused the
  // tab capture ("Could not capture the tab —"). Mode='participants'
  // got away with it (no mic step); mode='both' did not. This mirrors
  // the recording path's proven ordering (mint last, after the mic
  // window + offscreen bootstrap). The backend session(s) are already
  // minted above, so a mint failure here must release them — same
  // cleanup as the offscreen-never-answered path below — or the row
  // lingers ``live`` for the 5h stale-grace and burns the cap.
  if (needsTabCapture) {
    // Mode 3 specifically: opening the mic-permission window in step
    // 2 takes focus away from the meeting tab. By the time we reach
    // this step the user's focus may be on a different tab/window and
    // chrome.tabCapture.getMediaStreamId then refuses the capture with
    // "Extension has not been invoked for the current page". Re-focus
    // the meeting tab here to re-establish gesture context, then mint;
    // on a transient refusal (also seen with stale activeTab right
    // after the mic window closes), wait briefly + re-focus + retry
    // once. Beyond that we surface the error.
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      if (tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch { /* tab gone — mint below will surface its own error */ }

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        tabStreamId = await getMediaStreamId(tabId);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 300));
          try {
            await chrome.tabs.update(tabId, { active: true });
          } catch { /* tab gone */ }
        }
      }
    }
    if (lastErr) {
      const err = lastErr;
      const detail = `tabCapture_failed: ${err.message ?? err}`;
      await releaseTranscribeSession(session.ws_url);
      if (sessionTab?.ws_url) await releaseTranscribeSession(sessionTab.ws_url);
      await unmountTranscribeOverlay(tabId, detail);
      await setTranscribeState({
        state: TranscribeState.ERROR,
        error: detail,
      });
      return { code: 'error' };
    }
  }

  // 5. Hand the ws_url(s) to the offscreen; it opens the WS at once.
  let started = false;
  let lastErr = 'transcribe_start_no_response';
  for (let i = 0; i < 20; i++) {
    const res = await sendMessage({
      type: MessageType.OFFSCREEN_TRANSCRIBE_START,
      mode,
      // Test-only: the offscreen has no chrome.storage, so the SW
      // reads the synthetic-capture flag and forwards it. Always
      // false in production (key never set).
      e2eSynthetic: e2eSyntheticCapture,
      wsUrl: session.ws_url,
      audioFormat: session.audio_format ?? 'pcm_s16le',
      // Mode='both' ride-along: second WS URL + its audio format.
      // Ignored by the offscreen for single-mode starts.
      wsUrlTab: sessionTab?.ws_url ?? null,
      audioFormatTab: sessionTab?.audio_format ?? null,
      tabStreamId,
    });
    if (res.ok && res.data && res.data.ok !== false) {
      started = true;
      break;
    }
    if (res.error === 'no_receiver') {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    lastErr =
      (res.data && res.data.error) || res.error || 'transcribe_start_failed';
    break;
  }
  if (!started) {
    // The offscreen never opened the WS → the just-minted row(s)
    // would linger ``live`` for the 5h stale-grace and burn the
    // concurrency cap. Explicitly release them (open+close the WS —
    // the only release the backend exposes). Best-effort.
    await releaseTranscribeSession(session.ws_url);
    if (sessionTab?.ws_url) await releaseTranscribeSession(sessionTab.ws_url);
    // Don't destroy the offscreen doc here — recording may still
    // be using it. We optimistically mounted the overlay at STARTING
    // — tear it back down so a failed start doesn't orphan a panel.
    await unmountTranscribeOverlay(tabId, lastErr);
    await setTranscribeState({
      state: TranscribeState.ERROR,
      error: lastErr,
    });
    return { code: 'error', detail: lastErr };
  }

  // P5 — read the server-controlled cap off the primary (mic) session
  // response. ``startTranscribeSession`` returns the same shape for
  // both substreams, but the cap is per-recording so we use the
  // primary as the single source of truth.
  const transcribeCap = parseDurationCap(session);
  await setTranscribeState({
    state: TranscribeState.STARTING,
    sessionId: session.session_id,
    sessionIdTab: sessionTab?.session_id ?? null,
    // Kept so a later stop can guarantee the row is freed even if the
    // offscreen's WS close doesn't reach the backend (see state shape).
    wsUrl: session.ws_url,
    wsUrlTab: sessionTab?.ws_url ?? null,
    durationCapSeconds: transcribeCap.maxDurationSeconds,
    durationCapConsumedSeconds: transcribeCap.consumedSeconds,
    durationCapWarningAtSecondsRemaining:
      transcribeCap.warningAtSecondsRemaining,
    capExceeded: false,
  });
  // Arm the client-side cap BACKSTOP (relay remains the precise
  // enforcer; this only fires if its signal never arrives).
  if (transcribeCap.maxDurationSeconds > 0) {
    await scheduleTranscribeDurationCapAlarm({
      capSeconds: transcribeCap.maxDurationSeconds,
      consumedAtStart: transcribeCap.consumedSeconds,
    });
  } else {
    await clearTranscribeDurationCapAlarm();
  }
  // Phase B SW watchdog — keep the SW warm during long transcribe
  // sessions even when inbound provider events alone aren't enough.
  // The alarm handler now treats either RECORDING or ACTIVE
  // transcribe as "session in progress" and skips the heartbeat-lost
  // check for transcribe (offscreen has its own WS ping/pong).
  await ensureWatchdogAlarm();
  return { code: 'started' };
}


// Mint a fresh session row + ws_url so the offscreen doc can re-attach
// after a network drop. The offscreen drives the backoff loop (see
// ``attemptReconnect`` in offscreen/transcribe.js); this just refreshes
// the auth token and one-session-per-WS contract on the backend side.
//
// ``role`` distinguishes which substream is reconnecting in mode=both:
//   * 'mic' (or null/undefined for single-mode sessions) → fresh
//     mode='self' session, replaces ``sessionId``.
//   * 'tab' → fresh mode='participants' session, replaces
//     ``sessionIdTab``.
// The other substream is untouched; its WS keeps streaming.
async function refreshTranscribeReconnectUrl(role) {
  const cur = await getTranscribeState();
  // Only ACTIVE/PAUSED/RECONNECTING can ask for a refresh — anything
  // else means the user already stopped, or we're mid-startup.
  const okStates = new Set([
    TranscribeState.ACTIVE,
    TranscribeState.PAUSED,
    TranscribeState.RECONNECTING,
  ]);
  if (!okStates.has(cur.state)) {
    return { ok: false, error: 'not_reconnectable' };
  }
  // First call flips us into RECONNECTING; subsequent calls just
  // bump the attempt counter (offscreen sends its own progress).
  // For mode=both, a single substream reconnect surfaces the same
  // top-level RECONNECTING state — the popup pill can't show two
  // simultaneous reconnect counters and the user-visible signal is
  // the same either way ("we're reconnecting your transcription").
  if (cur.state !== TranscribeState.RECONNECTING) {
    await setTranscribeState({
      state: TranscribeState.RECONNECTING,
      reconnectAttempt: 0,
      reconnectMaxAttempts: 0,
    });
  }
  // Resolve substream identity: role='tab' uses the tab session id +
  // mode='participants'; everything else uses the mic / single-mode
  // primary slot.
  const isTab = role === 'tab';
  const childMode = isTab
    ? 'participants'
    : (cur.mode === 'both' ? 'self' : cur.mode);
  const parentSid = isTab ? cur.sessionIdTab : cur.sessionId;
  try {
    const recAtReconnect = await getState();
    // D11 — also pass self_name on reconnect so the freshly minted
    // backend row gets the same pre-bind hint as the original session.
    let selfNameForReconnect = null;
    try {
      const got = await chrome.storage.local.get(StorageKey.USER_NAME);
      if (typeof got[StorageKey.USER_NAME] === 'string'
        && got[StorageKey.USER_NAME].trim()) {
        selfNameForReconnect = got[StorageKey.USER_NAME].trim();
      }
    } catch { /* storage unavailable — backend has it server-side */ }
    const fresh = await startTranscribeSession({
      mode: childMode,
      language: cur.language,
      source_hint: cur.sourceHint,
      // Chain the new row back to the FIRST session of this logical
      // substream. The backend follows ``parent_session_id``
      // transitively so a multi-reconnect chain still resolves to a
      // single root. Each reconnect's parent is the CURRENT
      // substream's sessionId (already the latest link in the chain).
      parent_session_id: parentSid,
      // Re-pair with the active recording so the reconnected session
      // keeps resolving Speaker A/B → real names. Null if recording
      // ended while transcribe was reconnecting.
      recording_id: recAtReconnect.meetingId || null,
      self_name: selfNameForReconnect,
    });
    // Update only the substream's slot so the OTHER substream's
    // sessionId stays valid (its WS is still live in offscreen).
    // Track the FRESH row's ws_url alongside its session id so a stop
    // mid-reconnect (or after a reconnect whose WS hasn't opened yet)
    // still releases the row the offscreen couldn't.
    const patch = isTab
      ? { sessionIdTab: fresh.session_id, wsUrlTab: fresh.ws_url }
      : { sessionId: fresh.session_id, wsUrl: fresh.ws_url };
    await setTranscribeState(patch);
    return {
      ok: true,
      ws_url: fresh.ws_url,
      session_id: fresh.session_id,
      // Reconnect can land on a different provider when failover
      // fires server-side, so the encoding might change too. Pass
      // it through so the offscreen reconfigures the encoder.
      audio_format: fresh.audio_format ?? 'pcm_s16le',
    };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false, error: 'auth' };
    }
    const code = err?.code || 'unknown';
    return { ok: false, error: code, detail: err?.detail ?? err?.message };
  }
}

async function stopTranscribe({ reason } = {}) {
  const cur = await getTranscribeState();
  if (cur.state === TranscribeState.IDLE) return;
  // Drop the cap backstop alarm — the session is ending.
  await clearTranscribeDurationCapAlarm();
  await setTranscribeState({
    state: TranscribeState.STOPPING,
    error: reason ?? cur.error,
  });
  // Bug 2 — DETERMINISTIC stop. The old code only set STOPPING and
  // relied on the offscreen emitting TRANSCRIBE_LIFECYCLE 'stopped'
  // to reach IDLE. With the Phase-E offscreen refcount the doc can be
  // closed as part of teardown, so that event could be lost → state
  // stuck at STOPPING forever → the popup never re-enables Start and
  // a second session "won't start". Drive the terminal state here
  // ourselves; the offscreen's own 'stopped' (if it still arrives)
  // is idempotent.
  await sendMessage({ type: MessageType.OFFSCREEN_TRANSCRIBE_STOP }).catch(
    () => {},
  );
  // DEFENSIVE backend release. The offscreen's tearDown closes the
  // WS(s) above (awaited), which is what normally frees the ``live``
  // row — the backend has NO REST cancel. But that close does NOT
  // reliably reach the server when:
  //   • the user stopped during STARTING — the socket was still
  //     CONNECTING, and per the WS spec close() on a CONNECTING
  //     socket "fails the connection" with no clean close handshake,
  //     so the backend never sees an open→close;
  //   • the offscreen was unreachable / already gone (the catch above
  //     swallowed it) so nothing closed the socket;
  //   • a reconnect had just minted a fresh row whose WS hadn't
  //     opened yet.
  // In every one of those cases the row lingered ``live`` for the 5h
  // stale-grace and burned the per-user concurrency cap ("max 3
  // concurrent live-transcribe sessions reached"). Re-open+close the
  // ws_url(s) to force the release — the SAME sanctioned tool the
  // start-failure paths use. Idempotent: if the offscreen already
  // closed cleanly the row is no longer ``live`` and this is a quick
  // rejected reconnect; bounded (6s) and never throws.
  await releaseTranscribeSession(cur.wsUrl);
  if (cur.wsUrlTab) await releaseTranscribeSession(cur.wsUrlTab);
  // Tell the meeting tab so the overlay enters its stopped state
  // (Close button) deterministically — BEFORE we might close the
  // shared offscreen doc.
  if (cur.tabId) {
    await sendToTab(cur.tabId, {
      type: MessageType.TRANSCRIBE_LIFECYCLE,
      phase: 'stopped',
      reason: reason ?? 'client_stop',
    });
  }
  // Authoritative reset so a fresh session starts clean (clears
  // sessionId / mode / error etc.). Keep tabId so the overlay can
  // still be addressed if the user immediately restarts in-tab.
  await setTranscribeState({
    ...INITIAL_TRANSCRIBE_STATE,
    state: TranscribeState.IDLE,
    tabId: cur.tabId ?? null,
  });
  // Phase E refcount: free the shared offscreen doc only if recording
  // isn't using it. Done AFTER the state reset + tab broadcast so a
  // lost offscreen 'stopped' can't wedge us.
  await destroyOffscreenIfIdle();
}

async function pauseTranscribe() {
  const cur = await getTranscribeState();
  if (cur.state !== TranscribeState.ACTIVE) {
    return { ok: false, error: `cannot_pause_from_${cur.state}` };
  }
  // Flip local state BEFORE the offscreen message so the popup
  // re-renders immediately on the round-trip; the offscreen ack
  // is fast (<5ms) but we don't want a frame of "Active" while the
  // SW waits.
  await setTranscribeState({ state: TranscribeState.PAUSED });
  const res = await sendMessage({
    type: MessageType.OFFSCREEN_TRANSCRIBE_PAUSE,
  });
  // The offscreen handler returns an explicit ``{ok:true}`` which
  // messaging wraps as ``{ok:true, data:{ok:true}}``. If the offscreen
  // doc has died (renderer OOM / crash mid-session) Chrome doesn't
  // throw "no receiver" — other listener contexts exist, so
  // ``chrome.runtime.sendMessage`` resolves ``undefined`` and
  // messaging maps that to a bare ``{ok:true}`` with no ``data``.
  // Guarding on the outer ``res.ok`` alone would then SILENTLY leave
  // the session "PAUSED" while audio keeps streaming + billing.
  // Require the offscreen's inner ack to distinguish a real pause
  // from "nobody actually handled it".
  const acked = res.ok && res.data && res.data.ok === true;
  if (!acked) {
    // Offscreen unreachable — roll back so the popup doesn't lie
    // about being paused.
    await setTranscribeState({ state: TranscribeState.ACTIVE });
    return {
      ok: false,
      error: (res.data && res.data.error) || res.error || 'offscreen_unreachable',
    };
  }
  // Pause confirmed — freeze the cap backstop so a long legitimate
  // pause doesn't trip it; resume re-arms with the remaining budget.
  await clearTranscribeDurationCapAlarm();
  // Notify the overlay tab so it can dim its pulse dot.
  if (cur.tabId) {
    await sendToTab(cur.tabId, {
      type: MessageType.TRANSCRIBE_LIFECYCLE,
      phase: 'paused',
    });
  }
  return { ok: true };
}

async function resumeTranscribe() {
  const cur = await getTranscribeState();
  if (cur.state !== TranscribeState.PAUSED) {
    return { ok: false, error: `cannot_resume_from_${cur.state}` };
  }
  await setTranscribeState({ state: TranscribeState.ACTIVE });
  const res = await sendMessage({
    type: MessageType.OFFSCREEN_TRANSCRIBE_RESUME,
  });
  // See pauseTranscribe: a dead offscreen yields a bare {ok:true}
  // (undefined → messaging default), so require the inner ack or we'd
  // falsely report ACTIVE while nothing is streaming.
  const acked = res.ok && res.data && res.data.ok === true;
  if (!acked) {
    await setTranscribeState({ state: TranscribeState.PAUSED });
    return {
      ok: false,
      error: (res.data && res.data.error) || res.error || 'offscreen_unreachable',
    };
  }
  // Re-arm the cap backstop with the remaining budget (generous on
  // pause by design — the relay does the precise accounting).
  if (cur.durationCapSeconds > 0) {
    await scheduleTranscribeDurationCapAlarm({
      capSeconds: cur.durationCapSeconds,
      consumedAtStart: cur.durationCapConsumedSeconds,
    });
  }
  if (cur.tabId) {
    await sendToTab(cur.tabId, {
      type: MessageType.TRANSCRIBE_LIFECYCLE,
      phase: 'resumed',
    });
  }
  return { ok: true };
}

function detectSourceHint(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith('https://meet.google.com/')) return 'google_meet';
  if (url.startsWith('https://teams.microsoft.com/')
      || url.startsWith('https://teams.live.com/')) return 'ms_teams';
  return null;
}

// ---------------------------------------------------------------------------
// Message routing

// Per-message tap into the session-replay ring. Skips high-frequency
// messages that would drown the ring in noise without adding signal —
// transcript events fire ~5×/second during a busy call and audio
// levels even more frequently. Everything else gets a tiny sanitised
// stub appended so the "Report a problem" dump captures the message
// sequence leading up to the issue.
//
// Wrapped in a local function so the message handler stays readable
// — the body below just calls ``tapReplay(message)`` once at top.
async function _tapReplay(message) {
  try {
    if (!message || typeof message.type !== 'string') return;
    // Volume filter — these fire many-times-per-second and would
    // bury the signal entries (state transitions, errors, lifecycle).
    const noisy = new Set([
      MessageType.TRANSCRIPT_EVENT,
      MessageType.AUDIO_LEVELS,
      MessageType.OFFSCREEN_HEARTBEAT,
      MessageType.SPEAKER_CHANGE,
    ]);
    if (noisy.has(message.type)) return;
    await sessionReplay.appendReplay({
      kind: 'msg',
      payload: { type: message.type, ...message },
    });
  } catch {
    /* never break message routing on a replay failure */
  }
}


onMessage(async (message) => {
  void _tapReplay(message);
  switch (message.type) {
    case MessageType.GET_STATE: {
      return getState();
    }

    case MessageType.START_SOCIAL_AUTH: {
      // Web-assisted Google/Microsoft login. Runs HERE (not the popup)
      // so the chrome.identity.launchWebAuthFlow round-trip outlives
      // the ephemeral popup. authenticateWithProvider persists the
      // Firebase token bundle + bootstraps the backend user; the popup
      // re-renders off the resulting storage write (USER_EMAIL) just
      // like the email/password path.
      try {
        const { email } = await authenticateWithProvider(message.provider);
        return { ok: true, email };
      } catch (err) {
        const code = err && err.code ? err.code : 'unknown';
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg, code };
      }
    }

    case MessageType.OFFSCREEN_PING: {
      // Diagnostic relay. An external caller (popup health UI / e2e)
      // can't address the offscreen document directly, and a raw
      // broadcast would race this central router. Forward to the
      // offscreen and return ITS reply so there is a single
      // deterministic answer. The SW never receives its own
      // sendMessage, so this can't recurse.
      const res = await sendMessage({ type: MessageType.OFFSCREEN_PING });
      return (res && res.data) || { alive: false };
    }

    case MessageType.START_RECORDING: {
      const result = await startRecording({
        tabId: message.tabId,
        url: message.url,
        source: message.source,
        name: message.name,
      });
      // Pass through structured codes so the popup can show the right
      // affordance (busy → switch tab; auth → re-auth; error → message).
      if (result && result.code !== 'started') return result;
      return getState();
    }

    case MessageType.STOP_RECORDING: {
      await stopRecording();
      return getState();
    }

    case MessageType.FOCUS_CONTROL_WINDOW: {
      // Popup "Open controls" affordance — bring the detached window
      // back (recreated if the user closed it) so a live recording is
      // never orphaned. Only meaningful while a session is active.
      const cur = await getState();
      if (
        cur.state === RecordingState.RECORDING ||
        cur.state === RecordingState.STARTING ||
        cur.state === RecordingState.STOPPING
      ) {
        await openControlWindow();
      }
      return { ok: true };
    }

    case MessageType.USER_PAUSE: {
      const cur = await getState();
      if (cur.state !== RecordingState.RECORDING) {
        return { ok: false, error: 'not_recording' };
      }
      // If back-pressure already paused the recorder, MediaRecorder is
      // paused — sending OFFSCREEN_PAUSE again is a safe no-op. We still
      // flip userPaused so the recorder stays paused even after the
      // queue drains and back-pressure tries to resume.
      if (!cur.recordingPaused) {
        await sendMessage({ type: MessageType.OFFSCREEN_PAUSE });
      }
      // Stamp the pause so the popup/control elapsed clock freezes
      // (user-pause-only UX semantics — see the pausedAt docstring).
      await setState({
        userPaused: true,
        pausedAt: cur.pausedAt ?? Date.now(),
      });
      // P5 — freeze the cap clock by clearing both alarms. Resume
      // re-computes remaining from the (post-pause) accumulated time
      // and re-schedules. Mirrors the backend's pause-aware audio
      // accounting + the desktop client's tracker.pause() / start_or_resume().
      await clearDurationCapAlarms();
      // The content-script speaker-timeline clock + on-page banner are
      // NOT frozen here: OFFSCREEN_PAUSE makes the recorder actually
      // pause, which emits a RECORDER_CAPTURE_STATE edge that the SW
      // turns into the RECORDING_LIFECYCLE 'paused' broadcast. Driving
      // that single source covers back-pressure / offline / rotation
      // too and avoids the resumed-overlap double-count.
      return { ok: true };
    }

    case MessageType.USER_RESUME: {
      const cur = await getState();
      if (cur.state !== RecordingState.RECORDING) {
        return { ok: false, error: 'not_recording' };
      }
      // Fold the just-ended pause into the accumulated total so the
      // elapsed clock resumes from where it froze.
      const addMs = cur.pausedAt ? Math.max(0, Date.now() - cur.pausedAt) : 0;
      const newAccumulated = (cur.accumulatedPausedMs || 0) + addMs;
      await setState({
        userPaused: false,
        pausedAt: null,
        accumulatedPausedMs: newAccumulated,
      });
      // P5 — re-arm the cap alarms against the updated remaining
      // budget. ``activeSecondsSoFar`` is wall-clock-since-start minus
      // every pause window we've recorded so far — i.e. how many
      // seconds of audio the server has been billed for. The
      // remaining budget is ``capSeconds - (consumedAtStart + active)``.
      if (cur.durationCapSeconds > 0 && cur.recordingStartedAt) {
        const activeSecondsSoFar = Math.max(
          0,
          Math.floor(
            (Date.now() - cur.recordingStartedAt - newAccumulated) / 1000,
          ),
        );
        await scheduleDurationCapAlarm({
          capSeconds: cur.durationCapSeconds,
          consumedAtStart:
            cur.durationCapConsumedAtStart + activeSecondsSoFar,
          warningAtSecondsRemaining:
            cur.durationCapWarningAtSecondsRemaining,
        });
      }
      // Only actually resume the MediaRecorder if back-pressure isn't
      // still holding it paused. If it is, the queue-drain logic will
      // resume once depth falls below QUEUE_DEPTH_RESUME. Either way the
      // content-script timeline 'resumed' edge is driven by the
      // recorder's actual transition (RECORDER_CAPTURE_STATE), so it
      // correctly stays frozen while back-pressure still holds.
      if (!cur.recordingPaused) {
        await sendMessage({ type: MessageType.OFFSCREEN_RESUME });
      }
      return { ok: true };
    }

    case MessageType.FLUSH_TIMELINE: {
      const cur = await getState();
      if (!cur.meetingId) return { flushed: 0 };
      try {
        return await flushTimeline(cur.meetingId);
      } catch (err) {
        if (err instanceof AuthError) {
          await setState({ state: RecordingState.NEEDS_REAUTH });
        }
        throw err;
      }
    }

    case MessageType.REPORT_PROBLEM: {
      // Phase B — gather the session-replay ring + queue the resulting
      // bundle as a single telemetry event. The existing flusher
      // ships it on the next tick (or buffers if the endpoint isn't
      // live yet). We also include the current state snapshots so
      // ops can tell what mode the user was in when they reported.
      try {
        const report = await sessionReplay.buildReportPayload({ note: message.note });
        const rec = await getState();
        const tr = await getTranscribeState();
        // Attach minimal state context — these are tiny + diagnostic.
        report.payload.state = {
          recording: { state: rec.state, meetingId: rec.meetingId },
          transcribe: { state: tr.state, sessionId: tr.sessionId },
        };
        emitEvent(report.name, report.payload);
        // Best-effort clear so a follow-on report doesn't include
        // entries already shipped. If the flusher hasn't drained the
        // backlog yet, the entries already live in the telemetry
        // buffer — no loss either way.
        await sessionReplay.clearReplay();
        return { ok: true, entryCount: report.payload.entryCount };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    }

    case MessageType.OFFSCREEN_READY: {
      // After a SW wake-up, if we have an active session, we don't try
      // to revive the recording — Media streams die with the offscreen
      // document and cannot be resumed. We just ensure UI reflects truth.
      return { ok: true };
    }

    case MessageType.OFFSCREEN_HEARTBEAT: {
      // Internal-only field (used by the watchdog alarm). Skip broadcast.
      await setStateSilent({ lastHeartbeatAt: Date.now() });
      return { ok: true };
    }

    case MessageType.OFFSCREEN_ERROR: {
      await clearWatchdogAlarm();
      await setState({
        state: RecordingState.ERROR,
        errorMessage: `offscreen_error: ${message.error}`,
      });
      return { ok: true };
    }

    case MessageType.RECORDING_STARTED: {
      const cur = await getState();
      if (cur.state !== RecordingState.STARTING) {
        // Race: state advanced (e.g. tab closed during STARTING moved us
        // to STOPPING) before offscreen finished starting. Don't promote
        // to RECORDING — tell offscreen to stop so it isn't recording
        // into the void.
        await sendMessage({ type: MessageType.OFFSCREEN_STOP });
        return { ok: true };
      }
      const t0 = message.startedAt;
      await setState({
        state: RecordingState.RECORDING,
        recordingStartedAt: t0,
        micAvailable: !!message.micAvailable,
        lastHeartbeatAt: Date.now(),
      });
      await ensureWatchdogAlarm();
      // Now that we have an authoritative t0, brief the content script.
      const next = await getState();
      if (next.tabId) {
        await sendToTab(next.tabId, {
          type: MessageType.RECORDING_LIFECYCLE,
          phase: 'started',
          meetingId: next.meetingId,
          t0,
        });
      }
      // Recording is now truly live — open the detached control
      // window (level meters + pause/stop + duration). Best-effort;
      // a windowing failure must not affect the recording. The
      // toolbar popup resets to idle independently (see popup.js).
      await openControlWindow();
      return { ok: true };
    }

    case MessageType.CHUNK_PERSISTED: {
      const cur = await getState();
      await setState({ lastChunkIndex: message.chunkIndex });
      kickLiveDrain(cur.meetingId);
      return { ok: true };
    }

    case MessageType.RECORDING_STOPPED: {
      // offscreen has fully flushed its MediaRecorder.
      void finalizeAfterStop({ forced: false });
      return { ok: true };
    }

    case MessageType.RECORDER_CAPTURE_STATE: {
      // The offscreen recorder actually stopped/started capturing
      // media (any cause: user pause, queue back-pressure, offline
      // auto-pause, or the AudioContext-rotation handoff gap). Mirror
      // the edge into the content script's speaker-timeline clock so
      // it freezes for exactly the spans the final mp4 omits — keeping
      // the speaker timeline aligned with the mp4 playhead. This is the
      // SINGLE source of timeline pause edges (the offscreen recorder
      // state already aggregates every cause), so overlapping pauses
      // can't double-count. Only meaningful once RECORDING; the
      // offline-boot edge that arrives while STARTING is ignored here
      // and re-synced by offscreen's forced post-start notify. Distinct
      // from the pausedAt/accumulatedPausedMs UX fields (untouched here
      // — they keep user-pause-only semantics for the popup timer).
      const cur = await getState();
      if (cur.state !== RecordingState.RECORDING || !cur.tabId) {
        return { ok: true };
      }
      await sendToTab(cur.tabId, {
        type: MessageType.RECORDING_LIFECYCLE,
        phase: message.capturing ? 'resumed' : 'paused',
      }).catch(() => {});
      return { ok: true };
    }

    case MessageType.AUDIO_MONITOR_BLOCKED: {
      await setState({ monitorBlocked: true });
      emitEvent('monitor_blocked', { reason: message.reason ?? 'unknown' });
      return { ok: true };
    }

    case MessageType.AUDIO_MONITOR_RESTORED: {
      await setState({ monitorBlocked: false });
      return { ok: true };
    }

    case MessageType.RETRY_MONITOR: {
      // Popup -> SW -> offscreen relay. Carries the popup click's user
      // activation across the message hop; Chrome propagates it for
      // about a second after the gesture.
      const res = await sendMessage({ type: MessageType.RETRY_MONITOR });
      if (res.ok && res.data && res.data.ok) {
        await setState({ monitorBlocked: false });
      }
      return res.ok ? res.data : { ok: false, error: res.error };
    }

    case MessageType.MIC_MUTE_STATE: {
      // The user toggled their IN-MEETING mic. Forward to the
      // offscreen so it (a) zeroes the recorder's mic gain and
      // (b) gates the live-transcribe mic substream — the user's own
      // speech must not be captured/transcribed while muted. Forward
      // when EITHER feature is active (they share the offscreen doc;
      // each handler no-ops without its own session). Gating avoids
      // waking the doc needlessly.
      const recCur = await getState();
      const trCur = await getTranscribeState();
      const recBusy = recCur.state === RecordingState.RECORDING
        || recCur.state === RecordingState.STARTING;
      const trBusy = trCur.state === TranscribeState.ACTIVE
        || trCur.state === TranscribeState.STARTING
        || trCur.state === TranscribeState.PAUSED
        || trCur.state === TranscribeState.RECONNECTING;
      if (recBusy || trBusy) {
        await sendMessage({
          type: MessageType.OFFSCREEN_MIC_MUTE,
          muted: !!message.muted,
        }).catch(() => {});
      }
      // Also tell the live-transcribe overlay so it can immediately
      // drop the user's in-flight mic partial and suppress mic lines
      // while muted — otherwise the offscreen stops sending frames but
      // the last half-spoken sentence LINGERS on screen ("I muted but
      // still see my conversation"). Mic substream resumes on unmute.
      if (
        trBusy && trCur.tabId
        && (trCur.state === TranscribeState.ACTIVE
          || trCur.state === TranscribeState.PAUSED)
      ) {
        sendToTab(trCur.tabId, {
          type: MessageType.MIC_MUTE_STATE,
          muted: !!message.muted,
        }).catch(() => {});
      }
      return { ok: true };
    }

    case MessageType.SPEAKER_CHANGE: {
      const cur = await getState();
      // Forward to the optional desktop bridge first — best-effort,
      // fire-and-forget. Independent of the extension's own recording
      // state: even when the extension isn't recording (desktop app
      // is), bridge forwarding is the whole reason the user enabled
      // pairing. ``message.source`` is set by the content script
      // (``google_meet`` / ``ms_teams``); the bridge multiplexes
      // multiple sources over one connection.
      bridge.send({
        wall_clock_ms: message.wall_clock_ms ?? Date.now(),
        speaker_name: message.speaker_name,
        source: message.source,
        start_time: message.start_time,
        end_time: message.end_time,
      });
      // Forward to the live-transcribe overlay in the same tab when
      // transcription is running. The overlay uses the SPEAKER_CHANGE
      // events to map provider numeric speakers (Speaker 0/1/2…) to
      // real participant names from the meeting tiles. Same tab id
      // we anchored the transcription session on at start time.
      const t = await getTranscribeState();
      const transcribeLive =
        t.state === TranscribeState.ACTIVE
        || t.state === TranscribeState.PAUSED;
      if (t.tabId && transcribeLive) {
        // sendToTab is forgiving — fire-and-forget; overlay may not
        // be ready (tab still loading) or may have been replaced by
        // a navigation, neither of which we should hard-fail on.
        sendToTab(t.tabId, {
          type: MessageType.SPEAKER_CHANGE,
          speaker_name: message.speaker_name,
          source: message.source,
          wall_clock_ms: message.wall_clock_ms ?? Date.now(),
        }).catch(() => {});
      }
      // Bug 11.1 — also forward the observation to the offscreen
      // doc so it can push a ``speaker_observation`` control frame
      // over the live transcribe WS(s). The relay uses these to
      // drive ``name_by_label`` correlation for important-points
      // attribution when the user is transcribing WITHOUT a paired
      // recording (Mode 2 transcribe-only: no recording timeline
      // for the relay to read). Forward unconditionally while
      // transcribe is live — the offscreen no-ops when no session
      // is active OR when the WS isn't OPEN, so the message is
      // safe to send during STARTING / RECONNECTING too.
      if (transcribeLive && typeof message.speaker_name === 'string') {
        sendMessage({
          type: MessageType.OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION,
          name: message.speaker_name,
          wallClockMs: message.wall_clock_ms ?? Date.now(),
          source: message.source,
        }).catch(() => {});
      }
      // Below this point is the existing extension-recording path —
      // it requires an active meeting, which we don't have when the
      // event fired purely for the bridge.
      if (!cur.meetingId) return { ok: true, data: { bridged_only: true } };
      await bufferEvent(cur.meetingId, {
        speaker_name: message.speaker_name,
        start_time: message.start_time,
        end_time: message.end_time,
      });
      await setState({ currentSpeaker: message.speaker_name });
      return { ok: true };
    }

    case MessageType.BRIDGE_CONFIG_CHANGED: {
      // Options page wrote new BRIDGE_ENABLED / BRIDGE_TOKEN values
      // and pinged us to reconnect. Re-read storage rather than
      // trusting the message payload so the SW state always reflects
      // what's persisted.
      await loadAndApplyBridgeConfig();
      return { ok: true, data: bridge.getStatus() };
    }

    case MessageType.GET_BRIDGE_STATUS: {
      return { ok: true, data: bridge.getStatus() };
    }

    case MessageType.GET_TRANSCRIBE_STATE: {
      return await getTranscribeState();
    }

    case MessageType.START_TRANSCRIBE: {
      // Popup is the only caller today; it passes the target tab
      // (resolved from chrome.tabs.query at the popup) so the SW
      // can route transcript events back to the right content
      // script overlay AND resolve a tabCapture streamId for
      // participants mode.
      //
      // CRITICAL: do NOT hold the message channel open across the
      // full start sequence. For self/both mode startTranscribe()
      // calls ensureMicPermission(), which opens a permission window
      // — that closes the toolbar popup (the message sender), so the
      // awaited response can never be delivered and Chrome surfaces a
      // bogus "A listener indicated an asynchronous response… message
      // channel closed", which the popup showed as "Start failed".
      //
      // Fast mutual-exclusion guards run inline (cheap, no window, no
      // network) so the popup still gets the specific busy messages on
      // the synchronous response. Then we set STARTING and run the
      // heavy tail (network mint, tabCapture, mic-permission window,
      // offscreen) WITHOUT awaiting — the popup learns ACTIVE/ERROR
      // via the TRANSCRIBE_STATE_UPDATE broadcast it already handles.
      // Phase E — no cross-feature rejection: transcription can start
      // while a recording is running. Only block a second concurrent
      // transcription (same-feature singleton constraint).
      const trCur = await getTranscribeState();
      // A genuinely IN-FLIGHT start (STARTING) must NOT be killed — a
      // duplicate START (popup + keyboard shortcut) would otherwise
      // abort the legitimate start that already owns the mutex.
      if (trCur.state === TranscribeState.STARTING) {
        return { code: 'busy_transcribing', activeTabId: trCur.tabId };
      }
      // A previous session that is still ACTIVE / PAUSED /
      // RECONNECTING (typically: the user closed the transcript
      // window without an explicit Stop, or is switching modes) must
      // NOT block the new one. SUPERSEDE it immediately:
      //   • release the old backend row(s) in the BACKGROUND (the
      //     backend has no REST cancel; this frees the 3-session cap
      //     without making the user wait ~minutes),
      //   • reset SW transcribe state to IDLE so startTranscribe's own
      //     guard doesn't self-reject,
      //   • the offscreen's startTranscribe self-tears-down the old
      //     substreams (closes their WS with 1000) when the new
      //     OFFSCREEN_TRANSCRIBE_START arrives.
      // Net: clicking Start starts the next session right away.
      if (
        trCur.state === TranscribeState.ACTIVE ||
        trCur.state === TranscribeState.PAUSED ||
        trCur.state === TranscribeState.RECONNECTING
      ) {
        if (trCur.wsUrl) void releaseTranscribeSession(trCur.wsUrl);
        if (trCur.wsUrlTab) void releaseTranscribeSession(trCur.wsUrlTab);
        if (trCur.tabId) {
          sendToTab(trCur.tabId, {
            type: MessageType.TRANSCRIBE_LIFECYCLE,
            phase: 'stopped',
            reason: 'superseded_by_new_session',
          }).catch(() => {});
        }
        await setTranscribeState({
          ...INITIAL_TRANSCRIBE_STATE,
          state: TranscribeState.IDLE,
          tabId: trCur.tabId ?? null,
        });
      }
      // Do NOT pre-set STARTING here: startTranscribe()'s OWN first
      // action is the same mutual-exclusion check, so an optimistic
      // STARTING would make it instantly self-report busy_transcribing
      // and never start. It sets STARTING itself (and broadcasts it)
      // a few lines in. We just fire it WITHOUT awaiting so the
      // mic-permission window it may open can't close this popup
      // before we answer. Real STARTING→ACTIVE/ERROR reaches the
      // popup via the TRANSCRIBE_STATE_UPDATE broadcast it handles.
      startTranscribe({
        mode: message.mode,
        language: message.language,
        tabId: message.tabId,
        url: message.url,
      }).then(async (result) => {
        // startTranscribe sets ERROR itself for its known failure
        // codes; backstop only an unexpected non-start still parked
        // at STARTING so it can never wedge the transcribe mutex.
        // EXCLUDE the mutex-rejection codes: a duplicate
        // START_TRANSCRIBE (double keyboard-shortcut, popup+shortcut)
        // returns busy_* because ANOTHER start already owns STARTING
        // — ERROR-parking here would kill that legitimate in-flight
        // start, not clean up a failure of THIS one.
        if (
          result && result.code && result.code !== 'started'
          && result.code !== 'busy_transcribing'
          && result.code !== 'busy_recording'
        ) {
          const s = await getTranscribeState();
          if (s.state === TranscribeState.STARTING) {
            await setTranscribeState({
              state: TranscribeState.ERROR,
              error: result.detail || result.code,
            });
          }
        }
      }).catch(async (err) => {
        await setTranscribeState({
          state: TranscribeState.ERROR,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // Code-less response → popup shows nothing scary and the
      // channel closes cleanly even if the mic window is about to
      // replace this popup; the broadcast drives the rest.
      return await getTranscribeState();
    }

    case MessageType.STOP_TRANSCRIBE: {
      await stopTranscribe();
      return await getTranscribeState();
    }

    case MessageType.PAUSE_TRANSCRIBE: {
      return await pauseTranscribe();
    }

    case MessageType.RESUME_TRANSCRIBE: {
      return await resumeTranscribe();
    }

    case MessageType.TRANSCRIPT_EVENT: {
      // Offscreen → SW: a provider event arrived. Forward to the
      // meeting-tab content script which renders it in the floating
      // overlay. ``streamRole`` ride-along lets the overlay tell
      // mic-origin finals (label "You") from tab-origin finals
      // (resolved via the participant name map) in Mode 3.
      // Null for single-mode sessions and old offscreen builds —
      // the overlay falls back to its existing speaker resolution.
      const t = await getTranscribeState();
      if (t.tabId) {
        await sendToTab(t.tabId, {
          type: MessageType.TRANSCRIPT_EVENT,
          event: message.event,
          streamRole: message.streamRole ?? null,
        });
      }
      return { ok: true };
    }

    case MessageType.TRANSCRIBE_FIRST_EVENT: {
      // Phase L1 — offscreen saw the first inbound provider event
      // since the last WS ``open``. Flip the popup-facing
      // ``hasFirstEvent`` flag so the pill drops "Listening…" and
      // shows "Active." Idempotent — re-fires from a misbehaving
      // offscreen (shouldn't happen, but cheap to defend) are no-ops.
      const t = await getTranscribeState();
      if (!t.hasFirstEvent) {
        await setTranscribeState({ hasFirstEvent: true });
      }
      return { ok: true };
    }

    case MessageType.IMPORTANT_POINTS_UPDATE: {
      // Phase L4 — offscreen received a batch of newly-extracted
      // important points from the relay. Merge into transcribe
      // state's cumulative ``importantPoints`` list, deduping by id.
      // The relay tracks ``_sent_point_ids`` server-side so each
      // message carries only new IDs; the dedup here is a belt-and-
      // braces guard for the reconnect path (a fresh relay instance
      // may re-emit the same IDs once before catching up).
      const incoming = Array.isArray(message.points) ? message.points : [];
      if (incoming.length === 0) return { ok: true };
      const t = await getTranscribeState();
      const existing = t.importantPoints || [];
      const seen = new Set(existing.map((p) => p.id));
      const merged = [...existing];
      for (const p of incoming) {
        if (!p || typeof p.id !== 'string' || seen.has(p.id)) continue;
        // Drop malformed entries defensively; the LLM is constrained
        // by responseSchema but a future change could relax that.
        if (typeof p.type !== 'string' || typeof p.text !== 'string') continue;
        seen.add(p.id);
        merged.push(p);
      }
      // Defence-in-depth cap. Backend memo says ~50 points / meeting
      // typical; this cap (500) is 10× headroom. A runaway extractor
      // (hash collisions, schema-relaxed responses) would otherwise
      // grow chrome.storage.session unboundedly. FIFO — drop oldest.
      if (merged.length > IMPORTANT_POINTS_MAX) {
        merged.splice(0, merged.length - IMPORTANT_POINTS_MAX);
      }
      if (merged.length !== existing.length) {
        await setTranscribeState({ importantPoints: merged });
        // Also push to the meeting-tab overlay so the in-call panel's
        // "Important points" section stays in sync with the popup.
        // Same forgiving fire-and-forget path as TRANSCRIPT_EVENT —
        // the overlay may not be mounted yet (pre-first-event) and
        // that's fine; it renders from state on its next message.
        if (t.tabId) {
          await sendToTab(t.tabId, {
            type: MessageType.IMPORTANT_POINTS_UPDATE,
            points: merged,
          });
        }
      }
      return { ok: true };
    }

    case MessageType.OFFSCREEN_TRANSCRIBE_GET_RECONNECT_URL: {
      // Offscreen lost the WS and is asking for a fresh session so
      // it can re-attach. ``role`` ride-along distinguishes the mic
      // vs tab substream in mode=both; single-mode sessions pass
      // null / undefined and use the existing primary slot.
      const res = await refreshTranscribeReconnectUrl(message.role);
      return res;
    }

    case MessageType.TRANSCRIBE_DURATION_CAP_EXCEEDED: {
      // P5 — relay told us the live-transcribe session hit its
      // cumulative cap. Persist the cap details on transcribe state
      // (popup renders a "limit reached" banner) + suppress the
      // reconnect loop by tearing the session down with a dedicated
      // reason. The offscreen closed the WS itself; stopTranscribe
      // does the cleanup + STATE_UPDATE in any case.
      const cap = Number(message.capSeconds) || 0;
      const consumed = Number(message.consumedSeconds) || 0;
      await setTranscribeState({
        capExceeded: true,
        durationCapSeconds: cap,
        durationCapConsumedSeconds: consumed,
      });
      emitEvent('transcribe_cap_exceeded', {
        capSeconds: cap,
        consumedSeconds: consumed,
      });
      await stopTranscribe({ reason: 'duration_cap_exceeded' });
      return;
    }

    case MessageType.TRANSCRIBE_RECONNECT_PROGRESS: {
      // Offscreen pings us each backoff step so the popup can show
      // "Reconnecting (2 of 4)…". 'reconnected' is a hint that the
      // open() succeeded — the authoritative state flip lives in
      // TRANSCRIBE_LIFECYCLE phase=started below.
      const cur = await getTranscribeState();
      if (message.phase === 'reconnecting') {
        await setTranscribeState({
          state: TranscribeState.RECONNECTING,
          reconnectAttempt: message.attempt ?? 0,
          reconnectMaxAttempts: message.maxAttempts ?? 0,
        });
        // Only emit on the first attempt of a reconnect chain so the
        // event count = reconnect-chain count, not attempt count.
        if ((message.attempt ?? 0) === 1) {
          emitEvent(TELEMETRY_EVENT_NAMES.WS_RECONNECT_ATTEMPTED, {
            sessionId: cur.sessionId ?? null,
            initialCode: message.initialCode ?? null,
            initialReason: message.initialReason ?? null,
            maxAttempts: message.maxAttempts ?? 0,
          });
        }
        if (cur.tabId) {
          // Tell the overlay so it can flip its indicator dot. Use
          // the existing TRANSCRIBE_LIFECYCLE channel with a new
          // ``phase`` value so we don't have to plumb a separate
          // message type to the content script.
          await sendToTab(cur.tabId, {
            type: MessageType.TRANSCRIBE_LIFECYCLE,
            phase: 'reconnecting',
            attempt: message.attempt ?? 0,
            maxAttempts: message.maxAttempts ?? 0,
          }).catch(() => {});
        }
      } else if (message.phase === 'reconnected') {
        emitEvent(TELEMETRY_EVENT_NAMES.WS_RECONNECT_SUCCEEDED, {
          sessionId: cur.sessionId ?? null,
          attempt: message.attempt ?? 0,
        });
      } else if (message.phase === 'failed') {
        emitEvent(TELEMETRY_EVENT_NAMES.WS_RECONNECT_EXHAUSTED, {
          sessionId: cur.sessionId ?? null,
          attempt: message.attempt ?? 0,
          maxAttempts: message.maxAttempts ?? 0,
        });
        await setTranscribeState({
          state: TranscribeState.ERROR,
          error: `reconnect_failed_after_${message.attempt ?? '?'}_attempts`,
          reconnectAttempt: 0,
          reconnectMaxAttempts: 0,
        });
        if (cur.tabId) {
          await sendToTab(cur.tabId, {
            type: MessageType.TRANSCRIBE_LIFECYCLE,
            phase: 'stopped',
            reason: 'reconnect_failed',
          }).catch(() => {});
        }
      }
      // 'reconnected' is informational — the WS open will fire
      // TRANSCRIBE_LIFECYCLE 'started' on success which is what
      // actually flips us back to ACTIVE.
      return { ok: true };
    }

    case MessageType.TRANSCRIBE_LIFECYCLE: {
      // Offscreen → SW lifecycle transitions. Apply to state +
      // tell the meeting tab to show/hide its overlay.
      const cur = await getTranscribeState();
      if (message.phase === 'started') {
        await setTranscribeState({
          state: TranscribeState.ACTIVE,
          startedAt: message.startedAt ?? Date.now(),
          error: null,
          reconnectAttempt: 0,
          reconnectMaxAttempts: 0,
          // Phase L1 — fresh open (including reconnect) starts in
          // "Listening…" state. Flipped back to true by the offscreen
          // doc on the first inbound provider event.
          hasFirstEvent: false,
        });
        if (cur.tabId) {
          // Test-only: re-send the open-shadow flag here too. The
          // overlay latches it on the FIRST 'started' it receives,
          // and the mountTranscribeOverlay 'started' can lose the
          // content-script injection race — this WS-open 'started'
          // is the reliable one. Never set in production.
          let e2eOpenShadow = false;
          try {
            const g = await chrome.storage.local.get('mm_e2e_open_shadow');
            e2eOpenShadow = g.mm_e2e_open_shadow === true;
          } catch { /* no storage — default closed */ }
          // ``mode`` ride-along: the overlay uses it to decide
          // whether to apply Mode 1 self-naming (single speaker =
          // current user) or Mode 2 DOM-tile mapping (numeric →
          // participant name from SPEAKER_CHANGE events).
          // ``isReconnect`` tells the overlay to skip its destructive
          // state reset — re-attach should preserve the speaker map's
          // DOM-observation timeline and the cached self name.
          await sendToTab(cur.tabId, {
            type: MessageType.TRANSCRIBE_LIFECYCLE,
            phase: 'started',
            mode: cur.mode,
            isReconnect: !!message.isReconnect,
            e2eOpenShadow,
          });
        }
      } else if (message.phase === 'stopped' || message.phase === 'error') {
        // Either path lands the state in IDLE so the popup re-enables
        // the Start button. Distinguish error via the ``error`` field
        // so the popup can show the reason.
        const nextState = message.phase === 'error'
          ? TranscribeState.ERROR
          : TranscribeState.IDLE;
        // Only an ``error`` phase carries a user-facing fault. A clean
        // ``stopped`` (user clicked Stop → reason ``client_stop``, tab
        // closed, etc.) must NOT populate ``error`` — otherwise the
        // popup renders the internal reason ("client_stop") as a
        // failure toast even though nothing went wrong.
        await setTranscribeState({
          state: nextState,
          error: message.phase === 'error' ? (message.reason ?? null) : null,
        });
        if (cur.tabId) {
          await sendToTab(cur.tabId, {
            type: MessageType.TRANSCRIBE_LIFECYCLE,
            phase: 'stopped',
            reason: message.reason ?? null,
          });
        }
        // Free the shared offscreen doc only if recording isn't using
        // it (Phase E: the refcount lives in destroyOffscreenIfIdle,
        // which also covers recording STARTING/STOPPING — the old
        // inline check missed those windows).
        await destroyOffscreenIfIdle();
        const recState = await getState();
        // Phase B — drop the SW watchdog alarm only when neither
        // feature is busy any more. The alarm handler itself does the
        // same check, but clearing eagerly avoids one wasted firing.
        if (recState.state !== RecordingState.RECORDING) {
          await clearWatchdogAlarm();
        }
      }
      return { ok: true };
    }

    case MessageType.TAB_BLUR_MARKER: {
      const cur = await getState();
      if (!cur.meetingId) return { ok: false, error: 'no_active_meeting' };
      await bufferEvent(cur.meetingId, {
        speaker_name: '__tab_blurred__',
        start_time: message.at,
        end_time: message.at,
      });
      return { ok: true };
    }

    case MessageType.MEETING_ENDED: {
      const cur = await getState();
      // Stop on RECORDING *and* STARTING — if the meeting ends while the
      // offscreen is still booting (STARTING), ignoring this left the
      // recording running into an empty room until tab-close / manual
      // stop. stopRecording is a no-op outside RECORDING/STARTING, so
      // this is safe to call regardless.
      if (cur.state === RecordingState.RECORDING
        || cur.state === RecordingState.STARTING) {
        await stopRecording({ reason: 'meeting_ended' });
      }
      return { ok: true };
    }

    case MessageType.AUDIO_LEVELS: {
      // Forward to an open popup. We don't store levels in session state
      // — that would churn writes 4× per second. The popup paints
      // directly from the LEVEL_UPDATE message.
      sendMessage({
        type: MessageType.LEVEL_UPDATE,
        tab: message.tab,
        mic: message.mic,
      }).catch(() => {});
      return { ok: true };
    }

    case MessageType.TELEMETRY_EVENT: {
      // Content scripts can't directly emit (they don't carry the auth
      // token); they relay through us. We pass through opaque payloads
      // — the allowed-name list is documented in client.js.
      if (typeof message.name === 'string') {
        emitEvent(message.name, message.payload ?? {});
        // Phase U2 — intercept a small set of telemetry events to
        // mirror into UI state so the popup can render them. The
        // emitEvent call above ships the event to the backend
        // regardless; this just adds a per-state side-effect for
        // the events the user wants to see.
        const payload = message.payload ?? {};
        if (message.name === TELEMETRY_EVENT_NAMES.VAD_STATS
          && typeof payload.droppedPct === 'number') {
          // Transcribe-side stat — update transcribe state.
          await setTranscribeState({ vadDroppedPct: payload.droppedPct });
        } else if (message.name === TELEMETRY_EVENT_NAMES.HEAP_HIGH_WATER_MARK
          && typeof payload.heapBytes === 'number') {
          // Heap watchdog reports in bytes; we round to nearest MB
          // for popup display. ``context`` ("recording" |
          // "transcribe") tells us which state to mirror into.
          const mb = Math.round(payload.heapBytes / (1024 * 1024));
          if (payload.context === 'transcribe') {
            await setTranscribeState({ heapMb: mb });
          } else {
            // Default to recording — that's where the watchdog runs
            // by default in offscreen.js.
            const cur = await getState();
            if (cur.state === RecordingState.RECORDING) {
              await setState({ heapMb: mb });
            }
          }
        }
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown_message_type:${message.type}` };
  }
});

// ---------------------------------------------------------------------------
// SW-restart diagnostics. Runs at module top-level, which re-executes
// every time the service worker boots (chrome start, or SW wake from
// suspend mid-session). We compare the persisted state with reality:
// if storage claims we were ACTIVE / RECORDING but the offscreen doc
// is gone, the underlying MediaStream is unrecoverable — that's an
// unexpected restart that lost user-visible state, worth telemetry.
//
// Fire-and-forget: never await this at top level, never throw.
void (async function _diagnoseSwBoot() {
  try {
    // Read recording + transcribe state. session-storage is wiped on
    // chrome close, so values here imply SW-only restart (chrome
    // stayed up) — exactly the case we want to detect.
    const got = await chrome.storage.session.get([
      StorageKey.SESSION_STATE,
      StorageKey.TRANSCRIBE_STATE,
    ]);
    const rec = got[StorageKey.SESSION_STATE];
    const tr = got[StorageKey.TRANSCRIBE_STATE];
    const wasActive =
      (rec && (rec.state === RecordingState.RECORDING || rec.state === RecordingState.STARTING))
      || (tr && (tr.state === 'ACTIVE' || tr.state === 'STARTING' || tr.state === 'RECONNECTING'));
    if (!wasActive) {
      // Boot from idle is the common case — no-op.
      return;
    }
    // chrome.offscreen.hasDocument is the only sync-ish way to ask
    // "is the offscreen doc still attached"; without it we have a
    // recording session that's unrecoverable.
    let offscreenAlive = false;
    try {
      offscreenAlive = await chrome.offscreen.hasDocument();
    } catch {
      offscreenAlive = false;
    }
    if (!offscreenAlive) {
      emitEvent(TELEMETRY_EVENT_NAMES.SW_RESTART_UNEXPECTED, {
        recState: rec?.state ?? null,
        transcribeState: tr?.state ?? null,
        meetingId: rec?.meetingId ?? null,
        // SW age is unknown from this side; just timestamp the boot.
        bootAt: Date.now(),
      });
      emitEvent(TELEMETRY_EVENT_NAMES.OFFSCREEN_DOC_ORPHANED, {
        recState: rec?.state ?? null,
        transcribeState: tr?.state ?? null,
      });
    } else {
      // SW restarted but offscreen survived → state can be reused.
      emitEvent(TELEMETRY_EVENT_NAMES.SW_STATE_REHYDRATED, {
        recState: rec?.state ?? null,
        transcribeState: tr?.state ?? null,
      });
    }
  } catch {
    /* diagnostics must never break SW boot */
  }
})();


// ---------------------------------------------------------------------------
// Reset on install / startup — we never resume a recording across SW
// restarts because the underlying MediaStream cannot be revived.

// On install/update/SW-restart, MV3 leaves already-open Meet/Teams
// tabs WITHOUT the (new) content scripts. Re-inject the overlay into
// every such tab so a live meeting started before the reload still
// shows the panel — without forcing the user to reload the tab. This
// is the durable companion to the on-demand inject in
// ``mountTranscribeOverlay``.
async function reinjectOverlayIntoOpenMeetingTabs() {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://meet.google.com/*', 'https://teams.microsoft.com/*', 'https://teams.live.com/*'],
    });
    await Promise.all(tabs.map((t) => (t.id
      ? ensureOverlayInjected(t.id)
      : Promise.resolve())));
  } catch (err) {
    console.warn('[sw] reinject overlay sweep failed', String(err));
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.set({
    [StorageKey.SESSION_STATE]: INITIAL_STATE,
    // Transcribe pipeline (offscreen WS + mic stream) cannot survive
    // an SW restart any more than a recording can — a persisted
    // non-IDLE transcribe state is always stale and would otherwise
    // wedge the mutex ("Transcription in progress" forever). Reset it.
    [StorageKey.TRANSCRIBE_STATE]: INITIAL_TRANSCRIBE_STATE,
  });
  await clearWatchdogAlarm();
  paintBadge(INITIAL_STATE);
  // Phase D #4 — install the long-period periodic-sync alarm so
  // orphan chunks get retried even if the user never reopens the
  // popup. ``ensurePeriodicSyncAlarm`` is a no-op when the alarm
  // already exists, so this is safe on every reinstall.
  await ensurePeriodicSyncAlarm();
  void recoverOrphans();
  void reinjectOverlayIntoOpenMeetingTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.session.set({
    [StorageKey.SESSION_STATE]: INITIAL_STATE,
    [StorageKey.TRANSCRIBE_STATE]: INITIAL_TRANSCRIBE_STATE,
  });
  await clearWatchdogAlarm();
  paintBadge(INITIAL_STATE);
  await ensurePeriodicSyncAlarm();
  void recoverOrphans();
  void reinjectOverlayIntoOpenMeetingTabs();
});

// Keyboard shortcut — toggles between start and stop on the active tab.
// activeTab is granted via the command dispatch, satisfying tabCapture's
// "extension has been invoked for the current page" requirement.
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-recording') {
    const cur = await getState();
    if (cur.state === RecordingState.RECORDING) {
      await stopRecording();
      return;
    }
    if (cur.state !== RecordingState.IDLE && cur.state !== RecordingState.ERROR) {
      return; // STARTING / STOPPING / NEEDS_REAUTH — ignore.
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url) return;
    const source = tab.url.startsWith('https://meet.google.com/')
      ? Source.GOOGLE_MEET
      : (tab.url.startsWith('https://teams.microsoft.com/')
        || tab.url.startsWith('https://teams.live.com/'))
        ? Source.MS_TEAMS
        : null;
    if (!source) return; // Not a meeting tab — silently ignore.
    await startRecording({ tabId: tab.id, url: tab.url, source });
    return;
  }
  if (command === 'toggle-transcribe') {
    // Phase U6 — parity with toggle-recording so power users can
    // start a live transcribe without opening the popup. Same
    // ignore rules: non-meeting tabs are silently skipped (no
    // disruptive error feedback because the user could be on any
    // tab when they hit the shortcut).
    const tr = await getTranscribeState();
    if (tr.state === TranscribeState.ACTIVE || tr.state === TranscribeState.PAUSED
        || tr.state === TranscribeState.RECONNECTING) {
      await stopTranscribe();
      return;
    }
    if (tr.state !== TranscribeState.IDLE && tr.state !== TranscribeState.ERROR) {
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url) return;
    if (!tab.url.startsWith('https://meet.google.com/')
        && !tab.url.startsWith('https://teams.microsoft.com/')
        && !tab.url.startsWith('https://teams.live.com/')) {
      return;
    }
    // Fall back to last-used mode/language so the shortcut path
    // doesn't open a chooser. New users hit IDLE and pick once via
    // the popup; the shortcut respects that.
    const last = await chrome.storage.local.get([
      StorageKey.TRANSCRIBE_LAST_MODE,
      StorageKey.TRANSCRIBE_LAST_LANGUAGE,
    ]);
    const mode = last[StorageKey.TRANSCRIBE_LAST_MODE] || 'self';
    // 'en' not 'auto' — Deepgram/AssemblyAI deploys 422 on auto, which
    // would make the keyboard shortcut silently fail. Matches the popup.
    const language = last[StorageKey.TRANSCRIBE_LAST_LANGUAGE] || 'en';
    await startTranscribe({
      mode, language, tabId: tab.id, url: tab.url,
    });
  }
});

// Recover from NEEDS_REAUTH when a new AUTH_TOKEN is written to
// storage — this is the signal that the user has signed in again
// (from the popup auth view, or in the future from any other path).
// Without this, the popup would let the user sign in but the SW
// state would stay stuck at NEEDS_REAUTH with the primary button
// disabled. We only react to the NEEDS_REAUTH → IDLE transition;
// active recordings (RECORDING / STARTING / STOPPING) are left
// alone, and a token write while IDLE is a no-op.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  const change = changes[StorageKey.AUTH_TOKEN];
  if (!change || !change.newValue) return; // removed or unchanged → ignore here
  const cur = await getState();
  if (cur.state === RecordingState.NEEDS_REAUTH) {
    await setState({
      state: RecordingState.IDLE,
      errorMessage: null,
    });
  }
});

// Telemetry flusher runs on every SW wake — kicks immediately to drain
// any backlog accumulated while the endpoint was missing or the SW was
// suspended, then ticks every TELEMETRY_FLUSH_MS while the SW is awake.
startTelemetryFlusher(async (err) => {
  if (err instanceof AuthError) {
    const cur = await getState();
    // Only flip to NEEDS_REAUTH if we're currently active — telemetry
    // alone shouldn't disturb an idle install.
    if (cur.state === RecordingState.RECORDING || cur.state === RecordingState.STARTING) {
      await setState({ state: RecordingState.NEEDS_REAUTH });
    }
  }
});
