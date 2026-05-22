// Detached recording-control pill. A persistent, always-visible
// surface for the live recording: a single dark rounded box with a
// rec dot, meeting name + duration + current speaker, slim system +
// mic level meters, the uploaded/recorded chunk counter, and
// pause/stop controls. Mirrors the popup's session row so the user
// has a single live readout whether the popup is open or not.
//
// Thin client of the service worker (single source of truth): it
// subscribes to the same STATE_UPDATE + LEVEL_UPDATE broadcasts the
// toolbar popup uses and sends USER_PAUSE / USER_RESUME /
// STOP_RECORDING. Closes itself once the session ends.

import { MessageType, RecordingState, StorageKey } from '../constants.js';
import { onMessage, sendMessage } from '../lib/messaging.js';
import { loadDisplayName, resolveDisplayName } from '../lib/user-name.js';

// Cached signed-in display name. Prefers the backend ``user.name``
// (StorageKey.USER_NAME) and falls back to the email local part — see
// lib/user-name.js for the resolution rules. Used as the Speaker
// fallback in the control-window pill before the first SPEAKER_CHANGE
// arrives, so users see "Shubham Pilivkar" instead of "Shubhampilivkar"
// or a generic "Speaker".
let _userDisplayName = '';
(async () => {
  try {
    _userDisplayName = await loadDisplayName();
  } catch { /* ignore — fallback stays empty */ }
})();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (
    !(StorageKey.USER_NAME in changes)
    && !(StorageKey.USER_EMAIL in changes)
  ) return;
  const nameChange = changes[StorageKey.USER_NAME];
  const emailChange = changes[StorageKey.USER_EMAIL];
  _userDisplayName = resolveDisplayName({
    userName: nameChange ? nameChange.newValue : undefined,
    userEmail: emailChange ? emailChange.newValue : undefined,
  });
  // Partial change: only one of the two keys was in this batch — fall
  // through to a full re-read so the cache doesn't blank.
  if (!_userDisplayName) {
    loadDisplayName().then((n) => { _userDisplayName = n; })
      .catch(() => { /* stay empty */ });
  }
});

const $ = (id) => document.getElementById(id);
const els = {
  dot: $('dot'),
  meetingName: $('meeting-name'),
  elapsed: $('elapsed'),
  speaker: $('current-speaker'),
  chunks: $('chunks'),
  pause: $('pause'),
  stop: $('stop'),
  micFill: $('level-mic-fill'),
  tabFill: $('level-tab-fill'),
};

let lastState = null;
let elapsedTimer = null;
let closing = false;

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Pause-aware, self-freezing (matches popup.updateElapsedTick): while
// paused, (now − pausedAt) cancels now's growth so the clock holds.
function effElapsed() {
  const s = lastState;
  if (!s || !s.recordingStartedAt) return 0;
  const acc = s.accumulatedPausedMs || 0;
  const cur = (s.userPaused && s.pausedAt) ? (Date.now() - s.pausedAt) : 0;
  return Math.max(0, Date.now() - s.recordingStartedAt - acc - cur);
}

function startTick() {
  if (elapsedTimer) return;
  const paint = () => { els.elapsed.textContent = fmtElapsed(effElapsed()); };
  paint();
  elapsedTimer = setInterval(paint, 1000);
}

function stopTick() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

function selfClose() {
  if (closing) return;
  closing = true;
  stopTick();
  setTimeout(() => { try { window.close(); } catch { /* noop */ } }, 500);
}

function render(state) {
  lastState = state;
  const st = state?.state;

  els.meetingName.textContent = state?.meetingName || '';
  // Mirror popup.js: while a recording is active, fall back to the
  // signed-in user's display name (derived from mm_user_email) until
  // a real SPEAKER_CHANGE arrives. "—" only outside a live session.
  const recActive =
    state?.state === RecordingState.STARTING
    || state?.state === RecordingState.RECORDING;
  els.speaker.textContent =
    state?.currentSpeaker
    || (recActive ? (_userDisplayName || '—') : '—');

  if (st === RecordingState.IDLE) {
    els.dot.className = 'dot idle';
    els.pause.disabled = true;
    els.stop.disabled = true;
    selfClose();
    return;
  }
  if (st === RecordingState.ERROR || st === RecordingState.NEEDS_REAUTH) {
    els.dot.className = 'dot idle';
    els.pause.disabled = true;
    els.stop.disabled = false; // allow an explicit close/stop
    stopTick();
    return;
  }

  // recorded = monotonic chunk count; pending = not-yet-uploaded.
  const recorded = (state.lastChunkIndex ?? -1) + 1;
  const pending = state.uploadQueueDepth || 0;
  const uploaded = Math.max(0, recorded - pending);
  els.chunks.textContent = `↑${uploaded}/${recorded}`;

  const paused = !!state.userPaused;
  if (st === RecordingState.STARTING) {
    els.dot.className = 'dot';
    els.pause.disabled = true;
    els.stop.disabled = false;
    startTick();
  } else if (st === RecordingState.RECORDING) {
    els.dot.className = paused ? 'dot paused' : 'dot';
    els.pause.classList.toggle('resume', paused);
    els.pause.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    els.pause.title = paused ? 'Resume' : 'Pause';
    els.pause.disabled = false;
    els.stop.disabled = false;
    startTick();
  } else if (st === RecordingState.STOPPING) {
    els.dot.className = 'dot idle';
    els.pause.disabled = true;
    els.stop.disabled = true;
    stopTick();
    els.elapsed.textContent = fmtElapsed(effElapsed());
  }
}

els.pause.addEventListener('click', async () => {
  if (!lastState || lastState.state !== RecordingState.RECORDING) return;
  const pausing = !lastState.userPaused;
  // Optimistic: flip + freeze/continue the clock NOW (mirrors the SW
  // math) so pause feels instant and still works if the SW is cold
  // and the STATE_UPDATE broadcast lags. The authoritative broadcast
  // reconciles any drift a moment later.
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

els.stop.addEventListener('click', async () => {
  els.pause.disabled = true;
  els.stop.disabled = true;
  els.dot.className = 'dot idle';
  await sendMessage({ type: MessageType.STOP_RECORDING });
});

onMessage({
  [MessageType.STATE_UPDATE]: (message) => { render(message.state); },
  [MessageType.LEVEL_UPDATE]: (message) => {
    const st = lastState?.state;
    if (st !== RecordingState.RECORDING && st !== RecordingState.STARTING) return;
    const clamp = (v) => Math.max(0, Math.min(100, (v ?? 0) * 100));
    els.tabFill.style.width = `${clamp(message.tab)}%`;
    els.micFill.style.width = `${message.mic === null ? 0 : clamp(message.mic)}%`;
  },
});

(async () => {
  const res = await sendMessage({ type: MessageType.GET_STATE });
  if (res && res.ok && res.data && res.data.state) {
    render(res.data);
  } else {
    selfClose();
  }
})();
