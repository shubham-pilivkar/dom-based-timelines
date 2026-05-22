// Popup — pure presentation. Reads state on open, listens for
// STATE_UPDATE broadcasts, sends START_RECORDING / STOP_RECORDING.
// All real work lives in the SW + offscreen.
//
// Auth gate: if chrome.storage has no AUTH_TOKEN we render the
// signed-out view (signin-only — signup happens on the web app at
// https://app.meetminutes.in/signup, reached via the "Sign up" link).
// On successful auth the API client writes the token + email to
// storage; we listen for that change and swap to the recording view.

import {
  MessageType,
  RecordingState,
  Source,
  StorageKey,
  TELEMETRY_EVENT_NAMES,
  TranscribeMode,
  TranscribeState,
} from '../constants.js';
import { renderError } from '../lib/error-messages.js';
import { onMessage, sendMessage } from '../lib/messaging.js';
import {
  dispatchBot as apiDispatchBot,
  login as apiLogin,
  logout as apiLogout,
} from '../api/client.js';
import {
  loadDisplayName,
  resolveDisplayName,
  resolveImportantPointSpeaker,
} from '../lib/user-name.js';
import {
  FEATURE_LABEL,
  FeatureKey,
  loadGate,
  openPricingPage,
  openSupportPage,
} from '../lib/feature-gate.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const els = {
  pill: $('state-pill'),
  meetingSource: $('meeting-source'),
  elapsed: $('elapsed'),
  speaker: $('current-speaker'),
  mic: $('mic-status'),
  queue: $('queue-depth'),
  errorRow: $('error-row'),
  errorMessage: $('error-message'),
  reauthRow: $('reauth-row'),
  monitorBlockedRow: $('monitor-blocked-row'),
  restoreMonitor: $('restore-monitor'),
  queueWarnRow: $('queue-warn-row'),
  queueWarnText: $('queue-warn-text'),
  capRemainingRow: $('cap-remaining-row'),
  capRemainingValue: $('cap-remaining-value'),
  capWarningRow: $('cap-warning-row'),
  capWarningText: $('cap-warning-text'),
  capExceededRow: $('cap-exceeded-row'),
  capExceededText: $('cap-exceeded-text'),
  captionConsentRow: $('caption-consent-row'),
  captionShowBtn: /** @type {HTMLButtonElement} */ ($('caption-show-btn')),
  captionHideBtn: /** @type {HTMLButtonElement} */ ($('caption-hide-btn')),
  busyRow: $('busy-row'),
  switchTab: $('switch-tab'),
  encryptIndicator: $('encrypt-indicator'),
  heapRow: $('heap-row'),
  heapValue: $('heap-value'),
  recapToast: $('recap-toast'),
  recapMessage: $('recap-message'),
  transcribeVadRow: $('transcribe-vad-row'),
  transcribeVadValue: $('transcribe-vad-value'),
  primary: /** @type {HTMLButtonElement} */ ($('primary-btn')),
  pause: /** @type {HTMLButtonElement} */ ($('pause-btn')),
  reauthLink: $('reauth-link'),
  openOptionsLink: $('open-options-link'),
  reportProblemLink: $('report-problem-link'),
  levelsWrap: $('levels-wrap'),
  levelMicFill: $('level-mic-fill'),
  levelTabFill: $('level-tab-fill'),
  controlActiveRow: $('control-active-row'),
  controlActiveLabel: $('control-active-label'),
  openControls: /** @type {HTMLButtonElement} */ ($('open-controls')),
  // Live-transcription panel
  transcribeStatusPill: $('transcribe-status'),
  transcribeMode: /** @type {HTMLSelectElement} */ ($('transcribe-mode')),
  transcribeLanguage: /** @type {HTMLSelectElement} */ ($('transcribe-language')),
  transcribeBtn: /** @type {HTMLButtonElement} */ ($('transcribe-btn')),
  transcribePauseBtn: /** @type {HTMLButtonElement} */ ($('transcribe-pause-btn')),
  transcribeErrorRow: $('transcribe-error-row'),
  transcribeErrorMessage: $('transcribe-error-message'),
  importantPointsSection: $('important-points-section'),
  importantPointsCount: $('important-points-count'),
  importantPointsList: $('important-points-list'),
  // Auth view + signed-in row
  authView: $('auth-view'),
  mainView: $('main-view'),
  // Signup tab + password-hint were removed when signup moved to the
  // web app (app.meetminutes.in/signup). ``authSignupRedirect`` is the
  // link that opens the web signup page in a new tab.
  authEmail: /** @type {HTMLInputElement} */ ($('auth-email')),
  authPassword: /** @type {HTMLInputElement} */ ($('auth-password')),
  authError: $('auth-error'),
  authSubmit: /** @type {HTMLButtonElement} */ ($('auth-submit')),
  authGoogle: /** @type {HTMLButtonElement} */ ($('auth-google')),
  authMicrosoft: /** @type {HTMLButtonElement} */ ($('auth-microsoft')),
  authSignupRedirect: /** @type {HTMLButtonElement} */ ($('auth-signup-redirect')),
  authUserRow: $('auth-user-row'),
  userEmail: $('user-email'),
  signoutBtn: /** @type {HTMLButtonElement} */ ($('signout-btn')),
  // View tabs + Bot tab inputs.
  tabRecord: /** @type {HTMLButtonElement} */ ($('tab-record')),
  tabBot: /** @type {HTMLButtonElement} */ ($('tab-bot')),
  tabTranscribe: /** @type {HTMLButtonElement} */ ($('tab-transcribe')),
  recordView: $('record-view'),
  botView: $('bot-view'),
  transcribeView: $('transcribe-view'),
  meetingName: /** @type {HTMLInputElement} */ ($('meeting-name')),
  botName: /** @type {HTMLInputElement} */ ($('bot-name')),
  botUrl: /** @type {HTMLInputElement} */ ($('bot-url')),
  botSubmit: /** @type {HTMLButtonElement} */ ($('bot-submit')),
  botError: $('bot-error'),
  botSuccess: $('bot-success'),
  // Subscription upgrade modal — shown when a gated feature is
  // clicked. Single modal serves every feature; the title swaps to
  // the friendly label from FEATURE_LABEL based on which click was
  // intercepted.
  upgradeModal: $('upgrade-modal'),
  upgradeModalBackdrop: $('upgrade-modal-backdrop'),
  upgradeModalClose: /** @type {HTMLButtonElement} */ ($('upgrade-modal-close')),
  upgradeModalTitle: $('upgrade-modal-title'),
  upgradeModalMessage: $('upgrade-modal-message'),
  upgradeModalCta: /** @type {HTMLButtonElement} */ ($('upgrade-modal-cta')),
  upgradeModalSupport: /** @type {HTMLButtonElement} */ ($('upgrade-modal-support')),
};

// Signin-only — signup moved to https://app.meetminutes.in/signup and
// is reached via the ``authSignupRedirect`` link. The old ``authMode``
// state machine ('signin'/'signup') has been removed because there is
// only one mode now; the submit button always calls /security/login.

let busyInfo = null; // { activeTabId, activeUrl } when SW reports busy

let lastState = null;
let elapsedTimer = null;

// Phase E — render the always-visible dual-session strip from BOTH
// state machines so the user can see recording AND transcription at
// once (they can now run simultaneously). Defensive getElementById
// (the strip is absent in the signed-out view) and tolerant of a
// not-yet-seen state on either side.
function renderSessionsStrip() {
  const strip = document.getElementById('sessions-strip');
  if (!strip) return;
  const set = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  const dot = (id, active) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('live', !!active);
  };

  // --- Recording side ---
  const rs = (lastState && lastState.state) || RecordingState.IDLE;
  const recActive = rs === RecordingState.RECORDING
    || rs === RecordingState.STARTING;
  set('sess-rec-state', rs === RecordingState.IDLE ? 'Idle'
    : rs.charAt(0) + rs.slice(1).toLowerCase());
  set('sess-rec-meta',
    recActive && lastState && lastState.meetingName
      ? lastState.meetingName : '');
  dot('sess-rec-dot', recActive);

  // --- Transcription side ---
  const ts = (lastTranscribeState && lastTranscribeState.state)
    || TranscribeState.IDLE;
  const trActive = ts === TranscribeState.ACTIVE
    || ts === TranscribeState.STARTING
    || ts === TranscribeState.PAUSED
    || ts === TranscribeState.RECONNECTING;
  let trLabel = ts === TranscribeState.IDLE ? 'Idle'
    : ts.charAt(0) + ts.slice(1).toLowerCase();
  // "Active" but pre-first-event reads as "Listening…" — same signal
  // the transcribe view + overlay use.
  if (ts === TranscribeState.ACTIVE
      && lastTranscribeState && lastTranscribeState.hasFirstEvent === false) {
    trLabel = 'Listening…';
  }
  set('sess-tr-state', trLabel);
  set('sess-tr-meta',
    trActive && lastTranscribeState && lastTranscribeState.mode
      ? String(lastTranscribeState.mode) : '');
  // The pulsing dot IS the audio-activity indicator for transcription
  // (no separate PCM meter pipeline — the Listening/Active pulse is
  // the same liveness signal the overlay shows).
  dot('sess-tr-dot', trActive);
}

