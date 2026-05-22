// Shared constants and JSDoc typedefs used across background, offscreen,
// popup, options, and content scripts. Replaces what would be a types.ts
// in a TypeScript build — JSDoc keeps the same shapes documented for the
// editor without adding a compile step.

export const RecordingState = Object.freeze({
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  RECORDING: 'RECORDING',
  STOPPING: 'STOPPING',
  ERROR: 'ERROR',
  NEEDS_REAUTH: 'NEEDS_REAUTH',
});

export const Source = Object.freeze({
  GOOGLE_MEET: 'google_meet',
  MS_TEAMS: 'ms_teams',
});

// Speaker-timeline detection strategy. Two interchangeable content-
// script paths feed the IDENTICAL SPEAKER_CHANGE pipeline (same
// ``{speaker_name, start_time, end_time}`` events → same overlay,
// speaker-name-map, and timeline upload). Flip the single constant
// ``SPEAKER_TIMELINE_STRATEGY`` below to switch the whole extension.
//
//   CAPTION — scrape the meeting's own live-caption author badges
//             (lib/caption-speaker-observer.js). Most ACCURATE: real
//             participant names attributed by the meeting client
//             itself, anchored on a stable ARIA/data-tid surface. Cost:
//             requires live captions to be ON (the extension enables +
//             hides them) and degrades when a host blocks captions.
//   DOM     — watch participant-tile speaking indicators
//             (lib/dom-speaker-probes.js + the existing
//             lib/speaker-detector.js). No captions required — works in
//             caption-off meetings — at the cost of name-attribution
//             fidelity (names come from tile DOM, not caption labels)
//             and reliance on the platforms' obfuscated tile classes.
export const SpeakerTimelineStrategy = Object.freeze({
  CAPTION: 'caption',
  DOM: 'dom',
});

// THE single switch. Default CAPTION preserves the existing, most-
// accurate behaviour; set to ``SpeakerTimelineStrategy.DOM`` to use the
// DOM tile-indicator detection across Google Meet + Teams instead.
export const SPEAKER_TIMELINE_STRATEGY = SpeakerTimelineStrategy.CAPTION;

// Recording capture source (options-page setting).
//   TAB    — chrome.tabCapture: the meeting tab's audio + video. The
//            default; preserves all pre-existing behaviour and is the
//            only mode where DOM speaker-name detection is meaningful.
//   SCREEN — chrome.desktopCapture: a user-picked screen / window /
//            tab plus its system/tab audio. Delivers the spec's
//            "Screen sharing" + "System audio" capabilities. Chrome
//            only exposes system audio via the share picker's "Share
//            system/tab audio" checkbox (a shared *window* has none),
//            so audio here is best-effort by design.
export const CaptureSource = Object.freeze({
  TAB: 'tab',
  SCREEN: 'screen',
});

// Live-transcription feature enums. Mirror the backend's
// ``app.schemas.transcribe.ProviderId`` literal so the two stay in
// lockstep; adding a new provider means adding it both places.
export const TranscribeMode = Object.freeze({
  SELF: 'self',                 // user's own mic
  PARTICIPANTS: 'participants', // meeting-tab audio (multi-speaker)
  // Both at once: mic AND tab audio captured + transcribed in
  // parallel. Implemented entirely client-side as TWO independent
  // backend sessions (one ``self``, one ``participants``) so the
  // relay code stays unchanged; the extension owns the merge into
  // a unified timeline. Cost is 2× per-second-billed audio_seconds
  // and consumes 2 of the per-user concurrent-session slots.
  BOTH: 'both',
});

// When ``mode='both'``, the extension creates two backend sessions
// and tags each event with the substream role on the wire to the
// overlay so the unified-timeline renderer knows whether to label
// the speaker as "You" or to resolve via the participant name map.
// Single-mode sessions don't carry this field on the wire (legacy
// shape preserved); the renderer treats ``null`` as "infer from
// transcribe mode" so old paths keep working.
export const StreamRole = Object.freeze({
  MIC: 'mic',
  TAB: 'tab',
});

// Coarse language set the popup exposes. The backend picks the
// transcription provider server-side; if the configured provider
// doesn't support "auto" (e.g. Deepgram or AssemblyAI), the request
// fails with a 422 surfaced as an error message.
export const TranscribeLanguage = Object.freeze({
  AUTO: 'auto',
  EN: 'en',
  HI: 'hi',
  HI_IN: 'hi-IN',
});

// Lifecycle states the popup renders. Independent of RecordingState
// because live transcription is its own feature with its own state
// machine; mixing them would force every consumer to handle
// combinatorial states. Mutual exclusion with recording is enforced
// in the service worker, not at this enum.
//
// PAUSED is a hold state where the audio pipeline is still alive
// (AudioContext + WebSocket + worklet running) but PCM frames are
// being dropped at the offscreen boundary. Resume is instant — no
// new ``POST /sessions`` round-trip — at the cost of holding the
// provider WS open for the duration of the pause. The provider may
// time out an idle stream after ~10-30s; that surfaces as an ERROR
// transition rather than a clean PAUSED→ACTIVE on resume. v1 doesn't
// send silence keepalives; add them in v2 if real-world data shows
// providers dropping mid-pause.
export const TranscribeState = Object.freeze({
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  // The WS to the backend relay dropped mid-session. The offscreen
  // doc keeps the audio pipeline alive (MediaStream + AudioContext)
  // and walks a backoff schedule asking the SW for a fresh wsUrl.
  // PCM frames are dropped while we're in this state — perfect
  // history during a network glitch isn't worth growing memory
  // unboundedly. Transitions: ACTIVE→RECONNECTING (on close),
  // RECONNECTING→ACTIVE (on successful re-attach),
  // RECONNECTING→ERROR (on exhausting attempts), RECONNECTING→IDLE
  // (on user stop). See TRANSCRIBE_RECONNECT_BACKOFFS_MS below.
  RECONNECTING: 'RECONNECTING',
  STOPPING: 'STOPPING',
  ERROR: 'ERROR',
});

