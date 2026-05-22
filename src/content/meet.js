// Content script for https://meet.google.com/*. Speaker detection only;
// recording lives in the offscreen document.
//
// Meet's DOM rotates often, so we lean on a few heuristic selectors and
// the polling fallback rather than one brittle class.

import {
  MessageType,
  StorageKey,
  SPEAKER_TIMELINE_STRATEGY,
  SpeakerTimelineStrategy,
} from '../constants.js';
import { startCaptionSpeakerObserver } from '../lib/caption-speaker-observer.js';
import { startCaptionPolicy } from '../lib/caption-policy.js';
import { startSpeakerDetector } from '../lib/speaker-detector.js';
import { createMeetSpeakerProbe } from '../lib/dom-speaker-probes.js';
import { startMicStateObserver } from '../lib/mic-state-observer.js';
import { createRecordingBanner } from '../lib/recording-banner.js';
import { onMessage, sendMessage } from '../lib/messaging.js';

// Three independent lifecycle inputs drive the detector.
// ``recordingActive`` — extension is recording (RECORDING_LIFECYCLE).
// ``bridgeActive``    — desktop bridge is paired (BRIDGE_LIFECYCLE).
// ``transcribeActive``— live transcription is running in this tab
//                       (TRANSCRIBE_LIFECYCLE). The overlay needs
//                       SPEAKER_CHANGE events to map provider numeric
//                       speakers (Speaker 0/1/2…) to real participant
//                       names from the meeting UI; without this, Mode
//                       2 transcripts show generic labels and the user
//                       can't tell who said what.
// The detector runs whenever ANY of the three is on.
let recordingActive = false;
let bridgeActive = false;
let transcribeActive = false;
// SW-authoritative wall-clock anchor (Date.now() from RECORDING_STARTED in
// the offscreen doc). For bridge-only mode there's no recording, so t0
// is just Date.now() at the moment the bridge paired — used only for the
// optional ``start_time``/``end_time`` debug fields. The desktop bridge
// keys correlation on ``wall_clock_ms`` (sent per event), not on this.
let t0 = null;
// R4 minor — monotonic counterpart of ``t0``, captured at the same
// instant. Used by ``getElapsedSeconds()`` so the elapsed-clock is
// drift-free under NTP slews, system clock jumps, or daylight-
// savings transitions mid-meeting. ``Date.now()``-based math would
// momentarily report a negative elapsed (or jump forward by an
// hour) on those events; ``performance.now()`` is monotonic by
// spec and immune. Falls back to Date.now() math when null
// (defence-in-depth: an older platform without performance.now
// wouldn't load this build, but the guard costs nothing).
let t0Perf = null;
// Pause-aware clock. While the user has paused the recording the
// banner's elapsed time must FREEZE (and continue from the frozen
// value on resume), mirroring the toolbar popup. ``pausedSincePerf``
// is the perf-now at the current pause (null when running);
// ``accumulatedPausedMs`` is total prior paused perf-time this
// session. Pause math is in the SAME domain as ``t0Perf`` so the
// subtraction in ``getElapsedSeconds`` is consistent.
let pausedSincePerf = null;
let accumulatedPausedMs = 0;
// Guard flag mirroring the caption observer handle (the lifecycle
// handlers below test ``detector`` to avoid re-starting).
let detector = null;
let captionObs = null;
// Owns the hide/unhide decision (see lib/caption-policy.js). Replaces
// the old unconditional hide so a user who wants to SEE captions is
// not trampled.
let captionPolicy = null;

// Push the user's explicit "Show / Hide captions" choice (set from
// the popup, stored under StorageKey.CAPTION_SHOW) into the active
// policy. ``true`` → visible, ``false`` → hidden, unset → null
// (auto-detect). Best-effort; storage may be briefly unavailable.
function applyCaptionPref() {
  try {
    chrome.storage?.local?.get?.(StorageKey.CAPTION_SHOW).then((g) => {
      if (!captionPolicy) return;
      const v = g ? g[StorageKey.CAPTION_SHOW] : undefined;
      captionPolicy.setUserVisible(typeof v === 'boolean' ? v : null);
    }).catch(() => {});
  } catch { /* storage unavailable */ }
}
// Live updates while recording: the popup toggle writes
// CAPTION_SHOW; reflect it immediately without a restart.
try {
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== 'local' || !captionPolicy) return;
    const c = changes[StorageKey.CAPTION_SHOW];
    if (!c) return;
    captionPolicy.setUserVisible(
      typeof c.newValue === 'boolean' ? c.newValue : null,
    );
  });
} catch { /* onChanged unavailable in this context */ }
// Test-only (gated by chrome.storage ``mm_e2e_caption_probe``): mirror
// the caption-policy's live decisions onto DOM data-attributes so an
// e2e harness can read them across JS worlds. Inert in production.
let e2eCap = false;
let capProbeTimer = null;
const capLog = [];
// Watches the in-meeting mic toggle while recording so the recorder
// honours the user's Meet mute (the extension's mic is a separate
// capture, independent of Meet's mute button).
let micObs = null;
// Once the "you left the call" UI appears, every subsequent DOM mutation
// re-matches the regex. Latch on first match per session so we send one
// MEETING_ENDED instead of dozens. Reset when a new lifecycle starts.
let meetingEndedFired = false;