// Default meeting name when the user leaves the field blank, e.g.
// "Meeting at 17 May 11:30 IST". Rendered in IST regardless of the
// user's local zone so saved names are consistent for the team.
function defaultMeetingName() {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return `Meeting at ${p.day} ${p.month} ${p.hour}:${p.minute} IST`;
  } catch {
    return `Meeting at ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function detectSource(url) {
  if (url.startsWith('https://meet.google.com/')) return Source.GOOGLE_MEET;
  if (url.startsWith('https://teams.microsoft.com/')
      || url.startsWith('https://teams.live.com/')) return Source.MS_TEAMS;
  return null;
}

// Meet meeting URL: meet.google.com/<3-4>-<4>-<3-4> (lowercase). Mirrors
// the in-page regex at content/meet.js:isOnMeetingRoomPath. Landing,
// /schedule, /new etc. all fail this and won't trigger a start.
const _MEET_ROOM_RE = /^https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}(?:[/?#]|$)/;
// Teams join links: covers v1 (/_#/l/meetup-join/...) and v2
// (/l/meetup-join/...), the Calling app pre-join, and the consumer
// teams.live.com variant. The Teams root / channel views are rejected.
const _TEAMS_ROOM_RE = /^https:\/\/(?:teams\.microsoft\.com|teams\.live\.com)\/(?:_#\/)?(?:l\/meetup-join\/|meetup-join\/|pre-join-calling\/|calling\/)/;

function isInMeetingRoom(url, source) {
  if (source === Source.GOOGLE_MEET) return _MEET_ROOM_RE.test(url);
  if (source === Source.MS_TEAMS) return _TEAMS_ROOM_RE.test(url);
  return false;
}

// Resolves the active tab into a meeting-start target.
//   null                    — no Meet/Teams tab in focus (caller renders no_meeting_tab)
//   { error: 'not_in_meeting_room' } — Meet/Teams tab is open but on a landing/lobby page
//   { tabId, url, source }  — caller can dispatch START_RECORDING
async function getActiveMeetingTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.id) return null;
  const source = detectSource(tab.url);
  if (!source) return null;
  if (!isInMeetingRoom(tab.url, source)) {
    return { error: 'not_in_meeting_room' };
  }
  return { tabId: tab.id, url: tab.url, source };
}

function render(state) {
  const prevState = lastState && lastState.state;
  lastState = state;
  renderSessionsStrip();

  // Meeting-name field: while a recording is in flight show the
  // session's name (from SW state, so it survives popup re-opens) and
  // lock it (can't rename mid-recording). Back at IDLE, re-enable it;
  // clear it once on the recording→idle transition so the next
  // recording starts from a blank field.
  if (els.meetingName) {
    const active = state.state === RecordingState.STARTING
      || state.state === RecordingState.RECORDING
      || state.state === RecordingState.STOPPING;
    if (active) {
      if (state.meetingName != null) els.meetingName.value = state.meetingName;
      els.meetingName.disabled = true;
    } else {
      els.meetingName.disabled = false;
      if (prevState === RecordingState.RECORDING
          || prevState === RecordingState.STOPPING) {
        els.meetingName.value = '';
      }
    }
  }

  // State pill stays hidden on the sign-in view — a STATE_UPDATE that
  // lands while the user is signed out (SW broadcasts these even when
  // the main view isn't mounted) used to repaint className wholesale
  // and drop the `hidden` class, surfacing a stray "Idle" pill in the
  // auth header. Check the main view's visibility first.
  const mainVisible = !els.mainView.classList.contains('hidden');
  if (mainVisible) {
    els.pill.className = `pill state-${state.state.toLowerCase()}`;
    els.pill.textContent =
      state.state.charAt(0) + state.state.slice(1).toLowerCase().replace('_', ' ');
  } else {
    els.pill.classList.add('hidden');
  }

  els.meetingSource.textContent =
    state.source === Source.GOOGLE_MEET
      ? 'Google Meet'
      : state.source === Source.MS_TEAMS
        ? 'Microsoft Teams'
        : '—';
  // Speaker fallback: until the content script's caption observer
  // emits the first SPEAKER_CHANGE (captions briefly muted, the user
  // hasn't said anything yet, observer still warming up), show the
  // signed-in user's name as a sensible default while recording —
  // matches the typical "I'm the speaker" reality at meeting start.
  // Outside a live recording the dash is still correct.
  //
  // ALSO treat the caption-observer's generic "Speaker" / "Speaker A"
  // / "Speaker B" placeholder labels as falsy here. When the observer
  // sees real caption text but can't resolve a participant badge
  // (badge class rotated, or the caller is on a platform we don't
  // recognise), it emits ``GENERIC_SPEAKER = 'Speaker'`` so the
  // backend correlator still has a timeline row to chew on — but in
  // the popup that placeholder reads as a degraded label, and the
  // signed-in user's real name is a far better fallback.
  const recActive =
    state.state === RecordingState.STARTING
    || state.state === RecordingState.RECORDING;
  const speakerLooksGeneric =
    typeof state.currentSpeaker === 'string'
    && /^Speaker(?: [A-Z]| \d+)?$/.test(state.currentSpeaker.trim());
  els.speaker.textContent =
    (state.currentSpeaker && !speakerLooksGeneric && state.currentSpeaker)
    || (recActive ? (signedInDisplayName() || '—') : '—');
  els.mic.textContent = state.micAvailable
    ? 'on'
    : state.state === RecordingState.RECORDING
      ? 'tab audio only'
      : '—';
  // Show RECORDED chunk count (monotonic — one every ~20 s, so the
  // user actually sees it move) and, only when there's a backlog, the
  // pending-upload count. Previously this showed just the pending
  // depth, which on a healthy network sits at 0 the whole time and
  // looked "stuck / not updating".
  {
    const recorded = (state.lastChunkIndex ?? -1) + 1;
    const pending = state.uploadQueueDepth || 0;
    els.queue.textContent = pending > 0
      ? `${recorded} · ${pending} queued`
      : String(recorded);
  }

  renderError({
    rowEl: els.errorRow,
    msgEl: els.errorMessage,
    code: state.errorMessage,
  });

  els.reauthRow.classList.toggle('hidden', state.state !== RecordingState.NEEDS_REAUTH);
  els.monitorBlockedRow.classList.toggle('hidden', !state.monitorBlocked);

  // P5 — duration-cap banners. Three distinct UX moments:
  //   * exceeded: persistent banner (replaces the time-left badge);
  //     the recording is finalizing.
  //   * warning latched: heads-up banner that auto-stop is imminent.
  //   * neither: hide both rows; the "Time left" badge in the elapsed
  //     row carries the running countdown.
  if (state.capExceeded) {
    els.capExceededRow?.classList.remove('hidden');
    els.capWarningRow?.classList.add('hidden');
    if (els.capExceededText && state.durationCapSeconds) {
      const hours = Math.round(state.durationCapSeconds / 3600);
      els.capExceededText.textContent =
        `Recording reached its ${hours}-hour limit and was stopped `
        + 'automatically. The audio so far is being uploaded and finalized.';
    }
  } else {
    els.capExceededRow?.classList.add('hidden');
    els.capWarningRow?.classList.toggle('hidden', !state.capWarningEmitted);
  }

  // Phase U2 — encryption indicator. Show only while an encrypted
  // session is active; hidden in IDLE / ERROR so the badge isn't a
  // stale artifact of the previous recording.
  const showEncrypt = !!state.isEncrypted
    && (state.state === RecordingState.RECORDING
        || state.state === RecordingState.STARTING);
  els.encryptIndicator.classList.toggle('hidden', !showEncrypt);

  // Phase U2 — heap pressure indicator. Only visible above 100 MB
  // (the lowest watermark). Colour escalates with severity but the
  // exact value is what the user actually reads.
  if (state.heapMb && state.heapMb >= 100) {
    els.heapRow.classList.remove('hidden');
    els.heapValue.textContent = `${state.heapMb} MB`;
    els.heapRow.classList.toggle('warn', state.heapMb >= 200);
    els.heapRow.classList.toggle('error', state.heapMb >= 300);
  } else {
    els.heapRow.classList.add('hidden');
  }

  // Phase U2 — post-stop recap toast. Fires once on the RECORDING →
  // IDLE transition; auto-hides after 4s. Uses ``prevState`` captured
  // at the top of render() so a render-with-IDLE without the
  // transition (e.g. popup just reopened) doesn't spuriously show it.
  if (
    prevState === RecordingState.RECORDING
    && state.state === RecordingState.IDLE
  ) {
    const chunks = (state.lastChunkIndex ?? -1) + 1;
    const message = chunks > 0
      ? `Saved · ${chunks} chunk${chunks === 1 ? '' : 's'} uploaded.`
      : 'Saved.';
    els.recapMessage.textContent = message;
    els.recapToast.classList.remove('hidden');
    setTimeout(() => {
      els.recapToast.classList.add('hidden');
    }, 4000);
  }

  // Live level meters — only meaningful while a recording is active.
  // Hide them during IDLE / ERROR / NEEDS_REAUTH so the popup looks
  // clean. AUDIO_LEVELS messages stop arriving when offscreen tears down,
  // so the bars naturally drop to 0 even if we forgot to hide them.
  const showLevels =
    state.state === RecordingState.RECORDING ||
    state.state === RecordingState.STARTING;
  els.levelsWrap.classList.toggle('hidden', !showLevels);
  if (!showLevels) {
    els.levelMicFill.style.width = '0%';
    els.levelTabFill.style.width = '0%';
  }

  // Pause button — only meaningful when the user can actually toggle
  // recording. Hidden during back-pressure-only pause: in that state
  // Resume is a no-op (the queue-drain logic decides when to resume,
  // not the user) and the queue-warn-row already explains the situation.
  const showPause =
    state.state === RecordingState.RECORDING &&
    (state.userPaused || !state.recordingPaused);
  if (showPause) {
    els.pause.classList.remove('hidden');
    if (state.userPaused) {
      els.pause.textContent = 'Resume';
      els.pause.classList.add('paused');
    } else {
      els.pause.textContent = 'Pause';
      els.pause.classList.remove('paused');
    }
  } else {
    els.pause.classList.add('hidden');
    els.pause.classList.remove('paused');
  }

  // Busy info is only meaningful between a failed Start attempt and
  // the user either switching tabs or the other recording stopping.
  if (state.state !== RecordingState.IDLE && state.state !== RecordingState.ERROR) {
    busyInfo = null;
    els.busyRow.classList.add('hidden');
  }

  // Queue warning banner — shows when depth has crossed WARN. If
  // recordingPaused is also set, the recorder is currently paused
  // waiting for the queue to drain.
  if (state.queueWarning) {
    els.queueWarnRow.classList.remove('hidden');
    els.queueWarnText.textContent = state.recordingPaused
      ? `Recording paused — ${state.uploadQueueDepth} chunks pending. Will resume when queue drains.`
      : `Network slow — ${state.uploadQueueDepth} chunks pending.`;
  } else {
    els.queueWarnRow.classList.add('hidden');
  }

  // Primary button
  switch (state.state) {
    case RecordingState.IDLE:
    case RecordingState.ERROR:
      els.primary.textContent = 'Start recording';
      els.primary.classList.remove('stop');
      els.primary.disabled = false;
      break;
    case RecordingState.STARTING:
      els.primary.textContent = 'Starting…';
      els.primary.disabled = true;
      break;
    case RecordingState.RECORDING:
      els.primary.textContent = 'Stop recording';
      els.primary.classList.add('stop');
      els.primary.disabled = false;
      break;
    case RecordingState.STOPPING:
      els.primary.textContent = 'Stopping…';
      els.primary.disabled = true;
      break;
    case RecordingState.NEEDS_REAUTH:
      els.primary.textContent = 'Re-auth required';
      els.primary.disabled = true;
      break;
    default:
      break;
  }

  updateElapsedTick();
  renderCaptionConsent(state);

  // Final pass: while a recording is live it is owned by the detached
  // control window, so the toolbar popup carries NO session data and
  // can't double-start (one-at-a-time). This runs last so it cleanly
  // overrides every session-surface element the logic above set.
  applyControlOwnedView(state);
}

// A recording is "control-owned" for every active state — the SW
// always opens the detached window when the session goes live.
function isControlOwned(state) {
  return state.state === RecordingState.STARTING
    || state.state === RecordingState.RECORDING
    || state.state === RecordingState.STOPPING;
}

function applyControlOwnedView(state) {
  if (!isControlOwned(state)) {
    if (els.controlActiveRow) els.controlActiveRow.classList.add('hidden');
    return;
  }
  // The floating control window is the canonical live-session surface,
  // but the popup still mirrors meeting-name + elapsed + speaker + mic +
  // chunks so the user can see them here too if the floating window is
  // covered or dismissed. We only suppress the duplicate level meters
  // (they only update from offscreen messages the popup also receives;
  // skipping the noise) and clamp the primary button so the user can't
  // accidentally start a second recording.
  els.levelsWrap.classList.add('hidden');
  els.levelMicFill.style.width = '0%';
  els.levelTabFill.style.width = '0%';
  els.pause.classList.add('hidden');
  // Primary button + the control-active row label mirror the actual
  // SW state. Previously both were hard-coded to "Recording…" /
  // "Recording", so clicking Stop left those two surfaces lagging
  // behind the state pill (which DID flip to "Stopping"). Now all
  // three surfaces stay in sync: STARTING → Starting…, RECORDING →
  // Recording…, STOPPING → Stopping….
  let primaryLabel = 'Recording…';
  let rowLabel = 'Recording';
  if (state.state === RecordingState.STARTING) {
    primaryLabel = 'Starting…';
    rowLabel = 'Starting';
  } else if (state.state === RecordingState.STOPPING) {
    primaryLabel = 'Stopping…';
    rowLabel = 'Stopping';
  }
  els.primary.textContent = primaryLabel;
  els.primary.classList.remove('stop');
  els.primary.disabled = true;
  if (els.controlActiveLabel) els.controlActiveLabel.textContent = rowLabel;
  if (els.controlActiveRow) els.controlActiveRow.classList.remove('hidden');
}

function _fmtRemainingShort(seconds) {
  // Concise H:MM / MM:SS so the badge stays narrow next to the elapsed
  // value. < 1 min collapses to "0:SS" so the countdown tension is
  // visible in the final minute.
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    return `${h}:${m}h`;
  }
  const m = Math.floor(s / 60);
  const r = (s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
}

function updateElapsedTick() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  if (lastState?.state === RecordingState.RECORDING && lastState.recordingStartedAt) {
    // Pause-aware: subtract total accumulated paused time plus the
    // in-progress pause, so the clock FREEZES while paused and
    // continues from the frozen value on resume. The formula is
    // self-freezing (now − pausedAt cancels now's growth), so the
    // 1s interval can keep running unconditionally.
    const effElapsed = () => {
      const s = lastState;
      const acc = s.accumulatedPausedMs || 0;
      const cur = (s.userPaused && s.pausedAt) ? (Date.now() - s.pausedAt) : 0;
      return Math.max(0, Date.now() - s.recordingStartedAt - acc - cur);
    };
    // P5 — server-controlled "Time left" badge. Computed as
    // ``capSeconds - (consumedAtStart + activeElapsedSeconds)`` so it
    // stays in sync with the backend's pause-aware audio_seconds
    // accounting. Hidden when the cap is disabled (capSeconds=0) or
    // already exceeded (the cap-exceeded banner takes its place).
    const updateCapRemaining = () => {
      const s = lastState;
      if (!s || !s.durationCapSeconds || s.capExceeded) {
        els.capRemainingRow?.classList.add('hidden');
        return;
      }
      const consumed = (s.durationCapConsumedAtStart || 0)
        + Math.floor(effElapsed() / 1000);
      const remaining = Math.max(0, s.durationCapSeconds - consumed);
      els.capRemainingValue.textContent = _fmtRemainingShort(remaining);
      els.capRemainingRow?.classList.remove('hidden');
    };
    els.elapsed.textContent = fmtElapsed(effElapsed());
    updateCapRemaining();
    elapsedTimer = setInterval(() => {
      els.elapsed.textContent = fmtElapsed(effElapsed());
      updateCapRemaining();
    }, 1000);
  } else if (lastState?.state === RecordingState.IDLE) {
    els.elapsed.textContent = '00:00';
    els.capRemainingRow?.classList.add('hidden');
  }
}

// Caption-visibility consent. Captions are force-enabled while
// recording (the speaker-timeline scrape needs them); the user
// decides whether to SEE them. Shown only while RECORDING on a
// meeting tab. Reflects the persisted choice.
function renderCaptionConsent(state) {
  if (!els.captionConsentRow) return;
  const recording = state && state.state === RecordingState.RECORDING;
  const meeting = state && (state.source === Source.GOOGLE_MEET
    || state.source === Source.MS_TEAMS);
  if (!recording || !meeting) {
    els.captionConsentRow.classList.add('hidden');
    return;
  }
  els.captionConsentRow.classList.remove('hidden');
  chrome.storage.local.get(StorageKey.CAPTION_SHOW).then((g) => {
    const v = g ? g[StorageKey.CAPTION_SHOW] : undefined;
    // unset → default hidden (preserves prior behaviour) but the
    // prompt stays visible so the user can opt in.
    const showing = v === true;
    els.captionShowBtn.classList.toggle('active', showing);
    els.captionHideBtn.classList.toggle('active', v === false);
    els.captionShowBtn.setAttribute('aria-pressed', String(showing));
    els.captionHideBtn.setAttribute('aria-pressed', String(v === false));
  }).catch(() => {});
}

els.captionShowBtn?.addEventListener('click', () => {
  chrome.storage.local.set({ [StorageKey.CAPTION_SHOW]: true });
  els.captionShowBtn.classList.add('active');
  els.captionHideBtn.classList.remove('active');
});
els.captionHideBtn?.addEventListener('click', () => {
  chrome.storage.local.set({ [StorageKey.CAPTION_SHOW]: false });
  els.captionHideBtn.classList.add('active');
  els.captionShowBtn.classList.remove('active');
});

async function refreshState() {
  const res = await sendMessage({ type: MessageType.GET_STATE });
  if (res.ok && res.data) render(res.data);
}

// --- Auth gating ----------------------------------------------------

// Cached display name for the signed-in user — prefers the backend
// ``user.name`` field (StorageKey.USER_NAME) and falls back to the
// email local part when the /user/profile round-trip hasn't landed yet
// (or the row's ``name`` is null). Refreshed on every storage change
// for USER_NAME / USER_EMAIL so a sign-out → sign-in as a different
// user immediately updates the popup.
//
// Refresh races with the first render: the popup may open and paint
// before the (async) storage read resolves, briefly showing an
// empty selfName. After the read lands we trigger a single re-render
// via ``refreshState`` so a Speaker fallback that hit the empty
// cache is replaced by the real name without waiting for the next
// STATE_UPDATE.
let _userDisplayName = '';
async function refreshUserDisplayName({ rerender = false } = {}) {
  _userDisplayName = await loadDisplayName();
  if (rerender) {
    try { await refreshState(); } catch { /* best-effort re-render */ }
  }
}
void refreshUserDisplayName({ rerender: true }).catch(() => {
  // loadDisplayName already swallows; this catch is for the
  // refreshState() call so a transient SW unreachability doesn't
  // produce an unhandled rejection at boot.
});

function signedInDisplayName() {
  return _userDisplayName;
}

function showAuthView() {
  els.authView.classList.remove('hidden');
  els.mainView.classList.add('hidden');
  els.pill.classList.add('hidden');
  // Single-mode signin — clear any previous error state and prep the
  // email input for typing.
  els.authError.classList.add('hidden');
  els.authError.textContent = '';
  els.authPassword.autocomplete = 'current-password';
  els.authEmail.focus();
}

function showMainView(email) {
  els.authView.classList.add('hidden');
  els.mainView.classList.remove('hidden');
  els.pill.classList.remove('hidden');
  if (email) {
    els.userEmail.textContent = email;
    els.authUserRow.classList.remove('hidden');
  } else {
    els.authUserRow.classList.add('hidden');
  }
}

function setAuthError(message) {
  els.authError.textContent = message;
  els.authError.classList.remove('hidden');
}

function validateInputs() {
  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setAuthError('Enter a valid email address.');
    return null;
  }
  if (password.length === 0) {
    setAuthError('Enter your password.');
    return null;
  }
  return { email, password };
}

async function handleAuthSubmit() {
  const creds = validateInputs();
  if (!creds) return;

  const labelBefore = els.authSubmit.textContent;
  els.authSubmit.disabled = true;
  els.authSubmit.textContent = 'Signing in…';
  els.authError.classList.add('hidden');

  try {
    // Signin only — signup is handled on https://app.meetminutes.in/signup.
    const result = await apiLogin(creds);
    // Successful auth — persistSession in the client already wrote
    // token + email to storage. The storage.onChanged listener below
    // will flip us to the main view, but we also do it eagerly here
    // so the user gets immediate feedback.
    els.authPassword.value = '';
    showMainView(result.email);
    refreshState();
  } catch (err) {
    if (err && err.name === 'AuthApiError') {
      setAuthError(err.message);
    } else {
      setAuthError('Something went wrong. Try again.');
    }
  } finally {
    els.authSubmit.disabled = false;
    els.authSubmit.textContent = labelBefore;
  }
}

/**
 * Web-assisted social login. The SW owns the chrome.identity flow
 * (it must outlive this popup); we just dispatch + reflect the
 * result. Success path mirrors handleAuthSubmit (the SW already wrote
 * the token bundle to storage).
 *
 * @param {'google'|'microsoft'} provider
 */
async function handleSocialAuth(provider) {
  const btn = provider === 'google' ? els.authGoogle : els.authMicrosoft;
  const labelBefore = btn.textContent;
  els.authGoogle.disabled = true;
  els.authMicrosoft.disabled = true;
  els.authSubmit.disabled = true;
  btn.textContent = 'Opening sign-in…';
  els.authError.classList.add('hidden');

  try {
    const res = await sendMessage({
      type: MessageType.START_SOCIAL_AUTH,
      provider,
    });
    if (res.ok && res.data && res.data.ok) {
      els.authPassword.value = '';
      showMainView(res.data.email);
      refreshState();
      return;
    }
    const code = res.data && res.data.code;
    // User closed the provider window — benign, no scary banner.
    if (code !== 'cancelled') {
      const msg = (res.data && res.data.error) || res.error
        || 'Social sign-in failed. Try again.';
      setAuthError(msg);
    }
  } catch (_err) {
    setAuthError('Something went wrong. Try again.');
  } finally {
    els.authGoogle.disabled = false;
    els.authMicrosoft.disabled = false;
    els.authSubmit.disabled = false;
    btn.textContent = labelBefore;
  }
}

async function handleSignout() {
  els.signoutBtn.disabled = true;
  try {
    // If a recording is active, stop it first — uploads will start
    // 401'ing the moment we revoke. The SW handles a stop-while-idle
    // gracefully (no-op).
    if (lastState?.state === RecordingState.RECORDING) {
      await sendMessage({ type: MessageType.STOP_RECORDING });
    }
    await apiLogout();
    // storage.onChanged below will switch the view; this is just a
    // belt-and-braces immediate update.
    showAuthView();
  } finally {
    els.signoutBtn.disabled = false;
  }
}

async function initAuthGate() {
  const got = await chrome.storage.local.get([
    StorageKey.AUTH_TOKEN,
    StorageKey.USER_EMAIL,
  ]);
  const token = got[StorageKey.AUTH_TOKEN];
  if (!token) {
    showAuthView();
    return;
  }
  showMainView(got[StorageKey.USER_EMAIL] ?? null);
  refreshState();
}

// Token can change behind our back — sign-out elsewhere, options page
// edit, or the SW clearing it on 401. Keep the view in sync.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (StorageKey.AUTH_TOKEN in changes) {
    const next = changes[StorageKey.AUTH_TOKEN].newValue;
    if (!next) {
      showAuthView();
    } else {
      // Token appeared — pick up the matching email if it landed in
      // the same change batch, else read it back.
      const emailChange = changes[StorageKey.USER_EMAIL];
      const email = emailChange ? emailChange.newValue : null;
      showMainView(email);
    }
  } else if (StorageKey.USER_EMAIL in changes) {
    // Email-only update (e.g. user re-signed-in with a different
    // address but same token slot). Refresh the displayed email.
    if (!els.authUserRow.classList.contains('hidden')) {
      els.userEmail.textContent = changes[StorageKey.USER_EMAIL].newValue ?? '—';
    }
  }
  // Mirror USER_NAME / USER_EMAIL changes into our cached display name
  // so the recording panel's speaker fallback picks up "Shubham
  // Pilivkar" without waiting for the next render cycle. Read via
  // resolveDisplayName (USER_NAME wins) using the change batch's
  // newValue when available, else fall through to a fresh storage
  // read.
  if (StorageKey.USER_NAME in changes || StorageKey.USER_EMAIL in changes) {
    const nameChange = changes[StorageKey.USER_NAME];
    const emailChange = changes[StorageKey.USER_EMAIL];
    if (nameChange || emailChange) {
      _userDisplayName = resolveDisplayName({
        userName: nameChange ? nameChange.newValue : undefined,
        userEmail: emailChange ? emailChange.newValue : undefined,
      });
      // If only one of the two changed in the batch, we may have lost
      // the other half — re-read so a partial change doesn't blank the
      // cache.
      if (!_userDisplayName) void refreshUserDisplayName();
    }
  }
});

// Tab-signin / Tab-signup buttons were removed when signup moved to
// the web app. The auth view is signin-only now; the "Sign up" link
// at the bottom of the form is the redirect path.
els.authSubmit.addEventListener('click', handleAuthSubmit);
els.authGoogle.addEventListener('click', () => handleSocialAuth('google'));
els.authMicrosoft.addEventListener('click', () => handleSocialAuth('microsoft'));
// Sign-up redirect — opens https://app.meetminutes.in/signup in a new
// browser tab. The popup auto-closes when focus leaves so we don't
// need to close it explicitly here. Uses chrome.tabs.create (the
// 'tabs' permission is already declared in manifest.json) rather
// than window.open() because window.open() in an extension popup
// targets the popup itself, which would replace this UI.
els.authSignupRedirect.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://app.meetminutes.in/signup' });
});
// Submit on Enter from either field
for (const input of [els.authEmail, els.authPassword]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAuthSubmit();
  });
}
els.signoutBtn.addEventListener('click', handleSignout);

async function handlePrimary() {
  if (!lastState) return;
  if (lastState.state === RecordingState.RECORDING) {
    await sendMessage({ type: MessageType.STOP_RECORDING });
    return;
  }
  if (
    lastState.state === RecordingState.IDLE ||
    lastState.state === RecordingState.ERROR
  ) {
    const target = await getActiveMeetingTab();
    if (!target || target.error) {
      renderError({
        rowEl: els.errorRow,
        msgEl: els.errorMessage,
        code: target && target.error ? target.error : 'no_meeting_tab',
      });
      return;
    }
    const res = await sendMessage({
      type: MessageType.START_RECORDING,
      ...target,
      // Optional user-supplied meeting name; blank → a readable
      // default like "Meeting at 17 May 11:30 IST".
      name: (els.meetingName && els.meetingName.value.trim())
        || defaultMeetingName(),
    });
    if (res.ok === false) {
      renderError({
        rowEl: els.errorRow, msgEl: els.errorMessage, code: res.error,
      });
      return;
    }
    // SW returned a structured code — handle non-success.
    const data = res.data;
    if (data && data.code === 'busy') {
      busyInfo = { activeTabId: data.activeTabId, activeUrl: data.activeUrl };
      els.busyRow.classList.remove('hidden');
      return;
    }
    if (data && data.code === 'busy_transcribing') {
      // Symmetric mutex with the transcribe-side ``busy_recording``
      // guard. Show the standard error row rather than a "switch to
      // that tab" affordance — transcribe doesn't expose tab-switch
      // and "stop transcription first" is the natural recovery.
      renderError({
        rowEl: els.errorRow,
        msgEl: els.errorMessage,
        code: 'Live transcription is active — stop it first.',
      });
      return;
    }
    // 'auth' / 'error' codes update SessionState directly; STATE_UPDATE
    // re-renders us. Nothing extra to do here.
  }
}

els.primary.addEventListener('click', handlePrimary);

// "Open controls" — re-focus (or re-create) the detached recording
// window so a live session is reachable even though the popup itself
// shows no session data.
if (els.openControls) {
  els.openControls.addEventListener('click', () => {
    sendMessage({ type: MessageType.FOCUS_CONTROL_WINDOW }).catch(() => {});
  });
}

els.pause.addEventListener('click', async () => {
  if (!lastState) return;
  if (lastState.state !== RecordingState.RECORDING) return;
  const pausing = !lastState.userPaused;
  // Optimistic UI: flip the button + freeze/continue the elapsed
  // clock immediately (same math the SW applies) so pause feels
  // instant and is resilient if the SW is suspended and its
  // STATE_UPDATE broadcast lags. The broadcast reconciles after.
  const now = Date.now();
  render(pausing
    ? { ...lastState, userPaused: true, pausedAt: lastState.pausedAt ?? now }
    : {
      ...lastState,
      userPaused: false,
      pausedAt: null,
      accumulatedPausedMs: (lastState.accumulatedPausedMs || 0)
        + (lastState.pausedAt ? Math.max(0, now - lastState.pausedAt) : 0),
    });
  await sendMessage({
    type: pausing ? MessageType.USER_PAUSE : MessageType.USER_RESUME,
  });
});
// "Sign in again" link inside the NEEDS_REAUTH row. Clearing the
// stored token + email is enough — the storage.onChanged listener
// already swaps the popup to the auth view (where the user lands on
// the Sign in tab by default). We don't call apiLogout() here because
// the token is already invalid server-side; revoking is moot.
els.reauthLink.addEventListener('click', async (e) => {
  e.preventDefault();
  await chrome.storage.local.remove([StorageKey.AUTH_TOKEN, StorageKey.USER_EMAIL]);
});
els.openOptionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// "Report a problem" — opens the user's default mail client with the
// support address pre-filled. A bare ``<a href="mailto:…">`` in an MV3
// popup is unreliable: the popup closes the moment the link is clicked
// and Chrome can drop the navigation before the OS handler resolves it.
// Routing through ``chrome.tabs.create`` opens the mailto URL as a new
// browser tab, which the OS reliably hands to the registered mail app.
if (els.reportProblemLink) {
  els.reportProblemLink.addEventListener('click', (e) => {
    e.preventDefault();
    const url = els.reportProblemLink.getAttribute('href')
      || 'mailto:support@meetminutes.in';
    chrome.tabs.create({ url }).catch(() => {
      // Last-resort fallback: try plain window.open, which works in
      // some Chrome builds where chrome.tabs.create is denied for
      // non-http schemes.
      try { window.open(url, '_blank'); } catch { /* nothing more we can do */ }
    });
    window.close();
  });
}

// Legal links in the auth-view footer (Terms + Privacy Policy).
// Same chrome.tabs.create pattern as the report-problem link —
// without it, plain <a href> in an MV3 popup can drop the
// navigation when the popup closes the moment the link is clicked.
for (const id of ['auth-terms-link', 'auth-privacy-link']) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener('click', (e) => {
    e.preventDefault();
    const url = el.getAttribute('href');
    if (!url) return;
    chrome.tabs.create({ url }).catch(() => {
      try { window.open(url, '_blank'); } catch { /* noop */ }
    });
  });
}

els.switchTab.addEventListener('click', async (e) => {
  e.preventDefault();
  if (!busyInfo || !busyInfo.activeTabId) return;
  try {
    await chrome.tabs.update(busyInfo.activeTabId, { active: true });
    const tab = await chrome.tabs.get(busyInfo.activeTabId);
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    window.close();
  } catch (err) {
    els.errorRow.classList.remove('hidden');
    els.errorMessage.textContent =
      'Could not switch — the recording tab may have been closed.';
  }
});

// Carries the popup click's user activation through SW -> offscreen so
// the offscreen <audio> monitor can play() under Chrome's autoplay
// policy. Activation propagation across messaging is best-effort.
els.restoreMonitor.addEventListener('click', async (e) => {
  e.preventDefault();
  const res = await sendMessage({ type: MessageType.RETRY_MONITOR });
  if (!res.ok || (res.data && res.data.ok === false)) {
    els.errorRow.classList.remove('hidden');
    els.errorMessage.textContent =
      'Could not restore audio. Click in the meeting tab and try again.';
  }
});

// --- Live transcription panel --------------------------------------

let lastTranscribeState = null;

function renderTranscribeState(state) {
  lastTranscribeState = state;
  renderSessionsStrip();
  const s = state.state || TranscribeState.IDLE;
  els.transcribeStatusPill.className = `pill state-${s.toLowerCase()}`;
  // RECONNECTING gets a more informative label than the auto-cased
  // state name — "Reconnecting (2/4)" is more useful than "Reconnecting".
  if (s === TranscribeState.RECONNECTING && state.reconnectAttempt) {
    els.transcribeStatusPill.textContent =
      `Reconnecting (${state.reconnectAttempt}/${state.reconnectMaxAttempts || '?'})`;
  } else if (s === TranscribeState.ACTIVE && state.hasFirstEvent === false) {
    // Phase L1 — WS is open but no provider event has arrived yet.
    // Today this is the 200-500ms backend-side cold-start while the
    // upstream provider WS opens lazily. Show "Listening…" so the
    // user gets a beat instead of staring at a stale "Active" pill
    // that nothing's happening behind. The CSS class stays
    // ``state-active`` so colours don't flicker between this state
    // and the post-first-event "Active".
    els.transcribeStatusPill.textContent = 'Listening…';
  } else {
    els.transcribeStatusPill.textContent =
      s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ');
  }

  // Pickers are locked to whatever the SW handshaked with the backend
  // while a session exists — including the PAUSED case where the
  // session is alive but no audio is flowing, and RECONNECTING where
  // the session params must remain stable across the re-attach.
  const sessionAlive =
    s === TranscribeState.ACTIVE ||
    s === TranscribeState.PAUSED ||
    s === TranscribeState.RECONNECTING ||
    s === TranscribeState.STARTING ||
    s === TranscribeState.STOPPING;
  els.transcribeMode.disabled = sessionAlive;
  els.transcribeLanguage.disabled = sessionAlive;

  // Primary button — Start/Stop/transitional. Pause button is its
  // sibling (rendered below) so the user can pause without losing
  // the stop affordance.
  // Stop is still actionable during RECONNECTING — the user shouldn't
  // be stuck waiting through the full backoff when they want out.
  if (
    s === TranscribeState.ACTIVE
    || s === TranscribeState.PAUSED
    || s === TranscribeState.RECONNECTING
  ) {
    els.transcribeBtn.textContent = 'Stop transcription';
    els.transcribeBtn.classList.add('stop');
    els.transcribeBtn.disabled = false;
  } else if (s === TranscribeState.STARTING) {
    els.transcribeBtn.textContent = 'Starting…';
    els.transcribeBtn.disabled = true;
  } else if (s === TranscribeState.STOPPING) {
    els.transcribeBtn.textContent = 'Stopping…';
    els.transcribeBtn.disabled = true;
  } else {
    els.transcribeBtn.textContent = 'Start transcription';
    els.transcribeBtn.classList.remove('stop');
    els.transcribeBtn.disabled = false;
  }

  // Pause / Resume button — only shown for ACTIVE and PAUSED states.
  // The label toggles based on direction so a single button handles
  // both transitions cleanly. Pause is hidden during RECONNECTING
  // because there's no audio flowing anyway.
  if (s === TranscribeState.ACTIVE) {
    els.transcribePauseBtn.classList.remove('hidden', 'paused');
    els.transcribePauseBtn.textContent = 'Pause';
    els.transcribePauseBtn.disabled = false;
  } else if (s === TranscribeState.PAUSED) {
    els.transcribePauseBtn.classList.remove('hidden');
    els.transcribePauseBtn.classList.add('paused');
    els.transcribePauseBtn.textContent = 'Resume';
    els.transcribePauseBtn.disabled = false;
  } else {
    els.transcribePauseBtn.classList.add('hidden');
    els.transcribePauseBtn.classList.remove('paused');
  }

  renderError({
    rowEl: els.transcribeErrorRow,
    msgEl: els.transcribeErrorMessage,
    code: state.error,
  });

  // Phase U2 — VAD savings. Worklet reports rolling drop% every 60s
  // while transcribing; the SW mirrors that into state.vadDroppedPct.
  // Hidden until at least one report has landed AND the session is
  // still alive (a stale value from a previous session would mislead).
  const showVad = typeof state.vadDroppedPct === 'number'
    && (s === TranscribeState.ACTIVE || s === TranscribeState.PAUSED
        || s === TranscribeState.RECONNECTING);
  if (showVad) {
    els.transcribeVadRow.classList.remove('hidden');
    const pct = Number(state.vadDroppedPct).toFixed(1);
    els.transcribeVadValue.textContent = `${pct}% silence skipped`;
  } else {
    els.transcribeVadRow.classList.add('hidden');
  }

  // Phase L4 — important points. Rendered while a session is alive
  // OR after one ends so a user who clicks Stop still sees what
  // landed (cleared on the next fresh start via the SW's
  // ``...INITIAL_TRANSCRIBE_STATE`` reset). Empty list hides the
  // whole section so an early-session popup isn't dominated by an
  // empty container.
  renderImportantPoints(Array.isArray(state.importantPoints) ? state.importantPoints : []);
}

// Phase L4 — render a flat list of extracted important points in
// receive order (the SW appends; we don't re-sort). Each point gets
// a type-coloured chip + text + optional speaker attribution.
function renderImportantPoints(points) {
  if (!points || points.length === 0) {
    els.importantPointsSection.classList.add('hidden');
    els.importantPointsList.innerHTML = '';
    els.importantPointsCount.textContent = '0';
    return;
  }
  els.importantPointsSection.classList.remove('hidden');
  els.importantPointsCount.textContent = String(points.length);
  // Full re-render. ~50 points max per typical meeting per the
  // backend memo; cheaper than diffing for that size.
  els.importantPointsList.innerHTML = '';
  for (const p of points) {
    if (!p || typeof p.text !== 'string') continue;
    const row = document.createElement('div');
    row.className = 'important-point';
    const typeChip = document.createElement('span');
    typeChip.className = `important-point-type ${p.type}`;
    typeChip.textContent = formatPointType(p.type);
    row.appendChild(typeChip);
    const textWrap = document.createElement('span');
    textWrap.className = 'important-point-text';
    textWrap.textContent = p.text;
    // E1 — single resolver owns synthetic-label filtering AND first-
    // name → full-name promotion so "Shubham" renders as "Shubham
    // Pilivkar" (matching the overlay's behaviour for the same point).
    // Backend correlator resolves names against the recording's
    // speaker timeline post-finalize; this is the live-render fix.
    const resolved = resolveImportantPointSpeaker(p.speaker, _userDisplayName);
    if (resolved) {
      const sp = document.createElement('span');
      sp.className = 'important-point-speaker';
      sp.textContent = `— ${resolved}`;
      textWrap.appendChild(sp);
    }
    row.appendChild(textWrap);
    els.importantPointsList.appendChild(row);
  }
}

function formatPointType(t) {
  switch (t) {
    case 'action_item': return 'Action';
    case 'decision': return 'Decision';
    case 'question': return 'Question';
    case 'key_takeaway': return 'Takeaway';
    default: return t || '';
  }
}

async function restoreTranscribePickers() {
  // Last-used values persist across popup opens so the user doesn't
  // re-pick mode + language every time. Provider selection lives
  // server-side now — the user neither sees nor picks which vendor
  // handles the audio.
  const got = await chrome.storage.local.get([
    StorageKey.TRANSCRIBE_LAST_MODE,
    StorageKey.TRANSCRIBE_LAST_LANGUAGE,
  ]);
  els.transcribeMode.value =
    got[StorageKey.TRANSCRIBE_LAST_MODE] || TranscribeMode.SELF;
  // Default to 'en', not 'auto': a deploy whose configured STT
  // provider can't language-detect (Deepgram/AssemblyAI) 422s every
  // 'auto' request, dead-ending Start. 'auto' is still user-selectable.
  els.transcribeLanguage.value =
    got[StorageKey.TRANSCRIBE_LAST_LANGUAGE] || 'en';
}

async function refreshTranscribeState() {
  const res = await sendMessage({ type: MessageType.GET_TRANSCRIBE_STATE });
  if (res.ok && res.data) {
    renderTranscribeState(res.data);
  } else if (!res.ok && res.error !== 'no_receiver') {
    renderTranscribeState({ state: TranscribeState.IDLE });
  }
}

async function handleTranscribeClick() {
  if (!lastTranscribeState) {
    await refreshTranscribeState();
    if (!lastTranscribeState) return;
  }
  // Stop path — must cover EVERY state the button labels as "Stop
  // transcription" (see renderTranscribeState: ACTIVE | PAUSED |
  // RECONNECTING). Guarding on ACTIVE alone meant a click while
  // PAUSED/RECONNECTING fell through to the start path below, which
  // re-issued START_TRANSCRIBE against a still-live session and the
  // SW rejected it with ``busy_transcribing`` ("A transcription
  // session is already active."). STARTING/STOPPING keep the button
  // disabled so they never reach here.
  if (
    lastTranscribeState.state === TranscribeState.ACTIVE
    || lastTranscribeState.state === TranscribeState.PAUSED
    || lastTranscribeState.state === TranscribeState.RECONNECTING
  ) {
    await sendMessage({ type: MessageType.STOP_TRANSCRIBE });
    return;
  }
  // Start path — resolve the active Meet/Teams tab; both modes
  // require one because the floating overlay renders there.
  const target = await getActiveMeetingTab();
  if (!target || target.error) {
    renderTranscribeState({
      state: TranscribeState.IDLE,
      error: target && target.error === 'not_in_meeting_room'
        ? 'Open a Meet or Teams meeting in this tab first.'
        : 'Open a Google Meet or Microsoft Teams tab and try again.',
    });
    return;
  }
  const mode = els.transcribeMode.value;
  const language = els.transcribeLanguage.value;

  await chrome.storage.local.set({
    [StorageKey.TRANSCRIBE_LAST_MODE]: mode,
    [StorageKey.TRANSCRIBE_LAST_LANGUAGE]: language,
  });
  const res = await sendMessage({
    type: MessageType.START_TRANSCRIBE,
    mode,
    language,
    tabId: target.tabId,
    url: target.url,
  });
  if (res.ok === false) {
    // Benign: the SW handler opened the mic-permission window which
    // closed this popup before it could answer. The session is still
    // starting in the SW — its real outcome arrives via the
    // TRANSCRIBE_STATE_UPDATE broadcast (handled below). Show
    // "starting", NOT a hard error.
    if (res.error === 'channel_closed' || res.error === 'no_receiver') {
      renderTranscribeState({ state: TranscribeState.STARTING });
      return;
    }
    renderTranscribeState({ state: TranscribeState.ERROR, error: res.error });
    return;
  }
  const data = res.data;
  if (data && data.code) {
    const msg = {
      busy_recording: 'Recording is active — stop it first.',
      busy_transcribing: 'A transcription session is already active.',
      auth: 'Sign in expired — sign in again.',
      no_meeting_tab: 'Open a Meet / Teams tab to use Mode 2.',
    }[data.code] || `Start failed: ${data.detail ?? data.code}`;
    renderTranscribeState({ state: TranscribeState.IDLE, error: msg });
  }
}

els.transcribeBtn.addEventListener('click', handleTranscribeClick);
els.transcribePauseBtn.addEventListener('click', async () => {
  if (!lastTranscribeState) return;
  // The button covers both directions of the toggle — read current
  // state to decide which message to send.
  const messageType =
    lastTranscribeState.state === TranscribeState.PAUSED
      ? MessageType.RESUME_TRANSCRIBE
      : MessageType.PAUSE_TRANSCRIBE;
  const res = await sendMessage({ type: messageType });
  if (res.ok === false) {
    renderTranscribeState({
      ...lastTranscribeState,
      error: res.error || 'pause/resume failed',
    });
  }
});

// Listen for SW-broadcast state updates so the panel reflects the
// session lifecycle even when the popup wasn't open during start.
onMessage({
  [MessageType.STATE_UPDATE]: (message) => {
    if (message.state) render(message.state);
  },
  // P5 — heads-up that the cap auto-stop will fire soon. We surface
  // this via the warn row that `render` will also toggle on once the
  // next STATE_UPDATE lands with ``capWarningEmitted=true``; emitting
  // here too keeps the toast snappy when the popup is already open.
  [MessageType.CAP_WARNING]: (message) => {
    if (!els.capWarningRow || !els.capWarningText) return;
    const remaining = Number(message?.warningAtSecondsRemaining) || 0;
    const mins = Math.max(1, Math.round(remaining / 60));
    els.capWarningText.textContent =
      `Recording will auto-stop in about ${mins} minute${mins === 1 ? '' : 's'}.`;
    els.capWarningRow.classList.remove('hidden');
  },
  [MessageType.TRANSCRIBE_STATE_UPDATE]: (message) => {
    if (message.state) renderTranscribeState(message.state);
  },
  [MessageType.LEVEL_UPDATE]: (message) => {
    if (
      lastState?.state !== RecordingState.RECORDING &&
      lastState?.state !== RecordingState.STARTING
    ) {
      return;
    }
    const tabPct = Math.max(0, Math.min(100, (message.tab ?? 0) * 100));
    const micPct = message.mic === null
      ? 0
      : Math.max(0, Math.min(100, (message.mic ?? 0) * 100));
    els.levelTabFill.style.width = `${tabPct}%`;
    els.levelMicFill.style.width = `${micPct}%`;
  },
});

// ----- View tabs (Record / Bot) -----------------------------------------

/**
 * Swap which top-level section is visible. Three independent
 * sections now: Record, Bot, Transcribe (Transcribe is its own
 * section, no longer nested under Record). Defaults to Record.
 *
 * @param {'record' | 'bot' | 'transcribe'} which
 */
function setView(which) {
  const views = {
    record: { tab: els.tabRecord, view: els.recordView },
    bot: { tab: els.tabBot, view: els.botView },
    transcribe: { tab: els.tabTranscribe, view: els.transcribeView },
  };
  for (const [name, { tab, view }] of Object.entries(views)) {
    const on = name === which;
    if (view) view.classList.toggle('hidden', !on);
    if (tab) {
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
    }
  }
  // Reset bot-tab feedback rows when leaving Bot so a stale error /
  // success from a previous attempt doesn't flash on re-entry.
  if (which !== 'bot') {
    els.botError.classList.add('hidden');
    els.botError.textContent = '';
    els.botSuccess.classList.add('hidden');
  }
}

els.tabRecord.addEventListener('click', () => setView('record'));
els.tabBot.addEventListener('click', () => setView('bot'));
if (els.tabTranscribe) {
  els.tabTranscribe.addEventListener('click', () => setView('transcribe'));
}

// ----- Bot dispatch -----------------------------------------------------

/**
 * Read the selected platform radio. Defaults to ``google_meet`` if
 * for some reason none is selected (shouldn't happen — one is
 * checked by default in the HTML).
 *
 * @returns {'google_meet' | 'ms_teams' | 'zoom'}
 */
function getSelectedBotPlatform() {
  const checked = document.querySelector(
    'input[name="bot-platform"]:checked',
  );
  const value = /** @type {HTMLInputElement | null} */ (checked)?.value;
  if (value === 'ms_teams' || value === 'zoom') return value;
  return 'google_meet';
}

function showBotError(message) {
  els.botError.textContent = message;
  els.botError.classList.remove('hidden');
  els.botSuccess.classList.add('hidden');
}

function clearBotFeedback() {
  els.botError.textContent = '';
  els.botError.classList.add('hidden');
  els.botSuccess.classList.add('hidden');
}

/**
 * Validate the URL shape on the client so the user sees the failure
 * before a network round-trip. The backend remains the source of
 * truth — this is a UX nicety, not a security boundary.
 */
function validateBotInputs(name, url, platform) {
  if (!name) return 'Please enter a meeting name.';
  if (name.length > 512) return 'Meeting name is too long (max 512).';
  if (!url) return 'Please paste the meeting URL.';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'That doesn’t look like a valid URL.';
  }
  if (parsed.protocol !== 'https:') {
    return 'Meeting URL must start with https://.';
  }
  // Soft hint when the URL host doesn't match the picked platform.
  // We don't refuse — the bot service has the final say (corporate
  // Teams custom domains exist) — but a typo-shaped mismatch deserves
  // a warning before we burn the request.
  const host = parsed.hostname.toLowerCase();
  if (platform === 'google_meet' && !host.includes('meet.google.com')) {
    return 'This URL doesn’t look like a Google Meet link.';
  }
  if (platform === 'ms_teams' && !host.includes('teams.')) {
    return 'This URL doesn’t look like a Microsoft Teams link.';
  }
  if (platform === 'zoom' && !host.includes('zoom.us')) {
    return 'This URL doesn’t look like a Zoom link.';
  }
  return null;
}

els.botSubmit.addEventListener('click', async () => {
  clearBotFeedback();
  const name = els.botName.value.trim();
  const url = els.botUrl.value.trim();
  const platform = getSelectedBotPlatform();

  const validationError = validateBotInputs(name, url, platform);
  if (validationError) {
    showBotError(validationError);
    return;
  }

  els.botSubmit.disabled = true;
  try {
    const result = await apiDispatchBot({
      name,
      meeting_url: url,
      platform,
    });
    els.botSuccess.classList.remove('hidden');
    // Clear the form so a follow-up dispatch starts clean. The
    // success row stays visible until the user navigates away.
    els.botName.value = '';
    els.botUrl.value = '';
    // ``result`` carries { bot_id, status } — bot_id is the opaque
    // id support can use to trace a dispatch. No console output in
    // production; the success row in the popup is the user-facing
    // ack, and server-side bot tracing reads from the backend log.
  } catch (err) {
    const code = /** @type {{code?: string}} */ (err)?.code;
    if (code === 'invalid_request') {
      showBotError('The bot service couldn’t accept that meeting. Check the URL and platform.');
    } else if (code === 'rate_limited') {
      showBotError('Too many bot dispatches — wait a minute and try again.');
    } else if (code === 'unavailable') {
      showBotError('Bot service is offline right now. Try again in a few minutes.');
    } else {
      showBotError(`Couldn’t dispatch the bot (${err instanceof Error ? err.message : 'unknown error'}).`);
    }
  } finally {
    els.botSubmit.disabled = false;
  }
});

// Submit on Enter from either text input — matches the auth-form UX.
for (const input of [els.botName, els.botUrl]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.botSubmit.click();
  });
}

// ----- Subscription feature gates ---------------------------------------
//
// Single source of truth for "which surface is gated by which backend
// flag". Adding a new gated control = adding one entry here. The
// applyGates loop below handles the visual + interactive lock; no
// per-feature branching anywhere else in popup.js.
//
// Each entry is intentionally light:
//   * key       — wire-format flag from external_platform.*_enabled
//   * tabs      — top-level tab buttons to lock (greyed + lock glyph)
//   * primaries — the action buttons that would START the feature
//                 (we only intercept their click; pause/stop on an
//                 already-running session stay reachable so users can
//                 always stop a running session even after a plan change)
//
// FEATURE_LABEL keeps the user-facing strings centralised so the
// upgrade modal title doesn't drift from the registry.
const GATED_FEATURES = [
  {
    key: FeatureKey.RECORDING,
    tabs: () => [els.tabRecord],
    primaries: () => [els.primary],
  },
  {
    key: FeatureKey.LIVE_TRANSCRIPTION,
    tabs: () => [els.tabTranscribe],
    primaries: () => [els.transcribeBtn],
  },
  {
    key: FeatureKey.BOT,
    tabs: () => [els.tabBot],
    primaries: () => [els.botSubmit],
  },
];

let _featureGate = null;

/**
 * Open the upgrade modal with the friendly feature name baked into
 * the title bar. Centralised so the modal copy stays consistent
 * whether the user clicked the Record tab, the Transcribe button, or
 * the Bot submit. Clicking Upgrade Plan opens the pricing page in a
 * new tab via openPricingPage (chrome.tabs.create); Contact Support
 * opens SUPPORT_PAGE_URL via openSupportPage (chrome.tabs.create).
 * The "Report a problem" footer link is a separate mailto and is
 * untouched by this flow.
 *
 * @param {string} featureKey  one of FeatureKey.*
 */
function openUpgradeModal(featureKey) {
  if (!els.upgradeModal) return;
  const label = FEATURE_LABEL[featureKey] || 'Premium feature';
  if (els.upgradeModalTitle) {
    els.upgradeModalTitle.textContent = `${label} is a premium feature`;
  }
  if (els.upgradeModalMessage) {
    els.upgradeModalMessage.textContent =
      'This feature is not included in your current subscription plan. '
      + 'Upgrade to unlock it for every meeting.';
  }
  els.upgradeModal.classList.remove('hidden');
}

function closeUpgradeModal() {
  if (!els.upgradeModal) return;
  els.upgradeModal.classList.add('hidden');
}

if (els.upgradeModalClose) {
  els.upgradeModalClose.addEventListener('click', closeUpgradeModal);
}
if (els.upgradeModalBackdrop) {
  els.upgradeModalBackdrop.addEventListener('click', closeUpgradeModal);
}
// Escape closes the modal — table-stakes a11y for any dialog.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!els.upgradeModal || els.upgradeModal.classList.contains('hidden')) return;
  closeUpgradeModal();
});
if (els.upgradeModalCta) {
  els.upgradeModalCta.addEventListener('click', () => {
    openPricingPage();
    closeUpgradeModal();
  });
}
if (els.upgradeModalSupport) {
  els.upgradeModalSupport.addEventListener('click', () => {
    openSupportPage();
    closeUpgradeModal();
  });
}

/**
 * Apply the latest gate snapshot to every registered control. Each
 * tab/primary gets the .feature-disabled class when its flag is
 * false; a click-capture handler intercepts the click and opens the
 * upgrade modal instead of running the underlying action.
 *
 * We use a click-capture listener (not the regular addEventListener)
 * so we run BEFORE the existing handlePrimary / setView / botSubmit
 * handlers and can stopImmediatePropagation when gated. That way no
 * one writes a special case into every action handler.
 *
 * Idempotent — safe to call on every snapshot change. The capture
 * listener is registered once per element via a WeakSet.
 *
 * @param {{ enabled: (key: string) => boolean }} gate
 */
const _gateInterceptInstalled = new WeakSet();

function applyGates(gate) {
  for (const entry of GATED_FEATURES) {
    const enabled = gate.enabled(entry.key);
    const targets = [...entry.tabs(), ...entry.primaries()].filter(Boolean);
    for (const el of targets) {
      el.classList.toggle('feature-disabled', !enabled);
      if (enabled) {
        el.removeAttribute('aria-disabled');
        el.removeAttribute('data-mm-gated-key');
      } else {
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('data-mm-gated-key', entry.key);
      }
      if (!_gateInterceptInstalled.has(el)) {
        // Capture-phase so we run before any user click handler. We
        // read the gate decision freshly via data-mm-gated-key set
        // above, so toggling enabled/disabled flips behaviour without
        // re-registering the listener.
        el.addEventListener('click', (ev) => {
          const k = el.getAttribute('data-mm-gated-key');
          if (!k) return;
          ev.stopImmediatePropagation();
          ev.preventDefault();
          openUpgradeModal(k);
        }, true);
        _gateInterceptInstalled.add(el);
      }
    }
  }
}

/**
 * Boot the feature gate. Reads the cached external_platform snapshot
 * (default-allows when missing so a fresh install isn't blocked),
 * applies the gate to every registered control, and subscribes to
 * storage changes so a SW refresh (alarm / post-login) live-updates
 * the popup without a reopen.
 */
async function initFeatureGates() {
  try {
    _featureGate = await loadGate({ onChange: (g) => applyGates(g) });
    applyGates(_featureGate);
  } catch {
    // Storage unavailable / API completely broken — default-allow so
    // the user can keep working; the SW will refresh later.
  }
}

// Entry point — decide auth view vs main view, then (if authed)
// load the recording state. Replaces the previous unconditional
// refreshState() call so a signed-out user doesn't briefly render
// the main view before the auth check resolves.
initAuthGate();
restoreTranscribePickers();
refreshTranscribeState();
initFeatureGates();