// Reconnect backoff in milliseconds, one entry per attempt. Total
// budget ≈ 18s before we give up — long enough to survive a Wi-Fi
// hop or a backend deploy, short enough that a sustained outage
// surfaces as ERROR rather than hanging the user. The offscreen doc
// drives the loop so the SW suspending mid-backoff doesn't lose the
// schedule.
export const TRANSCRIBE_RECONNECT_BACKOFFS_MS = Object.freeze(
  [1000, 2000, 5000, 10000],
);
export const TRANSCRIBE_RECONNECT_MAX_ATTEMPTS = TRANSCRIBE_RECONNECT_BACKOFFS_MS.length;
// A WS that connects then dies in under this many ms WITHOUT ever
// producing a transcript event is a broken endpoint (STT provider
// down / relay misconfigured), not a transient blip. Reconnecting
// just mints a FRESH backend session every attempt, and the backend
// caps concurrent live-transcribe sessions (3) with NO cancel API +
// a multi-hour stale-grace, so an immediate-fail reconnect storm
// leaks every slot and 429s ("transcribe_concurrency_cap") all
// future starts. Treat it as fatal: one start → one session → one
// clean error. Mirrors the desktop client's MIN_STABLE_STREAM_SECONDS
// (3.0s) — the proven-working reference implementation.
export const TRANSCRIBE_MIN_STABLE_MS = 3000;

// Defence-in-depth cap on the cumulative important-points list held in
// transcribe state. Backend memo says ~50 unique points per meeting
// typical, so a 500-entry cap is ~10× headroom — large enough to never
// truncate a real meeting, small enough to bound storage if a
// misbehaving extractor produced runaway dedup-miss output. FIFO
// eviction in the SW merger (newest kept).
export const IMPORTANT_POINTS_MAX = 500;

