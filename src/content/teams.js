// Content script for https://teams.microsoft.com/* and the consumer
// client https://teams.live.com/*. Mirror of meet.js with
// Teams-specific selectors. Speaker detection only.

import {
  MessageType,
  StorageKey,
  SPEAKER_TIMELINE_STRATEGY,
  SpeakerTimelineStrategy,
} from '../constants.js';
import { startCaptionSpeakerObserver } from '../lib/caption-speaker-observer.js';
import { startCaptionPolicy } from '../lib/caption-policy.js';
import { startSpeakerDetector } from '../lib/speaker-detector.js';
import { createTeamsSpeakerProbe } from '../lib/dom-speaker-probes.js';
import { startMicStateObserver } from '../lib/mic-state-observer.js';
import { createRecordingBanner } from '../lib/recording-banner.js';
import { onMessage, sendMessage } from '../lib/messaging.js';

// See meet.js for the rationale on the three independent lifecycle inputs.
let recordingActive = false;
let bridgeActive = false;
let transcribeActive = false;
// SW-authoritative wall-clock anchor — see meet.js for rationale.
let t0 = null;
// R4 minor — monotonic counterpart, see meet.js getElapsedSeconds()
// docstring for the rationale (wall-clock jumps don't perturb the
// elapsed display when this is captured alongside ``t0``).
let t0Perf = null;
// Pause-aware clock in the perf-now domain — see meet.js for the
// full rationale (banner freezes while the user has paused,
// resumes from the frozen value).
let pausedSincePerf = null;
let accumulatedPausedMs = 0;
// Guard flag mirroring the caption observer handle.
let detector = null;
let captionObs = null;
// Ownership-aware caption visibility (see lib/caption-policy.js).
let captionPolicy = null;

// Push the popup's explicit "Show / Hide captions" choice
// (StorageKey.CAPTION_SHOW) into the active policy. See meet.js for
// the rationale; identical behaviour for Teams.
function applyCaptionPref() {
  try {
    chrome.storage?.local?.get?.(StorageKey.CAPTION_SHOW).then((g) => {
      if (!captionPolicy) return;
      const v = g ? g[StorageKey.CAPTION_SHOW] : undefined;
      captionPolicy.setUserVisible(typeof v === 'boolean' ? v : null);
    }).catch(() => {});
  } catch { /* storage unavailable */ }
}
try {
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== 'local' || !captionPolicy) return;
    const c = changes[StorageKey.CAPTION_SHOW];
    if (!c) return;
    captionPolicy.setUserVisible(
      typeof c.newValue === 'boolean' ? c.newValue : null,
    );
  });
} catch { /* onChanged unavailable */ }
// Test-only (gated by chrome.storage ``mm_e2e_caption_probe``): mirror
// the caption-policy's live decisions onto DOM data-attributes so an
// e2e harness can read them across JS worlds. Inert in production.
let e2eCap = false;
let capProbeTimer = null;
const capLog = [];
// In-meeting mic-mute observer (active only while recording).
let micObs = null;
// Latch — see meet.js for rationale.
let meetingEndedFired = false;

function isActive() {
  return recordingActive || bridgeActive || transcribeActive;
}

function getElapsedSeconds() {
  if (t0 === null) return 0;
  // Prefer monotonic perf-now to be immune to wall-clock jumps.
  if (t0Perf !== null && typeof performance !== 'undefined') {
    const pausedNowPerf = pausedSincePerf !== null
      ? performance.now() - pausedSincePerf : 0;
    const msPerf = performance.now() - t0Perf
      - accumulatedPausedMs - pausedNowPerf;
    return Math.max(0, msPerf) / 1000;
  }
  // Fallback path — performance unavailable. ``pausedSincePerf`` is
  // null here too (paired with t0Perf in lifecycle handlers below).
  const ms = Date.now() - t0 - accumulatedPausedMs;
  return Math.max(0, ms) / 1000;
}

