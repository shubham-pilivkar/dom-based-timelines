// Phase U3 — map internal error codes to plain-language messages.
//
// The popup currently surfaces raw error codes (``reconnect_failed_after_4_attempts``,
// ``e2ee_init_failed: NotSupportedError: ...``, ``transcribe_provider_unavailable``)
// to users. Codes are the right shape for logs but the wrong shape for a
// human reading a 280px popup — they read like a stacktrace.
//
// This module's job is purely translation. ``humanize(code)`` returns:
//
//   * ``{title, body}``  — when the code is in our catalog
//   * ``null``           — when we don't have a translation; caller falls
//                          back to rendering the raw code (no regression
//                          on unmapped codes)
//
// We intentionally don't surface "Try again" buttons / actions yet —
// the popup's existing affordances (Start / Stop / Sign-in-again
// link) already cover the common cases. Action wiring is a U3 v2
// concern if friction surveys flag it.

/**
 * @typedef {Object} HumanError
 * @property {string} title    — short, headline (≤32 chars)
 * @property {string} body     — explanation + suggested action (≤140 chars)
 */


// Exact-match codes. Keys are the raw strings the SW or API client
// surfaces. Ordering doesn't matter; lookup is O(1).
//
// Style guide for new entries:
//   * ``title`` is sentence-case, no trailing punctuation
//   * ``body`` ends with a period and (where useful) tells the user
//     what action will help
const _EXACT = Object.freeze({
  // Auth / account
  auth_expired: {
    title: 'Sign-in expired',
    body: 'Sign in again from the popup to resume recording and uploads.',
  },

  // Recording lifecycle
  busy_recording: {
    title: 'Already recording',
    body: 'Stop the active recording before starting a new one.',
  },
  busy_transcribing: {
    title: 'Transcription in progress',
    body: 'Stop the active transcription before recording.',
  },
  no_meeting_tab: {
    title: 'No meeting tab',
    body: 'Open Google Meet or Microsoft Teams in a tab and try again.',
  },
  not_in_meeting_room: {
    title: 'Not in a meeting',
    body: 'Open a Meet or Teams meeting in this tab first, then click Start.',
  },
  invalid_credentials: {
    title: 'Sign-in failed',
    body: 'Email or password is incorrect. Check your details and try again.',
  },
  offscreen_heartbeat_lost: {
    title: 'Lost contact with the recorder',
    body: 'Recording halted. Any chunks already captured are still queued for upload.',
  },
  mic_denied: {
    title: 'Microphone access denied',
    body: 'Allow microphone access in the browser address bar, then try again.',
  },

  // Encryption (Phase F)
  e2ee_init_failed: {
    title: 'Could not set up encryption',
    body: 'Browser refused to generate a key. Turn encryption off in Options and back on, or contact support.',
  },

  // Live transcription (Phase A reconnect / Phase C provider config)
  transcribe_invalid_request: {
    title: 'Transcription settings not supported',
    body: 'The selected language is not supported by the configured backend. Pick another language or contact support.',
  },
  transcribe_concurrency_cap: {
    title: 'Too many live sessions',
    body: 'You have hit the per-account concurrency limit. Stop another active session and retry.',
  },
  transcribe_provider_unavailable: {
    title: 'Transcription unavailable',
    body: 'The transcription backend is not configured on this deploy. Contact your administrator.',
  },
  reconnect_failed: {
    title: 'Connection unstable',
    body: 'We tried to reconnect and gave up. Press Start to begin a fresh session.',
  },
});


// Prefix-match codes. The SW often appends a status or attempt count
// (``start_failed_502``, ``reconnect_failed_after_4_attempts``). We
// match on the stable prefix and let the suffix pass through into
// the body when useful.
//
// Order matters — first match wins, so put the more specific prefix
// first when two could both match.
const _PREFIXES = Object.freeze([
  ['start_failed_5', {
    title: 'Server error',
    body: 'The backend returned a 5xx. Try again in a moment — recording will retry uploads.',
  }],
  ['start_failed_4', {
    title: 'Could not start recording',
    body: 'The backend rejected the request. Check your account or contact support.',
  }],
  ['start_failed_', {
    title: 'Could not start recording',
    body: 'The backend did not respond. Check your connection and try again.',
  }],
  ['reconnect_failed_after_', {
    title: 'Connection unstable',
    body: 'We tried to reconnect several times and gave up. Press Start to begin a fresh session.',
  }],
  ['chunk_upload_', {
    title: 'Upload retrying',
    body: 'A recording chunk failed to upload. We keep retrying in the background.',
  }],
  ['tabCapture_failed', {
    title: 'Could not capture the tab',
    body: 'Make sure the meeting tab is visible and try again.',
  }],
  ['offscreen_start_failed', {
    title: 'Could not start the recorder',
    body: 'Refresh the meeting tab and try again.',
  }],
  ['media_recorder_error', {
    title: 'Recorder error',
    body: 'The browser recorder hit a problem and stopped. Try starting again.',
  }],
  ['offscreen_heartbeat_lost', {
    title: 'Lost contact with the recorder',
    body: 'Recording halted. Already-captured chunks stay queued for upload.',
  }],
  ['webcodecs_recorder_unsupported', {
    title: 'WebCodecs not supported',
    body: 'Your browser does not expose WebCodecs. Turn off the WebCodecs recorder option.',
  }],
  ['heartbeat_timeout', {
    title: 'Connection idle too long',
    body: 'The transcription connection went quiet — reconnecting now.',
  }],
]);