export const MessageType = Object.freeze({
  // popup -> background
  GET_STATE: 'GET_STATE',
  // popup -> background — begin web-assisted social login. Payload
  // {provider: 'google'|'microsoft'}. The SW runs the
  // chrome.identity.launchWebAuthFlow round-trip (it must outlive the
  // ephemeral popup), persists the returned Firebase tokens, and
  // bootstraps the backend user. Replies {ok, email} | {ok:false,
  // error, code}.
  START_SOCIAL_AUTH: 'START_SOCIAL_AUTH',
  START_RECORDING: 'START_RECORDING',
  STOP_RECORDING: 'STOP_RECORDING',
  // popup -> background — bring the detached recording-control window
  // back to the foreground (re-creating it if it was closed) so a
  // live recording is never orphaned even though the toolbar popup
  // resets to idle while it runs.
  FOCUS_CONTROL_WINDOW: 'FOCUS_CONTROL_WINDOW',
  FLUSH_TIMELINE: 'FLUSH_TIMELINE',
  // popup -> background — Phase B. User clicked "Report a problem".
  // SW gathers the session-replay ring + recent telemetry and ships
  // them as a single ``session_replay_dump`` telemetry event.
  REPORT_PROBLEM: 'REPORT_PROBLEM',

  // background -> popup
  STATE_UPDATE: 'STATE_UPDATE',
  // P5 — one-shot duration-cap warning. The SW fires this when the
  // ``warning_at_seconds_remaining`` threshold trips so the popup can
  // surface a "recording will auto-stop in X minutes" toast. The
  // ``capExceeded`` flag on STATE_UPDATE is the canonical signal
  // when the cap is actually reached; this message is purely an
  // intermediate heads-up.
  CAP_WARNING: 'CAP_WARNING',

  // background -> offscreen
  OFFSCREEN_START: 'OFFSCREEN_START',
  OFFSCREEN_STOP: 'OFFSCREEN_STOP',
  OFFSCREEN_PING: 'OFFSCREEN_PING',
  // SW → meeting-tab liveness probe: "is the transcribe overlay
  // content script present in this tab?" A missing reply means the
  // tab predates the current extension load (MV3 does NOT auto-inject
  // content scripts into already-open tabs on install/update), so the
  // SW programmatically (re)injects it before mounting the overlay.
  OVERLAY_PING: 'OVERLAY_PING',
  OFFSCREEN_PAUSE: 'OFFSCREEN_PAUSE',
  OFFSCREEN_RESUME: 'OFFSCREEN_RESUME',
  // bg -> offscreen: mirror of the in-meeting mic mute. Zeroes the
  // recorder's mic gain while muted (keeps the track alive so unmute
  // is instant), restores the configured gain on unmute.
  OFFSCREEN_MIC_MUTE: 'OFFSCREEN_MIC_MUTE',
  RETRY_MONITOR: 'RETRY_MONITOR',

  // offscreen -> background
  OFFSCREEN_READY: 'OFFSCREEN_READY',
  OFFSCREEN_HEARTBEAT: 'OFFSCREEN_HEARTBEAT',
  OFFSCREEN_ERROR: 'OFFSCREEN_ERROR',
  RECORDING_STARTED: 'RECORDING_STARTED',
  RECORDING_STOPPED: 'RECORDING_STOPPED',
  // offscreen -> background — edge-triggered "is the MediaRecorder
  // actually capturing media right now?" ({capturing: boolean}).
  // Fires on EVERY real recorder transition regardless of cause —
  // user pause, queue back-pressure, offline auto-pause, and the
  // AudioContext-rotation handoff gap. The SW translates each edge
  // into a RECORDING_LIFECYCLE paused/resumed broadcast to the
  // meeting tab so the content script's speaker-timeline clock
  // freezes for exactly the wall-clock span where no media is
  // recorded. This is what keeps the speaker timeline aligned with
  // the final mp4 (which likewise omits those spans). Distinct from
  // the SW-state pausedAt/accumulatedPausedMs UX fields, which keep
  // user-pause-only semantics for the popup/control timer.
  RECORDER_CAPTURE_STATE: 'RECORDER_CAPTURE_STATE',
  CHUNK_PERSISTED: 'CHUNK_PERSISTED',
  AUDIO_MONITOR_BLOCKED: 'AUDIO_MONITOR_BLOCKED',
  AUDIO_MONITOR_RESTORED: 'AUDIO_MONITOR_RESTORED',

  // content -> background
  SPEAKER_CHANGE: 'SPEAKER_CHANGE',
  // The user's IN-MEETING mic toggle (Meet/Teams mute button) — the
  // extension's recording mic is a SEPARATE getUserMedia capture, so
  // muting yourself in the meeting would otherwise still be recorded.
  // Content scripts emit this; the SW forwards it to the offscreen
  // recorder which zeroes the mic gain while muted.
  MIC_MUTE_STATE: 'MIC_MUTE_STATE',
  MEETING_ENDED: 'MEETING_ENDED',
  TAB_BLUR_MARKER: 'TAB_BLUR_MARKER',
  TELEMETRY_EVENT: 'TELEMETRY_EVENT',

  // background -> content
  RECORDING_LIFECYCLE: 'RECORDING_LIFECYCLE',
  // Bridge-only "detector active" lifecycle. Sent to a content script
  // when the optional desktop bridge has paired AND the script's tab
  // is the active meeting tab. The content script treats the union of
  // RECORDING_LIFECYCLE and BRIDGE_LIFECYCLE as "detector active", so
  // speaker detection runs whenever either consumer wants events.
  BRIDGE_LIFECYCLE: 'BRIDGE_LIFECYCLE',

  // options -> background — user saved a new bridge token / toggled
  // pairing. SW re-evaluates and reconnects (or disconnects).
  BRIDGE_CONFIG_CHANGED: 'BRIDGE_CONFIG_CHANGED',
  // options -> background — return the current bridge connection state
  // for the options page status badge.
  GET_BRIDGE_STATUS: 'GET_BRIDGE_STATUS',

  // popup -> background — user-initiated pause/resume of an active
  // recording. The recorder pauses on PAUSE; the same file continues
  // when RESUME is dispatched.
  USER_PAUSE: 'USER_PAUSE',
  USER_RESUME: 'USER_RESUME',

  // Live-transcription lifecycle.
  // popup -> background
  START_TRANSCRIBE: 'START_TRANSCRIBE',     // {mode, language, provider}
  STOP_TRANSCRIBE: 'STOP_TRANSCRIBE',
  // Pause stops sending PCM frames to the provider but keeps the WS
  // + AudioContext alive so resume is instant. Distinct from STOP —
  // the provider session is preserved (no new POST /sessions).
  PAUSE_TRANSCRIBE: 'PAUSE_TRANSCRIBE',
  RESUME_TRANSCRIBE: 'RESUME_TRANSCRIBE',
  GET_TRANSCRIBE_STATE: 'GET_TRANSCRIBE_STATE',
  // background -> popup / content script
  TRANSCRIBE_STATE_UPDATE: 'TRANSCRIBE_STATE_UPDATE',
  // background -> offscreen
  OFFSCREEN_TRANSCRIBE_START: 'OFFSCREEN_TRANSCRIBE_START',
  OFFSCREEN_TRANSCRIBE_STOP: 'OFFSCREEN_TRANSCRIBE_STOP',
  OFFSCREEN_TRANSCRIBE_PAUSE: 'OFFSCREEN_TRANSCRIBE_PAUSE',
  OFFSCREEN_TRANSCRIBE_RESUME: 'OFFSCREEN_TRANSCRIBE_RESUME',
  // Offscreen asks SW to mint a fresh session + ws_url so it can
  // re-attach the WS after a network drop. SW replies with
  // ``{ok, ws_url, session_id}`` or ``{ok:false, error}``. Keeping
  // this round-trip means the SW remains the single owner of API
  // calls — offscreen never holds the bearer token.
  OFFSCREEN_TRANSCRIBE_GET_RECONNECT_URL: 'OFFSCREEN_TRANSCRIBE_GET_RECONNECT_URL',
  // Bug 11.1 — SW forwards a DOM caption-author observation to the
  // offscreen doc so it can send a ``speaker_observation`` control
  // frame over the live transcribe WS(s). The relay uses these
  // observations to drive ``name_by_label`` correlation for
  // important-points attribution when the user is transcribing
  // WITHOUT a paired recording (no recording timeline to read from).
  // Payload: ``{name, wallClockMs, source?}``.
  OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION:
    'OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION',
  // offscreen -> background — lifecycle + each transcript event
  TRANSCRIBE_LIFECYCLE: 'TRANSCRIBE_LIFECYCLE',  // {phase: started|stopped|error}
  // offscreen -> background — per-attempt reconnect progress. The SW
  // mirrors the latest phase into TranscribeState so the popup can
  // render a "Reconnecting (2 of 4)…" indicator without polling.
  // phases: 'reconnecting' | 'reconnected' | 'failed'.
  TRANSCRIBE_RECONNECT_PROGRESS: 'TRANSCRIBE_RECONNECT_PROGRESS',
  TRANSCRIPT_EVENT: 'TRANSCRIPT_EVENT',           // forwarded from provider
  // offscreen -> background — fires once per session when the FIRST
  // inbound provider event (partial / final) arrives. Phase L1: lets
  // the SW flip ``hasFirstEvent: true`` on transcribe state so the
  // popup pill can render "Listening…" before this and "Active" after.
  // Idempotent at the SW — re-fires are coalesced.
  TRANSCRIBE_FIRST_EVENT: 'TRANSCRIBE_FIRST_EVENT',
  // offscreen -> background — periodic batch of extracted action
  // items / decisions / questions / key takeaways. Payload:
  //   { points: [{id, type, text, speaker?}, ...] }
  // The SW merges these into transcribe state's ``importantPoints``
  // array (deduped by id) and broadcasts to the popup. New points
  // only — the relay tracks ``_sent_point_ids`` server-side so each
  // message contains only deltas.
  IMPORTANT_POINTS_UPDATE: 'IMPORTANT_POINTS_UPDATE',

  // P5 — offscreen → background: the live-transcribe relay sent a
  // graceful close because the recording hit its cumulative duration
  // cap. SW marks the transcribe session terminal (no reconnect) and
  // surfaces the cap details on TranscribeState so the popup banner
  // can render "Live transcription reached its 3-hour limit." A
  // separate message from STATE_UPDATE because the cap fires per
  // session and the SW has to suppress the reconnect loop.
  TRANSCRIBE_DURATION_CAP_EXCEEDED: 'TRANSCRIBE_DURATION_CAP_EXCEEDED',

  // offscreen -> background — periodic audio level snapshots from the
  // mixer's analyser nodes. The SW relays these to an open popup as
  // LEVEL_UPDATE; if the popup is closed they are dropped on the floor.
  AUDIO_LEVELS: 'AUDIO_LEVELS',
  // background -> popup — relayed level snapshot.
  LEVEL_UPDATE: 'LEVEL_UPDATE',
});