// Hide the on-screen caption box WITHOUT removing it from the DOM.
// Teams live captions are per-client/local — they never show to other
// participants; this only stops them rendering for the recording
// user. CSS does NOT stop Teams writing caption text/author cells
// into the DOM, so the scrape observer keeps working while nothing
// shows. Anchored on the stable closed-caption data-tids.
const CAPTION_HIDE_CSS = `
  [data-tid='closed-caption-v2-window-wrapper'],
  [data-tid='closed-captions-renderer'],
  [data-tid*='closed-caption' i],
  [data-tid='closed-caption-message'],
  [data-tid='closed-caption-chat-message'] {
    opacity: 0 !important;
    pointer-events: none !important;
    position: fixed !important;
    left: -100000px !important;
    top: -100000px !important;
    width: 1px !important;
    height: 1px !important;
    max-height: 1px !important;
    overflow: hidden !important;
    z-index: -2147483647 !important;
  }`;

let captionHideStyleEl = null;
function hideCaptionsUI() {
  if (captionHideStyleEl && document.documentElement.contains(captionHideStyleEl)) {
    return;
  }
  try {
    const s = document.createElement('style');
    s.id = 'mm-caption-hide';
    s.textContent = CAPTION_HIDE_CSS;
    (document.head || document.documentElement).appendChild(s);
    captionHideStyleEl = s;
  } catch { /* best-effort */ }
}
function unhideCaptionsUI() {
  try { captionHideStyleEl?.remove(); } catch { /* noop */ }
  captionHideStyleEl = null;
}

// Whether Teams captions are actually rendering (sticky-ish; the
// caption window / an author cell / a "Hide live captions" toggle).
function teamsCaptionsOn() {
  return !!(
    document.querySelector(
      "[data-tid='closed-caption-v2-window-wrapper'],"
      + "[data-tid='closed-captions-renderer'],"
      + '[data-tid*="closed-caption" i]',
    )
    || document.querySelector('.fui-ChatMessageCompact [data-tid="author"]')
    || document.querySelector(
      'button[aria-label*="Hide live captions" i],'
      + 'button[aria-label*="Turn off live captions" i]',
    )
  );
}

// Best-effort Teams live-captions enabler: direct toggle (consumer /
// new Teams) then the classic enterprise menu walk. Retry-limited.
let teamsCaptionTries = 0;
let teamsCaptionTimer = null;
function enableTeamsCaptions() {
  const step = () => {
    try {
      if (teamsCaptionsOn()) return true;
      const direct = document.querySelector(
        'button[aria-label*="Show live captions" i],'
        + 'button[aria-label*="Turn on live captions" i],'
        + 'button[data-tid*="closed-caption" i]',
      );
      if (direct) direct.click();
      const moreBtn = document.querySelector(
        "button[data-tid='more-button'],"
        + "button[id='callingButtons-showMoreBtn']",
      );
      if (moreBtn && moreBtn.getAttribute('aria-expanded') !== 'true') {
        moreBtn.click();
      }
      const langBtn = document.querySelector(
        "div[id='LanguageSpeechMenuControl-id'],"
        + '[data-tid*="language-speech" i]',
      );
      if (langBtn) langBtn.click();
      const ccBtn = document.querySelector(
        "div[id='closed-captions-button'],"
        + '[data-tid*="closed-caption" i][role="menuitem"]',
      );
      if (ccBtn) ccBtn.click();
    } catch { /* best-effort */ }
    return false;
  };
  if (step()) return;
  teamsCaptionTries = 0;
  if (teamsCaptionTimer) clearInterval(teamsCaptionTimer);
  teamsCaptionTimer = setInterval(() => {
    if (step() || ++teamsCaptionTries > 4) {
      clearInterval(teamsCaptionTimer);
      teamsCaptionTimer = null;
    }
  }, 3000);
}

// Turn captions OFF — used ONLY at stop (caption-policy restore) so a
// box the EXTENSION opened for scraping doesn't linger after the
// recording ends. Cancels the enable-retry first so it can't undo
// us. Safe to click the toggle here (session over → no mid-session
// flicker concern).
function disableTeamsCaptions() {
  try {
    if (teamsCaptionTimer) {
      clearInterval(teamsCaptionTimer);
      teamsCaptionTimer = null;
    }
    const off = document.querySelector(
      'button[aria-label*="Hide live captions" i],'
      + 'button[aria-label*="Turn off live captions" i]',
    );
    if (off) off.click();
  } catch { /* best-effort — worst case the box lingers */ }
}