function isActive() {
  return recordingActive || bridgeActive || transcribeActive;
}

function getElapsedSeconds() {
  if (t0 === null) return 0;
  // Prefer the monotonic perf-now path so a wall-clock jump
  // mid-meeting (NTP slew, DST, manual clock change) doesn't
  // momentarily report a negative elapsed or skip forward an hour.
  // Falls back to wall-clock math if t0Perf wasn't captured (older
  // build that pre-dates this change).
  if (t0Perf !== null && typeof performance !== 'undefined') {
    const pausedNowPerf = pausedSincePerf !== null
      ? performance.now() - pausedSincePerf : 0;
    const msPerf = performance.now() - t0Perf
      - accumulatedPausedMs - pausedNowPerf;
    return Math.max(0, msPerf) / 1000;
  }
  // Fallback path — performance unavailable. ``pausedSincePerf`` is
  // null in this branch too (set/cleared in the same lifecycle
  // handlers below as ``t0Perf``), so we only need wall-clock math
  // for the non-paused case.
  const ms = Date.now() - t0 - accumulatedPausedMs;
  return Math.max(0, ms) / 1000;
}

// Hide the on-screen caption box WITHOUT removing it from the DOM.
// Google Meet live captions are per-client/local — turning them on in
// this tab never shows them to other participants; this only stops
// them rendering for the recording user. CSS visibility/position does
// NOT stop Meet writing caption text + speaker badges into the DOM,
// so the caption-scrape observer keeps working while nothing shows.
// Anchored on the stable accessibility surface (role=region +
// aria-label "captions") plus the ARIA live region the captions mount
// in; class fallbacks are belt-and-suspenders for layout variants.
const CAPTION_HIDE_CSS = `
  [role="region"][aria-label*="caption" i],
  [jsname="dsyhDe"], [jsname="YSxPC"], [jsname="tgaKEf"],
  .a4cQT, .nMcdL, .iOzk7, .TBMuR, .bh44bd, .VbkSUe, .z38b6 {
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
  } catch { /* best-effort — worst case captions are briefly visible */ }
}
function unhideCaptionsUI() {
  try { captionHideStyleEl?.remove(); } catch { /* noop */ }
  captionHideStyleEl = null;
}

// --- Caption auto-enable (no-flicker; never uses the toggling Shift+C
// shortcut — see the long-form rationale that previously lived here:
// the shortcut TOGGLES so retries turned captions back OFF, and
// transient ``.NWpY1d`` made detection flip; both fixed by a sticky
// latch + only ever clicking the one-directional "Turn on" button).
let meetCaptionTries = 0;
let meetCaptionTimer = null;
let meetCaptionsEverOn = false;

function meetTurnOnBtn() {
  return document.querySelector('button[aria-label*="Turn on captions" i]');
}

function meetCaptionsOn() {
  if (meetCaptionsEverOn) return true;
  const offBtn = document.querySelector('button[aria-label*="Turn off captions" i]');
  const region = document.querySelector('[role="region"][aria-label*="caption" i]');
  const badge = document.querySelector('.NWpY1d, .xoMHSc');
  if (offBtn || region || badge) { meetCaptionsEverOn = true; return true; }
  return false;
}

// NON-latched live read for the caption-ownership policy. Unlike
// ``meetCaptionsOn`` (sticky so the enable-retry loop stops), this
// must reflect the CURRENT state every tick so the policy can see the
// user toggle captions off mid-meeting (case 4). On = a "Turn off
// captions" control, the live caption region, or the speaker badge is
// present; off = only the "Turn on captions" affordance is present.
function meetCaptionsCurrentlyOn() {
  try {
    if (document.querySelector('button[aria-label*="Turn off captions" i]')) {
      return true;
    }
    if (document.querySelector('[role="region"][aria-label*="caption" i]')) {
      return true;
    }
    if (document.querySelector('.NWpY1d, .xoMHSc')) return true;
    return false;
  } catch {
    return false;
  }
}

function enableMeetCaptions() {
  const step = () => {
    try {
      if (meetCaptionsOn()) return true;
      const btn = meetTurnOnBtn();
      if (btn) btn.click();
    } catch { /* best-effort */ }
    return false;
  };
  if (step()) return;
  meetCaptionTries = 0;
  if (meetCaptionTimer) clearInterval(meetCaptionTimer);
  meetCaptionTimer = setInterval(() => {
    if (step() || ++meetCaptionTries > 3) {
      clearInterval(meetCaptionTimer);
      meetCaptionTimer = null;
    }
  }, 5000);
}

// Turn captions OFF. Used ONLY at stop (caption-policy restore): if
// the extension turned captions on purely to scrape the speaker
// timeline, we must put the meeting back the way the user had it
// (off) rather than leaving the box up after recording ends. Safe to
// click the toggle here — the session is over, so the mid-session
// "toggle flicker" rationale that bans this during a session no
// longer applies. Also cancels any pending enable-retry so it can't
// re-enable after we turn it off.
function disableMeetCaptions() {
  try {
    if (meetCaptionTimer) {
      clearInterval(meetCaptionTimer);
      meetCaptionTimer = null;
    }
    meetCaptionsEverOn = false;
    const off = document.querySelector(
      'button[aria-label*="Turn off captions" i]',
    );
    if (off) off.click();
  } catch { /* best-effort — worst case the box lingers */ }
}

// Read the user's IN-MEETING mic state from Meet's toggle.
//   • true  → muted   • false → live   • null → can't tell
//
// 2026 Meet UI: the bottom-bar mic control is a button whose
// aria-label is "Turn off microphone (⌘ + d)" when LIVE and "Turn on
// microphone (⌘ + d)" when MUTED (older builds: "Mute/Unmute"); it
// ALSO carries data-is-muted. CRITICAL: data-is-muted is NOT unique
// to the mic — the CAMERA button and participant tiles carry it too,
// so the old ``querySelector('[data-is-muted]')`` read the camera /a
// tile and was wrong. Scope every signal to the MIC control: find it
// by an aria-label/tooltip that mentions "microphone", then read its
// verb + its own/ancestor data-is-muted. Verb is checked first
// (most stable, localised consistently) and "unmute" is tested
// before "mute" (substring trap).
function meetMicMuted() {
  try {
    const mic = document.querySelector(
      'button[aria-label*="microphone" i],'
      + '[role="button"][aria-label*="microphone" i],'
      + 'button[data-tooltip*="microphone" i],'
      + '[data-tooltip*="microphone" i][role="button"]',
    );
    if (!mic) return null;
    const label = (
      mic.getAttribute('aria-label')
      || mic.getAttribute('data-tooltip')
      || ''
    ).toLowerCase();
    if (label) {
      // "turn on microphone" / "unmute …" ⇒ currently MUTED.
      if (label.includes('turn on microphone') || label.includes('unmute')) {
        return true;
      }
      // "turn off microphone" / "mute …" ⇒ currently LIVE.
      if (label.includes('turn off microphone') || label.includes('mute')) {
        return false;
      }
    }
    // Fall back to data-is-muted, but ONLY from the mic control (or
    // its nearest ancestor that carries it) — never a global query.
    const dm = mic.matches('[data-is-muted]')
      ? mic
      : mic.closest('[data-is-muted]')
        || mic.querySelector('[data-is-muted]');
    const v = dm && dm.getAttribute('data-is-muted');
    if (v === 'true') return true;
    if (v === 'false') return false;
    const ap = mic.getAttribute('aria-pressed');
    // Meet mic button: aria-pressed="true" = active/live.
    if (ap === 'true') return false;
    if (ap === 'false') return true;
    return null;
  } catch {
    return null;
  }
}

function startMicObserver() {
  if (micObs) return;
  micObs = startMicStateObserver({
    detectMuted: meetMicMuted,
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

// Speaker timeline is captured by SCRAPING the meeting's own live
// captions (the only DOM method proven to work on the current Meet
// client — real speaker names, low brittleness, anchored on the
// stable ARIA caption surface). The caption box is hidden from view
// (hideCaptionsUI) so the user never sees it; the text still streams
// into the DOM so the observer reads it. Best-effort: any failure
// here must not block recording / transcription.
function startDetector() {
  const emitSpeakerChange = (event) => {
    sendMessage({
      type: MessageType.SPEAKER_CHANGE,
      wall_clock_ms: Date.now(),
      source: 'google_meet',
      ...event,
    }).catch(() => {});
  };
  const relayTelemetry = (name, payload) => {
    sendMessage({
      type: MessageType.TELEMETRY_EVENT,
      name,
      payload: { ...payload, source: 'google_meet' },
    }).catch(() => {});
    if (e2eCap) {
      capLog.push({ n: name, t: Date.now() });
      try { document.documentElement.setAttribute('data-mm-cap-log', JSON.stringify(capLog.slice(-30))); } catch { /* noop */ }
    }
  };
  // DOM strategy: detect the active speaker from participant-tile
  // speaking indicators instead of scraping captions. No caption
  // enable/hide is needed (that's the whole point), so we skip the
  // caption policy + observer entirely and drive the shared
  // startSpeakerDetector with the Meet tile probe. Emits the SAME
  // SPEAKER_CHANGE events as the caption path → overlay / name-map /
  // timeline upload are unchanged.
  if (SPEAKER_TIMELINE_STRATEGY === SpeakerTimelineStrategy.DOM) {
    try {
      detector = startSpeakerDetector({
        probe: createMeetSpeakerProbe(),
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
  // Caption visibility is now ownership-aware: the policy decides
  // hide vs keep-visible based on whether the USER had/turned
  // captions on. It also keeps captions flowing for the scraper
  // (re-enables if the user turns them off).
  try {
    captionPolicy = startCaptionPolicy({
      isOn: meetCaptionsCurrentlyOn,
      enable: enableMeetCaptions,
      disable: disableMeetCaptions,
      hideUI: hideCaptionsUI,
      unhideUI: unhideCaptionsUI,
      onTelemetry: relayTelemetry,
    });
    // Honour any prior popup "Show / Hide captions" choice.
    applyCaptionPref();
  } catch {
    // Policy failed to start — fall back to the old always-hide so
    // the scraper still works invisibly (never worse than before).
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
              JSON.stringify({ ...captionPolicy.state(), liveOn: meetCaptionsCurrentlyOn() }),
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
      enableCaptions: enableMeetCaptions,
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
    // ``restore: true`` → if the EXTENSION turned captions on (user
    // didn't want them), turn them back OFF so the box doesn't
    // linger after recording stops. If the USER owns captions, the
    // policy leaves them on. Must run BEFORE unhideCaptionsUI so the
    // "Turn off" click happens while our state is still coherent.
    if (e2eCap) {
      try {
        document.documentElement.setAttribute(
          'data-mm-cap-dispose',
          JSON.stringify({ preState: captionPolicy.state(), liveOn: meetCaptionsCurrentlyOn() }),
        );
      } catch { /* noop */ }
    }
    try { captionPolicy.dispose({ restore: true }); } catch { /* idempotent */ }
    captionPolicy = null;
  }
  if (capProbeTimer) { clearInterval(capProbeTimer); capProbeTimer = null; }
  // Strip our hide-CSS on stop. If the policy just turned captions
  // off (extension-owned) the box is gone anyway; if the user owns
  // them this leaves them visibly on, exactly as the user had it.
  unhideCaptionsUI();
  if (meetCaptionTimer) { clearInterval(meetCaptionTimer); meetCaptionTimer = null; }
  meetCaptionsEverOn = false;
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

// Tab blur marker — fires whenever the user switches away from the
// meeting tab. The SW writes a placeholder timeline event so the
// transcript can later annotate "user not focused" gaps.
document.addEventListener('visibilitychange', () => {
  // TAB_BLUR_MARKER is meaningful for the IDB timeline that the
  // extension uploads with its own recording. Skip it for bridge-only
  // mode — the desktop transcript doesn't consume blur markers, and
  // a bridge-only stream into bufferEvent would have no meetingId.
  if (!recordingActive) return;
  if (document.visibilityState === 'hidden') {
    sendMessage({
      type: MessageType.TAB_BLUR_MARKER,
      at: getElapsedSeconds(),
    }).catch(() => {});
  }
});

// Heuristic "meeting ended" signal. Two complementary detectors:
//
//   1. URL-based — when the user leaves a meeting Google Meet rewrites
//      the URL away from /<meeting-code> back to either / or /landing.
//      This is locale-independent and triggers reliably.
//
//   2. Text-based fallback (multi-locale) — Meet's "you left the call"
//      panel often appears WITHOUT a URL change (e.g. when the host ends
//      the call). The patterns below cover en, es, fr, de, pt, hi, ja
//      with Unicode-friendly matching. Conservative on purpose — false
//      positives mid-call could prematurely finalize a recording.
const MEET_END_PATTERNS = [
  /\byou left the (call|meeting)\b/i,                 // en
  /\breturn to home screen\b/i,                        // en
  /\brejoin\b/i,                                       // en (post-leave panel)
  /\bhas salido de la (llamada|reuni[oó]n)\b/i,        // es
  /\bvolver a la pantalla principal\b/i,               // es
  /\bvous avez quitt[eé] (l['’]appel|la r[eé]union)\b/i, // fr
  /\bdu hast (den anruf|das meeting) verlassen\b/i,    // de
  /\bvoc[eê] saiu da (chamada|reuni[aã]o)\b/i,          // pt
  /आपने मीटिंग छोड़ दी/,                                // hi
  /会議から退出しました/,                                // ja
];

function looksLikeMeetingEnded(text) {
  for (const re of MEET_END_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

function isOnMeetingRoomPath() {
  // Meet meeting URLs look like https://meet.google.com/abc-defg-hij — a
  // 3-4-3 lowercase pattern. /landing, /, or anything else means we're
  // not in a meeting room anymore.
  return /^\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}/.test(location.pathname);
}

let lastObservedPath = location.pathname;
const endObserver = new MutationObserver(() => {
  // MEETING_ENDED only matters for the extension's own recording —
  // the SW reacts by auto-finalizing the active recording. Don't fire
  // for bridge-only mode (the desktop app has its own stop control).
  if (!recordingActive || meetingEndedFired) return;

  // (1) URL transition — locale-independent.
  if (location.pathname !== lastObservedPath) {
    lastObservedPath = location.pathname;
    if (!isOnMeetingRoomPath()) {
      meetingEndedFired = true;
      sendMessage({
        type: MessageType.MEETING_ENDED,
        reason: 'meet_url_left_room',
      }).catch(() => {});
      return;
    }
  }

  // (2) Text panel — multi-locale.
  const text = document.body.innerText || '';
  if (looksLikeMeetingEnded(text)) {
    meetingEndedFired = true;
    sendMessage({
      type: MessageType.MEETING_ENDED,
      reason: 'meet_ui_left_call',
    }).catch(() => {});
  }
});
endObserver.observe(document.body, { childList: true, subtree: true });

onMessage({
  [MessageType.RECORDING_LIFECYCLE]: (message) => {
    if (message.phase === 'started') {
      t0 = typeof message.t0 === 'number' ? message.t0 : Date.now();
      t0Perf = typeof performance !== 'undefined' ? performance.now() : null;
      pausedSincePerf = null;
      accumulatedPausedMs = 0;
      recordingActive = true;
      meetingEndedFired = false;
      if (!detector) startDetector();
      // Honour the user's Meet mic mute for the duration of the
      // recording (separate from the extension's own mic capture).
      startMicObserver();
      banner.show();
      // (Mic permission is handled by the service worker via a
      // top-level permission window before the offscreen starts —
      // an iframe here is blocked by Meet/Teams' Permissions-Policy.)
    } else if (message.phase === 'paused') {
      // Freeze the on-page banner clock while the user has paused.
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
      // The mic observer is shared with live-transcribe (self/both
      // also honour the in-meeting mute). Only stop it if transcribe
      // isn't still using it.
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
    // Bridge lifecycle is independent of recording lifecycle. Detector
    // starts on first 'started' from either source, stops only when
    // BOTH are 'stopped'. We don't show the recording banner here —
    // the bridge is not a recording.
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
    // Live-transcription lifecycle drives the same detector — the
    // overlay needs SPEAKER_CHANGE events to map provider speaker
    // labels (Speaker 0/1/2…) to real participant names from the
    // meeting tiles. ``paused``/``resumed`` are pass-throughs that
    // don't affect detector activation; the overlay handles its own
    // visual dimming.
    if (message.phase === 'started') {
      if (t0 === null) {
        t0 = typeof message.t0 === 'number' ? message.t0 : Date.now();
        t0Perf = typeof performance !== 'undefined' ? performance.now() : null;
      }
      transcribeActive = true;
      if (!detector) startDetector();
      // Honour the in-meeting mic mute during live transcription too
      // (self/both capture the user's mic). Shared, idempotent — the
      // recording path may already have started it.
      startMicObserver();
      // (Mic permission for self/both modes is ensured by the SW
      // before the offscreen starts — see lib/mic-permission.js.)
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