export const StorageKey = Object.freeze({
  // Firebase ID token (short-lived, ~1h). Reused storage key name so
  // existing call sites (`request()`, popup/options account UI,
  // overlay) keep working; only the token's PROVENANCE changed
  // (backend password auth → Firebase). Refreshed in place via
  // REFRESH_TOKEN before expiry.
  AUTH_TOKEN: 'mm_auth_token',
  // Firebase refresh token (long-lived). Used by the secure-token
  // endpoint to mint a fresh ID token without re-prompting for the
  // password. Never sent to the MeetMinutes backend.
  REFRESH_TOKEN: 'mm_refresh_token',
  // Date.now() ms at which the current ID token expires. We refresh
  // proactively (60s skew) and reactively (on a 401).
  TOKEN_EXPIRES_AT: 'mm_token_expires_at',
  // Email of the currently signed-in user. Set on successful
  // register/login, cleared on sign-out. Shown in popup header +
  // options "Signed in as …" row. Never sent to the backend on its
  // own — the bearer token is the source of truth for identity.
  USER_EMAIL: 'mm_user_email',
  // Backend-stored display name for the signed-in user (the ``name``
  // field on ``GET /user/profile``). Populated after every successful
  // signin/signup/oauth and on SW boot as a backfill for installs that
  // signed in before this key existed. Cleared on sign-out. Read by
  // popup / control-window / overlay as the canonical "what should we
  // call the user" — preferred over deriving from the email local part
  // (which produces "Shubhampilivkar" instead of "Shubham Pilivkar").
  // Nullable: not every account has a name set yet, callers must fall
  // back to the email-derived label.
  USER_NAME: 'mm_user_name',
  API_BASE_URL: 'mm_api_base_url',
  MIC_GAIN: 'mm_mic_gain',
  TAB_GAIN: 'mm_tab_gain',
  VIDEO_BITRATE: 'mm_video_bitrate',
  AUDIO_BITRATE: 'mm_audio_bitrate',
  SESSION_STATE: 'mm_session_state',
  // Audio-only capture (no video track included in the recording stream).
  // Reduces bandwidth ~10x on long calls and matches what Otter / Fireflies
  // offer. Default false so existing installs keep their current behaviour.
  AUDIO_ONLY: 'mm_audio_only',
  // Recording capture source — see the ``CaptureSource`` enum. Unset
  // (default) behaves as ``'tab'`` so existing installs keep their
  // current chrome.tabCapture behaviour.
  CAPTURE_SOURCE: 'mm_capture_source',
  // Optional explicit mic device. When unset (default), getUserMedia uses
  // the system default. The options page enumerates inputs and lets the
  // user lock to a specific deviceId.
  MIC_DEVICE_ID: 'mm_mic_device_id',
  // Sticky "the extension origin has been granted microphone access"
  // flag. Set true by the one-time permission page, cleared if the
  // offscreen doc later finds the mic denied (user revoked). The SW
  // uses it to decide whether to open the permission page before a
  // mic-using start, so the prompt is shown once, not every time.
  MIC_GRANTED: 'mm_mic_granted',
  // chrome.windows id of the detached recording-control window (the
  // small always-visible popup with the level meters + pause/stop).
  // Tracked so the SW focuses the existing one instead of spawning
  // duplicates, and clears it when the window is closed.
  CONTROL_WINDOW_ID: 'mm_control_window_id',
  // Bridge to MeetMinutes Desktop — opt-in.
  //   BRIDGE_ENABLED: master toggle; false by default.
  //   BRIDGE_TOKEN: full Bearer token copied from the desktop Settings
  //                 dialog. Stored in chrome.storage.local, never logged.
  BRIDGE_ENABLED: 'mm_bridge_enabled',
  BRIDGE_TOKEN: 'mm_bridge_token',
  // Per-feature live-transcribe state. Held in chrome.storage.session
  // (volatile) so the popup re-renders correctly after open/close and
  // the SW state survives a brief suspend. Cleared on each stop.
  TRANSCRIBE_STATE: 'mm_transcribe_state',
  // Last-used pickers in the live-transcribe UI. Persist across
  // popup opens so the user doesn't pick mode/language/provider
  // every time.
  TRANSCRIBE_LAST_MODE: 'mm_transcribe_last_mode',
  TRANSCRIBE_LAST_LANGUAGE: 'mm_transcribe_last_language',
  // Phase U6 — overlay position (right/bottom in px) + minimized
  // flag. Persisted so users who like the overlay tucked into a
  // particular corner don't have to re-arrange every session.
  OVERLAY_POSITION: 'mm_overlay_position',
  OVERLAY_MINIMIZED: 'mm_overlay_minimized',
  // Phase E — feature flag for the WebCodecs-based recorder. Default
  // false; flip to ``true`` in options to opt in. Only takes effect
  // for audio-only recordings (the v1 path is audio-only Opus →
  // WebM via a hand-written minimal muxer). Video recordings stay on
  // MediaRecorder for now.
  WEBCODECS_RECORDER_ENABLED: 'mm_webcodecs_recorder_enabled',
  // Phase F v1 — client-side encryption (Option A: encrypted at
  // rest). When true, recording chunks are encrypted with a per-
  // meeting AES-GCM key wrapped by a non-extractable master key
  // held in IndexedDB. Backend stores ciphertext + the wrapped key
  // opaquely. Transcription is NOT available on encrypted meetings
  // in v1 (the worker would need decryption capability; that's a
  // follow-up phase). Default false.
  E2EE_ENABLED: 'mm_e2ee_enabled',
  // Explicit user choice for caption visibility while recording /
  // transcribing. Captions MUST be on for the speaker-timeline
  // scrape, but the user decides whether to SEE them via the popup
  // prompt: true = show (no hide-CSS), false = hide (inject CSS),
  // unset = not chosen yet (defaults to hidden, prompt shown).
  CAPTION_SHOW: 'mm_caption_show',
  // Subscription / feature-gate snapshot. Mirrors the
  // ``external_platform`` sub-object of GET /subscription/
  // get-features-info; the popup reads this on every render to
  // decide whether each top-level surface (Recording / Live
  // Transcription / Add Bot) is usable or shows the upgrade modal.
  // Refreshed on every successful auth + periodically by the SW
  // (alarm). Default-allow when missing / stale to avoid blocking
  // users on a transient API failure.
  FEATURES_INFO: 'mm_features_info',
  FEATURES_FETCHED_AT: 'mm_features_fetched_at',
});