// Read the user's IN-MEETING mic state from Teams' mic toggle.
//   • true → muted   • false → live   • null → can't tell
//
// New Teams (2.x / v2 web, 2026) toolbar: the mic control is found
// via id=microphone-button or data-tid (toggle-mute / microphone-
// button / *mic*). Its aria-label/title is the ACTION it offers —
// "Unmute" while MUTED, "Mute" while LIVE. The verb is the reliable
// signal and is checked FIRST; ``aria-pressed``/``aria-checked``
// semantics vary across Teams builds so they're only a last-resort
// hint. "unmute" is tested before "mute" (substring trap).
function teamsMicMuted() {
  try {
    // Order matters: the ACTUAL mute toggle on the 2026 teams.live.com
    // client is title-only (``<button title="Mute mic">`` /
    // ``"Unmute mic"``) with NO id/data-tid/aria-label, so match it
    // FIRST. The broad ``[data-tid*="microphone" i]`` otherwise latches
    // onto ``data-tid="selected-microphone-display"`` — the device
    // PICKER flyout, which carries no mute verb — so it's explicitly
    // excluded (and the device "open microphone options" button via the
    // aria-label ``options`` guard).
    const t = document.querySelector(
      "button[title*='Mute' i]:not([title*='Unmute' i]),"
      + "button[title*='Unmute' i],"
      + "#microphone-button,[data-tid='toggle-mute'],"
      + "[data-tid='microphone-button'],"
      + "[data-tid*='mute' i]:not([data-tid='selected-microphone-display']),"
      + "[data-tid*='microphone' i]:not([data-tid='selected-microphone-display']),"
      + "button[aria-label*='microphone' i]:not([aria-label*='options' i])",
    );
    if (t) {
      const label = (
        t.getAttribute('aria-label') || t.getAttribute('title') || ''
      ).toLowerCase();
      if (label.includes('unmute')) return true;
      if (label.includes('mute')) return false;
      const ap = t.getAttribute('aria-pressed')
        || t.getAttribute('aria-checked');
      // Teams mute toggle: pressed/checked = mute engaged = muted.
      if (ap === 'true') return true;
      if (ap === 'false') return false;
    }
    // Standalone affordances (some builds render the verb only on a
    // separate button, or surface a "you're muted" banner).
    if (document.querySelector(
      'button[aria-label*="Unmute" i],button[title*="Unmute" i]',
    )) {
      return true;
    }
    if (document.querySelector(
      '[aria-label*="your mic is muted" i],'
      + '[aria-label*="your microphone is muted" i],'
      + '[aria-label*="microphone is muted" i]',
    )) {
      return true;
    }
    if (document.querySelector(
      'button[aria-label*="Mute" i]:not([aria-label*="Unmute" i]),'
      + 'button[title*="Mute" i]:not([title*="Unmute" i])',
    )) {
      return false;
    }
    return null;
  } catch {
    return null;
  }
}

function startMicObserver() {
  if (micObs) return;
  micObs = startMicStateObserver({
    detectMuted: teamsMicMuted,
    onChange: (muted) => {
      sendMessage({ type: MessageType.MIC_MUTE_STATE, muted }).catch(() => {});
    },
  });
}

function stopMicObserver() {
  if (micObs) {
    try { micObs.dispose(); } catch { /* idempotent */ }
    micObs = null;
  }
}