// Reasons that accompany a CLEAN lifecycle stop, not a fault. If one
// of these ever reaches an error renderer (belt-and-braces — the SW
// already avoids putting them in the error field on ``stopped``), we
// must suppress the row rather than show "client_stop" as a failure.
const _BENIGN = Object.freeze(new Set([
  'client_stop',     // user clicked Stop
  'tab_closed',      // meeting tab went away
  'user_stop',
  'normal_closure',
  'stopped',
]));

/**
 * True when ``code`` denotes a clean stop (no user-facing fault).
 * @param {string | null | undefined} code
 * @returns {boolean}
 */
export function isBenignStop(code) {
  if (!code || typeof code !== 'string') return false;
  const lead = code.split(/[\s—:]/, 1)[0];
  return _BENIGN.has(lead) || _BENIGN.has(code);
}

/**
 * Translate an internal error code into a human-readable
 * ``{title, body}`` pair.
 *
 * Returns ``null`` when the code is unknown — caller should fall
 * back to rendering the raw string so users see SOMETHING rather
 * than nothing. New codes can be added to ``_EXACT`` or
 * ``_PREFIXES`` above without touching any caller.
 *
 * @param {string | null | undefined} code
 * @returns {HumanError | null}
 */
export function humanize(code) {
  if (!code || typeof code !== 'string') return null;
  // Some error strings carry a suffix ("auth_expired — re-enter
  // token in options"). Match against the leading token first.
  const lead = code.split(/[\s—:]/, 1)[0];
  if (_EXACT[lead]) return _EXACT[lead];
  if (_EXACT[code]) return _EXACT[code];
  for (const [prefix, msg] of _PREFIXES) {
    if (code.startsWith(prefix)) return msg;
  }
  return null;
}


/**
 * Apply ``humanize`` and write the result into a DOM element. Caller
 * provides the row container (toggled hidden) + a message container
 * (filled with structured nodes). When the code is unmapped we fall
 * back to plain ``textContent = code`` — no regression.
 *
 * Uses createElement/textContent (NOT innerHTML) so a future code
 * containing HTML can't inject markup. Cheap insurance.
 *
 * @param {{rowEl: HTMLElement, msgEl: HTMLElement, code: string | null | undefined}} args
 */
export function renderError({ rowEl, msgEl, code }) {
  // Always clear before re-rendering.
  msgEl.replaceChildren();
  if (!code || isBenignStop(code)) {
    // No code, or a clean-stop reason that slipped through — keep the
    // error row hidden so a normal Stop never looks like a failure.
    rowEl.classList.add('hidden');
    return;
  }
  rowEl.classList.remove('hidden');
  const human = humanize(code);
  if (human) {
    const titleEl = document.createElement('strong');
    titleEl.textContent = human.title;
    const sep = document.createElement('span');
    sep.textContent = ' — ';
    const bodyEl = document.createElement('span');
    bodyEl.textContent = human.body;
    msgEl.append(titleEl, sep, bodyEl);
    // Surface any SPECIFIC detail carried after the lead token (e.g. the
    // raw Chrome reason on "tabCapture_failed: <reason>") so the user and
    // support see WHY — not just the generic guidance. Without this the
    // actual cause ("Extension has not been invoked…", "Cannot capture a
    // tab with an active stream", etc.) is invisible.
    const lead = code.split(/[\s—:]/, 1)[0];
    const detail = code.slice(lead.length).replace(/^[\s—:]+/, '').trim();
    if (detail && detail.toLowerCase() !== human.body.toLowerCase()) {
      const detailEl = document.createElement('span');
      detailEl.className = 'error-detail';
      detailEl.textContent = ` (${detail})`;
      msgEl.append(detailEl);
    }
  } else {
    // Unmapped — show the raw code so users + support still have
    // something to grep on.
    msgEl.textContent = String(code);
  }
}