// Default backend the extension talks to when the user hasn't set a
// custom URL on the options page. Production deployment for the
// Chrome Web Store release; covered by the manifest CSP `connect-src
// https://*.meetminutes.in` and a host_permissions entry on
// `https://api.meetminutes.in/*`. Override-able via the options
// page for developers pointing at a different deployment.
export const DEFAULT_API_BASE_URL = 'https://api.meetminutes.in';

// Auth is fully BACKEND-MEDIATED (BFF): the extension ships NO
// Firebase Web API key and NO OAuth client id/secret. Email/password
// → POST /security/{login,signup}; Google/Microsoft → backend
// /security/oauth/{authorize-url,exchange} (PKCE via
// chrome.identity); token refresh → POST /security/refresh-token.
// All Firebase/OAuth credentials live server-side. Hence none of the
// former DEFAULT_FIREBASE_API_KEY / *_OAUTH_CLIENT_ID /
// FIREBASE_*_BASE constants exist anymore.

// Refresh the ID token this many ms BEFORE its stated expiry so an
// in-flight request never races the expiry boundary.
export const TOKEN_REFRESH_SKEW_MS = 60_000;
export const DEFAULT_MIC_GAIN = 1.0;
export const DEFAULT_TAB_GAIN = 1.0;

export const CHUNK_INTERVAL_MS = 20_000;
export const HEARTBEAT_INTERVAL_MS = 2_000;
// Watchdog timeout. Generous on purpose: under MV3, Chrome can throttle
// or briefly suspend the service worker, and the watchdog alarm runs at
// the 30s MV3 minimum (HEARTBEAT_ALARM_PERIOD_MIN). A 5s timeout was
// declaring "recorder lost" on routine SW pauses; 30s keeps the safety
// net useful while tolerating one full alarm cycle.
export const HEARTBEAT_TIMEOUT_MS = 30_000;
export const HEARTBEAT_ALARM_NAME = 'mm_hb_watchdog';
export const HEARTBEAT_ALARM_PERIOD_MIN = 0.5; // 30s — the MV3 minimum
export const STOP_FORCE_TIMEOUT_MS = 10_000;
// Backup alarm armed alongside the stop-force setTimeout. setTimeout is
// the fast path (10s); the alarm is the slow path that survives a SW
// suspend (≥30s — the MV3 alarm minimum).
export const STOP_FORCE_ALARM_NAME = 'mm_stop_force';
export const STOP_FORCE_ALARM_DELAY_MIN = 0.5;