// Speaker timeline is captured by SCRAPING Teams' own live captions
// (the DOM method proven to work on the live client — real author
// names via [data-tid="author"], low brittleness). The caption box
// is hidden from view (hideCaptionsUI) so the user never sees it;
// the text still streams into the DOM for the observer. Best-effort.
function startDetector() {
  const emitSpeakerChange = (event) => {
    sendMessage({
      type: MessageType.SPEAKER_CHANGE,
      wall_clock_ms: Date.now(),
      source: 'ms_teams',
      ...event,
    }).catch(() => {});
  };
  const relayTelemetry = (name, payload) => {
    sendMessage({
      type: MessageType.TELEMETRY_EVENT,
      name,
      payload: { ...payload, source: 'ms_teams' },
    }).catch(() => {});
    if (e2eCap) {
      capLog.push({ n: name, t: Date.now() });
      try { document.documentElement.setAttribute('data-mm-cap-log', JSON.stringify(capLog.slice(-30))); } catch { /* noop */ }
    }
  };
  // DOM strategy: detect the active speaker from the voice-level tile
  // indicators (vdi-frame-occlusion) instead of scraping captions.
  // createTeamsSpeakerProbe picks the Personal (teams.live.com) or
  // Business (teams.microsoft.com) probe by hostname; both emit the
  // SAME SPEAKER_CHANGE events as the caption path. No caption
  // enable/hide needed, so skip the caption policy + observer.
  if (SPEAKER_TIMELINE_STRATEGY === SpeakerTimelineStrategy.DOM) {
    try {
      detector = startSpeakerDetector({
        probe: createTeamsSpeakerProbe(),
        getElapsedSeconds,
        isActive,
        onChange: emitSpeakerChange,
        onTelemetry: relayTelemetry,
      });
    } catch {
      detector = null;
    }
    return;
  }
  // Ownership-aware: keep captions visible if the user wants them;
  // otherwise enable + hide for invisible scraping (case 1–4).
  try {
    captionPolicy = startCaptionPolicy({
      isOn: teamsCaptionsOn,
      enable: enableTeamsCaptions,
      disable: disableTeamsCaptions,
      hideUI: hideCaptionsUI,
      unhideUI: unhideCaptionsUI,
      onTelemetry: relayTelemetry,
    });
    applyCaptionPref(); // honour prior popup Show/Hide choice
  } catch {
    captionPolicy = null;
    hideCaptionsUI();
  }
  // Test-only probe wiring (gated by storage flag).
  try {
    chrome.storage?.local?.get?.('mm_e2e_caption_probe').then((g) => {
      if (!g || g.mm_e2e_caption_probe !== true) return;
      e2eCap = true;
      if (capProbeTimer) clearInterval(capProbeTimer);
      capProbeTimer = setInterval(() => {
        try {
          if (captionPolicy) {
            document.documentElement.setAttribute(
              'data-mm-cap-state',
              JSON.stringify({ ...captionPolicy.state(), liveOn: teamsCaptionsOn() }),
            );
          }
        } catch { /* noop */ }
      }, 700);
    }).catch(() => {});
  } catch { /* storage unavailable — probe stays off */ }
  try {
    captionObs = startCaptionSpeakerObserver({
      getElapsedSeconds,
      isActive,
      onChange: emitSpeakerChange,
      onTelemetry: relayTelemetry,
      badgeSelectors:
        '[data-tid="author"], [data-tid*="author" i],'
        + '[class*="author" i], [data-self-name], [data-speaker-name]',
      regionSelectors:
        "[data-tid='closed-caption-v2-window-wrapper'],"
        + "[data-tid='closed-captions-renderer'],"
        + '[data-tid*="closed-caption" i], [data-tid*="caption" i],'
        + '[aria-live]',
      blockSelector:
        '.fui-ChatMessageCompact, [data-tid="closed-caption-message"],'
        + '[data-tid="closed-caption-chat-message"]',
      textSelector: '[data-tid="closed-caption-text"]',
      enableCaptions: enableTeamsCaptions,
    });
    detector = captionObs;
  } catch {
    captionObs = null;
    detector = null;
  }
}