// Phase D — periodic background sync. A long-period alarm that
// retries orphan-chunk uploads even when the user never re-opens
// the popup. Fires every 30 min (chrome.alarms minimum that doesn't
// cost much battery). Skipped while a recording or transcribe is
// active — the live drain pump owns those.
export const PERIODIC_SYNC_ALARM_NAME = 'mm_periodic_sync';
export const PERIODIC_SYNC_PERIOD_MIN = 30;

// Subscription / feature-gate refresh. Periodic alarm that keeps
// ``StorageKey.FEATURES_INFO`` warm so the popup never renders with
// hours-stale gates. 60 min cadence trades freshness against the
// API request cost (one cheap GET per hour per active user).
export const FEATURES_REFRESH_ALARM_NAME = 'mm_features_refresh';
export const FEATURES_REFRESH_PERIOD_MIN = 60;
// Pricing page that the upgrade CTA opens. Hardcoded per the
// feature spec; if marketing ever needs to rotate the URL, change
// here and every entry point picks it up.
export const PRICING_PAGE_URL = 'https://www.meetminutes.in/pricing';
// Support page that the "Contact Support" CTA on the upgrade modal
// opens. Lives alongside PRICING_PAGE_URL so both ramp-up CTAs are
// centralised — change here, every surface (modal / future banners)
// follows.
export const SUPPORT_PAGE_URL = 'https://www.meetminutes.in/Support';
export const SPEAKER_DEBOUNCE_MS = 300;
export const POLL_FALLBACK_MS = 500;
export const POLL_FALLBACK_TRIGGER_MS = 10_000;
export const AUDIO_CONTEXT_ROTATE_MS = 60 * 60 * 1000;
export const TIMELINE_FLUSH_MS = 30_000;
// Speaker-timeline buffer cap. Like the telemetry buffer, timeline
// events persist to IDB and replay against /api/v1/recordings/{id}/
// timeline; until that endpoint is reachable (404/501) they accumulate.
// A 3-hour meeting can emit thousands of speaker turns, so cap the
// store and FIFO-evict the oldest so an unconfigured/old-backend
// install can't grow it without bound. 5000 ≈ a very long meeting's
// worth of turns while staying small on disk.
export const TIMELINE_BUFFER_MAX = 5_000;
export const UPLOAD_BACKOFF_MAX_MS = 30_000;

// Audio level meter cadence. 4 Hz is a good compromise between visual
// smoothness and IPC overhead — the popup animation interpolates between
// samples so the bars don't look choppy.
export const LEVEL_INTERVAL_MS = 250;

// Telemetry buffer — events are persisted to IDB and replayed against
// /api/v1/extension/events. Until the endpoint is deployed (404/501),
// events accumulate; once it goes live, the next flush sweeps them out.
// Capped so a long-running unconfigured install doesn't fill disk.
export const TELEMETRY_FLUSH_MS = 5 * 60 * 1000; // 5 min
export const TELEMETRY_BUFFER_MAX = 1_000;

// Allowed telemetry event names. Keeping the set narrow protects against
// typo-class bugs (``ws_recconect`` would silently buffer + flush forever)
// and keeps log-aggregation cardinality manageable. The Phase A vocabulary
// breaks down by subsystem:
//
// Recording lifecycle:
//   chunk_retry_max_backoff, auth_lost, monitor_blocked, orphan_recovered,
//   audio_context_rotated, offline_pause, online_resume, bitrate_downshift,
//   polling_fallback_engaged, selectors_broken
//
// Live transcribe (added in Phase A):
//   ws_reconnect_attempted, ws_reconnect_succeeded, ws_reconnect_exhausted,
//   ws_heartbeat_timeout, ws_provider_switch
//
// Service worker lifecycle (added in Phase A):
//   sw_restart_unexpected, sw_state_rehydrated, offscreen_doc_orphaned
//
// Performance signals (added in Phase A):
//   heap_high_water_mark, chunk_upload_latency,
//   speaker_detector_start_failed, probe_snapshot_failed,
//   observer_attach_failed, evaluate_failed, commit_speaker_failed,
//   poll_tick_failed
export const TELEMETRY_EVENT_NAMES = Object.freeze({
  // Recording
  CHUNK_RETRY_MAX_BACKOFF: 'chunk_retry_max_backoff',
  AUTH_LOST: 'auth_lost',
  MONITOR_BLOCKED: 'monitor_blocked',
  ORPHAN_RECOVERED: 'orphan_recovered',
  // W2/W3 — finalize outcomes. ABANDONED: terminal 409/422 (no chunks
  // / count disagreement) → recording dropped, orphan loop stopped.
  // MISSING_CHUNKS: recoverable 409 (server listed missing indices).
  // SERVER_FAILED: status poll reported failed/error (carries
  // error_code) so we stop re-finalizing a server-terminal recording.
  FINALIZE_ABANDONED: 'finalize_abandoned',
  FINALIZE_MISSING_CHUNKS: 'finalize_missing_chunks',
  FINALIZE_SERVER_FAILED: 'finalize_server_failed',
  AUDIO_CONTEXT_ROTATED: 'audio_context_rotated',
  OFFLINE_PAUSE: 'offline_pause',
  ONLINE_RESUME: 'online_resume',
  BITRATE_DOWNSHIFT: 'bitrate_downshift',
  POLLING_FALLBACK_ENGAGED: 'polling_fallback_engaged',
  SELECTORS_BROKEN: 'selectors_broken',
  // Live transcribe — reconnect path emits these so we can compute
  // reconnect-success rate and median-attempt-to-recover.
  WS_RECONNECT_ATTEMPTED: 'ws_reconnect_attempted',
  WS_RECONNECT_SUCCEEDED: 'ws_reconnect_succeeded',
  WS_RECONNECT_EXHAUSTED: 'ws_reconnect_exhausted',
  WS_HEARTBEAT_TIMEOUT: 'ws_heartbeat_timeout',
  WS_PROVIDER_SWITCH: 'ws_provider_switch',
  // Phase L1 — wall-clock ms from WS ``open`` to first inbound
  // provider event (partial / final / speaker_change). This is the
  // cold-start baseline: today it includes the backend's lazy
  // provider-WS open (~200-500ms per the Deepgram + AssemblyAI docs).
  // Phase L3's pre-warm pattern is graded against this distribution.
  TRANSCRIBE_FIRST_PARTIAL_MS: 'transcribe_first_partial_ms',
  // Service worker — long-meeting stability data.
  SW_RESTART_UNEXPECTED: 'sw_restart_unexpected',
  SW_STATE_REHYDRATED: 'sw_state_rehydrated',
  OFFSCREEN_DOC_ORPHANED: 'offscreen_doc_orphaned',
  // Perf — heap watermark + per-network upload latency percentiles.
  HEAP_HIGH_WATER_MARK: 'heap_high_water_mark',
  CHUNK_UPLOAD_LATENCY: 'chunk_upload_latency',
  // Detector resilience — added when we hardened the content scripts.
  SPEAKER_DETECTOR_START_FAILED: 'speaker_detector_start_failed',
  PROBE_SNAPSHOT_FAILED: 'probe_snapshot_failed',
  OBSERVER_ATTACH_FAILED: 'observer_attach_failed',
  EVALUATE_FAILED: 'evaluate_failed',
  COMMIT_SPEAKER_FAILED: 'commit_speaker_failed',
  POLL_TICK_FAILED: 'poll_tick_failed',
  // Session replay — Phase B. Single event name for the entire
  // ring-buffer dump triggered by the popup's "Report a problem"
  // button. Payload is sanitised; see lib/session-replay.js.
  SESSION_REPLAY_DUMP: 'session_replay_dump',
  // VAD stats — Phase C. Worklet reports rolling drop percentage so
  // we can attribute the STT-cost reduction to the gate. Fires every
  // 60s while transcribing.
  VAD_STATS: 'vad_stats',
  // Phase D — periodic-sync alarm fired and (a) had nothing to do,
  // or (b) successfully drained N orphan meetings. Lets ops see
  // that the background safety-net is actually catching the rare
  // network-down-at-shutdown case.
  PERIODIC_SYNC_TICK: 'periodic_sync_tick',
  // Phase E — WebCodecs recorder path engaged for a session, plus
  // any errors that forced fallback to MediaRecorder. Lets us see
  // adoption rate + measure quality differences between the two
  // pipelines once we start collecting comparative metrics.
  WEBCODECS_RECORDER_USED: 'webcodecs_recorder_used',
  WEBCODECS_RECORDER_FALLBACK: 'webcodecs_recorder_fallback',
  // Phase F — client-side encryption engaged for a session, plus
  // any crypto failures that forced fallback to plaintext upload.
  // Adoption + reliability signal.
  E2EE_SESSION_STARTED: 'e2ee_session_started',
  E2EE_CRYPTO_FAILED: 'e2ee_crypto_failed',
  // Caption-ownership policy (lib/caption-policy.js) + caption-scrape
  // observer (lib/caption-speaker-observer.js). These were emitted but
  // NOT allowlisted, so emitEvent() silently dropped them — production
  // had zero visibility into whether the policy hid/kept captions
  // correctly or whether speaker attribution degraded. Allowlisted so
  // the four ownership decisions + the unattributed/engaged signals
  // actually reach /api/v1/events.
  CAPTION_POLICY_USER_PREOWNED: 'caption_policy_user_preowned',
  CAPTION_POLICY_USER_ENABLED: 'caption_policy_user_enabled',
  CAPTION_POLICY_USER_DISABLED: 'caption_policy_user_disabled',
  CAPTION_POLICY_RESTORED_OFF: 'caption_policy_restored_off',
  CAPTION_SPEAKER_UNATTRIBUTED: 'caption_speaker_unattributed',
  CAPTION_SPEAKER_OBSERVER_ENGAGED: 'caption_speaker_observer_engaged',
});

// Default recording bitrates. The options page lets the user override
// these (stored under StorageKey.VIDEO_BITRATE / AUDIO_BITRATE).
// Defaults favour quality; the options menu offers lower presets to
// cap file size on long sessions. Existing installs whose users
// picked an explicit value keep it (the storage entry is read first;
// only fresh installs land on the default).
export const DEFAULT_VIDEO_BITRATE = 1_500_000;
// Audio default raised 96 → 128 kbps for noticeably more headroom on
// speech sibilance + room ambience. Opus at 128 kbps is transparent
// for conversational speech; 96 kbps was good but had audible
// coding artefacts on quieter passages. Only ~33% more storage per
// minute of audio (and audio is a tiny fraction of total size when
// video is on).
export const DEFAULT_AUDIO_BITRATE = 128_000;
// Allowed presets — kept here so options.js and the recorder stay in
// sync. Audio presets bumped Phase 4: lowest is now 96 kbps (was
// 64 kbps — barely above mobile-call quality) and a new 192 kbps tier
// is offered for users who care about archival fidelity.
export const VIDEO_BITRATE_PRESETS = [1_000_000, 1_500_000, 2_500_000];
export const AUDIO_BITRATE_PRESETS = [96_000, 128_000, 192_000];