function stopDetector() {
  stopMicObserver();
  if (captionPolicy) {
    if (e2eCap) {
      try {
        document.documentElement.setAttribute(
          'data-mm-cap-dispose',
          JSON.stringify({ preState: captionPolicy.state(), liveOn: teamsCaptionsOn() }),
        );
      } catch { /* noop */ }
    }
    // restore: true → extension-owned captions get turned OFF on stop
    // so the box doesn't linger; user-owned captions are left on.
    try { captionPolicy.dispose({ restore: true }); } catch { /* idempotent */ }
    captionPolicy = null;
  }
  if (capProbeTimer) { clearInterval(capProbeTimer); capProbeTimer = null; }
  unhideCaptionsUI();
  if (teamsCaptionTimer) { clearInterval(teamsCaptionTimer); teamsCaptionTimer = null; }
  if (captionObs) {
    try { captionObs.flush(); } catch { /* best-effort */ }
    try { captionObs.dispose(); } catch { /* idempotent */ }
    captionObs = null;
  } else if (detector) {
    // DOM-strategy tile detector — same flush/dispose contract as the
    // caption observer (flush emits the open turn, dispose tears down
    // the MutationObserver + poll/debounce timers).
    try { detector.flush(); } catch { /* best-effort */ }
    try { detector.dispose(); } catch { /* idempotent */ }
  }
  detector = null;
}

const banner = createRecordingBanner(getElapsedSeconds);

document.addEventListener('visibilitychange', () => {
  // TAB_BLUR_MARKER is meaningful for the extension's own IDB
  // timeline; skip in bridge-only mode. See meet.js for rationale.
  if (!recordingActive) return;
  if (document.visibilityState === 'hidden') {
    sendMessage({
      type: MessageType.TAB_BLUR_MARKER,
      at: getElapsedSeconds(),
    }).catch(() => {});
  }
});

// Multi-locale "meeting ended" detection. Same approach as Meet — be
// conservative; false positives prematurely finalize recordings.
const TEAMS_END_PATTERNS = [
  /\byou (left|disconnected from) the meeting\b/i,       // en
  /\bthis meeting has ended\b/i,                          // en
  /\brejoin\b/i,                                          // en (post-leave)
  /\bhas (salido|abandonado) de la reuni[oó]n\b/i,        // es
  /\bla reuni[oó]n ha (terminado|finalizado)\b/i,         // es
  /\bvous avez quitt[eé] la r[eé]union\b/i,               // fr
  /\bla r[eé]union (est|s['’]est) termin[eé]e\b/i,         // fr
  /\bdu hast (die besprechung|das meeting) verlassen\b/i, // de
  /\bdie besprechung wurde beendet\b/i,                   // de
  /\bvoc[eê] saiu da reuni[aã]o\b/i,                       // pt
  /\bsa[ií]r da chamada\b/i,                               // pt
  /会議を退出しました/,                                      // ja
];

function looksLikeMeetingEnded(text) {
  for (const re of TEAMS_END_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// Teams in-meeting URL shapes (mirrors the popup's _TEAMS_ROOM_RE):
// v1 routes the meeting into the HASH (``/_#/l/meetup-join/…``), v2 in
// the PATH (``/l/meetup-join/…``), plus the Calling pre-join/calling
// surfaces. Match the full href so the hash-routed v1 client is
// covered. Leaving ALL of these means the user left the call.
const _TEAMS_ROOM_RE =
  /https:\/\/(?:teams\.microsoft\.com|teams\.live\.com)\/(?:_#\/)?(?:l\/meetup-join\/|meetup-join\/|pre-join-calling\/|calling\/)/;

function isInTeamsMeetingRoom() {
  return _TEAMS_ROOM_RE.test(location.href);
}

// Parity with meet.js's URL-transition detector — Teams' text-only
// detector misses non-English end panels, so a locale-independent URL
// signal is the reliable path. Conservative: only fire on a genuine
// in-room → not-in-room transition (so intra-meeting URL churn / side
// panels never prematurely finalize). Recording-gated + latched.
let lastTeamsInRoom = isInTeamsMeetingRoom();
function checkTeamsUrlEnded() {
  if (!recordingActive || meetingEndedFired) return;
  const nowInRoom = isInTeamsMeetingRoom();
  if (lastTeamsInRoom && !nowInRoom) {
    lastTeamsInRoom = nowInRoom;
    meetingEndedFired = true;
    sendMessage({
      type: MessageType.MEETING_ENDED,
      reason: 'teams_url_left_room',
    }).catch(() => {});
    return;
  }
  lastTeamsInRoom = nowInRoom;
}

const endObserver = new MutationObserver(() => {
  // Only fire for the extension's own recording — see meet.js.
  if (!recordingActive || meetingEndedFired) return;
  // (1) URL transition — locale-independent (Teams is an SPA, so a DOM
  // mutation usually accompanies the route change; popstate/hashchange
  // below cover the cases where it doesn't).
  checkTeamsUrlEnded();
  if (meetingEndedFired) return;
  // (2) Text panel — multi-locale.
  const text = document.body.innerText || '';
  if (looksLikeMeetingEnded(text)) {
    meetingEndedFired = true;
    sendMessage({
      type: MessageType.MEETING_ENDED,
      reason: 'teams_ui_left_call',
    }).catch(() => {});
  }
});
endObserver.observe(document.body, { childList: true, subtree: true });
// SPA route changes that don't necessarily mutate <body> at the
// observed level still flip the URL — catch them directly.
window.addEventListener('popstate', checkTeamsUrlEnded);
window.addEventListener('hashchange', checkTeamsUrlEnded);

onMessage({
  [MessageType.RECORDING_LIFECYCLE]: (message) => {
    if (message.phase === 'started') {
      t0 = typeof message.t0 === 'number' ? message.t0 : Date.now();
      t0Perf = typeof performance !== 'undefined' ? performance.now() : null;
      pausedSincePerf = null;
      accumulatedPausedMs = 0;
      recordingActive = true;
      meetingEndedFired = false;
      // Re-baseline the URL-ended detector to the current room so a
      // fresh recording's first transition is measured from "in room".
      lastTeamsInRoom = isInTeamsMeetingRoom();
      if (!detector) startDetector();
      startMicObserver();
      banner.show();
      // (Mic permission handled by the SW via a top-level window.)
    } else if (message.phase === 'paused') {
      if (pausedSincePerf === null && typeof performance !== 'undefined') {
        pausedSincePerf = performance.now();
      }
      banner.refresh();
    } else if (message.phase === 'resumed') {
      if (pausedSincePerf !== null && typeof performance !== 'undefined') {
        accumulatedPausedMs += performance.now() - pausedSincePerf;
        pausedSincePerf = null;
      }
      banner.refresh();
    } else if (message.phase === 'stopped') {
      recordingActive = false;
      pausedSincePerf = null;
      accumulatedPausedMs = 0;
      // Shared with live-transcribe (self/both) — keep it running if
      // transcribe still needs it.
      if (!transcribeActive) stopMicObserver();
      banner.hide();
      if (!isActive()) {
        stopDetector();
        t0 = null;
        t0Perf = null;
      }
    }
  },
  [MessageType.BRIDGE_LIFECYCLE]: (message) => {
    // Independent of recording lifecycle — see meet.js for the detailed
    // shape rationale.
    if (message.phase === 'started') {
      if (t0 === null) {
        t0 = typeof message.t0 === 'number' ? message.t0 : Date.now();
        t0Perf = typeof performance !== 'undefined' ? performance.now() : null;
      }
      bridgeActive = true;
      if (!detector) startDetector();
    } else if (message.phase === 'stopped') {
      bridgeActive = false;
      if (!isActive()) {
        stopDetector();
        t0 = null;
        t0Perf = null;
      }
    }
  },
  [MessageType.TRANSCRIBE_LIFECYCLE]: (message) => {
    // Live-transcription lifecycle — same shape rationale as in
    // meet.js. Activates the detector so the overlay receives
    // SPEAKER_CHANGE events for numeric→name mapping.
    if (message.phase === 'started') {
      if (t0 === null) {
        t0 = typeof message.t0 === 'number' ? message.t0 : Date.now();
        t0Perf = typeof performance !== 'undefined' ? performance.now() : null;
      }
      transcribeActive = true;
      if (!detector) startDetector();
      // Honour the in-meeting mic mute during live transcription
      // (self/both capture the mic). Idempotent + shared with the
      // recording path.
      startMicObserver();
      // (Mic permission for self/both ensured by the SW.)
    } else if (message.phase === 'stopped') {
      transcribeActive = false;
      if (!recordingActive) stopMicObserver();
      if (!isActive()) {
        stopDetector();
        t0 = null;
        t0Perf = null;
      }
    }
  },
});