// Queue back-pressure thresholds (in number of pending chunks).
//   WARN  — surface a banner; recording continues normally.
//   PAUSE — pause MediaRecorder so we stop adding to the queue.
//   RESUME — once the queue drops below this, resume MediaRecorder.
// At 20s/chunk, 50 ≈ 17 min, 200 ≈ 67 min worth of unsent data.
export const QUEUE_DEPTH_WARN = 50;
export const QUEUE_DEPTH_PAUSE = 200;
export const QUEUE_DEPTH_RESUME = 100;

// startMeeting retry on transient (5xx / network) failures.
export const START_RETRY_ATTEMPTS = 3;
export const START_RETRY_BASE_MS = 1_000;

// Selector regression detector — fires telemetry once per session if
// probe.snapshot() returns 0 tiles for this long while a recording is
// active. Indicates Meet/Teams DOM rotated and our heuristics broke.
export const SELECTORS_BROKEN_MS = 30_000;

// Desktop-bridge wire constants — must stay in sync with the Python
// side at recorder/speaker_id/bridge_server.py. The desktop binds the
// first free port in this range; the extension probes them in order
// on connect.
export const BRIDGE_PORT_RANGE = [
  47291, 47292, 47293, 47294, 47295, 47296, 47297, 47298, 47299,
];
// Per-attempt TCP/WS connect deadline. Below 2s yields false negatives
// on busy machines (Chrome's WS handshake on localhost still takes
// ~80ms cold); above 5s makes "all 9 ports busy" feel sluggish.
export const BRIDGE_CONNECT_TIMEOUT_MS = 3_000;
// Reconnect backoff after a successful connect drops (e.g. desktop
// app quit). Doubles each attempt, capped, and resets on a successful
// pair.
export const BRIDGE_RECONNECT_BASE_MS = 1_000;
export const BRIDGE_RECONNECT_MAX_MS = 30_000;

// MIME preference for video recordings. MP4/H.264 is FIRST on
// purpose: a WebM/VP9 recording forces the backend finalize to
// software-decode VP9 (libvpx) over a byte-concatenated multi-cluster
// stream, which stalls indefinitely on modest hosts → finalize fell
// back to AUDIO-ONLY, so the final file had no screen/video at all.
// Chrome (M130+) can MediaRecorder straight to fragmented MP4 with
// H.264 + AAC; the backend then finalises with a pure ``-c copy``
// concat (NO decode → cannot stall, full video + audio preserved).
// ``MediaRecorder.isTypeSupported`` gates each entry, so older
// Chrome transparently falls back to the WebM/VP9 path (which still
// works via the backend's remux→transcode→audio-fallback chain).
//
// Phase 4 — try MP4 + Opus FIRST when Chrome supports it. Opus is
// significantly better quality-per-bit than AAC at the bitrates we
// run (96-192 kbps): noticeably less sibilance distortion and a
// flatter response on quiet speech. The two AAC entries stay as
// fallbacks for builds that don't yet ship MP4-with-Opus.
export const PREFERRED_MIME_TYPES = [
  'video/mp4;codecs=avc1.42E01E,opus',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

// Audio-only mode falls back through these MIME types in order. Opus in
// WebM is universally supported in Chrome and yields ~64 kbps audio at the
// default audio bitrate — an order of magnitude smaller than video.
export const AUDIO_ONLY_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
];

/**
 * @typedef {Object} SessionState
 * @property {keyof typeof RecordingState} state
 * @property {string|null} meetingId
 * @property {string|null} uploadUrl
 * @property {number|null} tabId
 * @property {keyof typeof Source|null} source
 * @property {string|null} url
 * @property {number|null} recordingStartedAt    Wall-clock ms when recording began.
 * @property {boolean} micAvailable
 * @property {number} uploadQueueDepth
 * @property {string|null} currentSpeaker
 * @property {string|null} errorMessage
 * @property {number} lastChunkIndex
 * @property {number} lastHeartbeatAt   Date.now() of the most recent OFFSCREEN_HEARTBEAT.
 * @property {boolean} monitorBlocked   true when the offscreen audio monitor was rejected by autoplay policy.
 * @property {boolean} queueWarning     true when uploadQueueDepth has exceeded QUEUE_DEPTH_WARN.
 * @property {boolean} recordingPaused  true when MediaRecorder is paused due to queue back-pressure.
 * @property {boolean} userPaused       true when the user clicked Pause in the popup.
 */

/**
 * @typedef {Object} TimelineEvent
 * @property {string} speaker_name
 * @property {number} start_time   Seconds since recordingStartedAt.
 * @property {number} end_time
 */

// Toolbar badge colours. Used by the SW to surface state on the action
// icon so the user can see "recording" without opening the popup — both
// a UX win and a privacy/consent best practice.
export const BADGE = Object.freeze({
  RECORDING: { text: 'REC', color: '#dc2626' },
  STARTING: { text: '...', color: '#d97706' },
  STOPPING: { text: '...', color: '#d97706' },
  ERROR: { text: '!', color: '#7f1d1d' },
  NEEDS_REAUTH: { text: '!', color: '#7f1d1d' },
  IDLE: { text: '', color: '#000000' },
});
