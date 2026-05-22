// Single source of truth for "what should we call the signed-in user".
//
// The popup recording panel, the detached control window, and the
// live-transcribe overlay all show a fallback speaker label before a
// real SPEAKER_CHANGE arrives (and the mic substream of mode='both'
// uses it for every utterance). Three independent copies of the
// derive-name logic drifted; this module centralises them.
//
// Resolution order:
//   1. mm_user_name — the backend ``user.name`` field, written by
//      api/client.js::refreshUserName after every successful auth +
//      backfilled on SW boot. This is what we want to render in 99 %
//      of cases ("Shubham Pilivkar").
//   2. Email local part, title-cased — fallback for the brief window
//      between sign-in and the first /user/profile round-trip, and for
//      legacy installs whose backend row has a null ``name``.
//   3. Empty string — signed out / first paint.
//
// All consumers should observe ``chrome.storage.onChanged`` for
// StorageKey.USER_NAME and StorageKey.USER_EMAIL changes and refresh
// their cached value (a sign-out → sign-in as a different user is the
// most common trigger).

import { StorageKey } from '../constants.js';

/**
 * Title-case the local part of an email so it reads as a name.
 * "shubham.pilivkar@x.com" → "Shubham Pilivkar". Falls back to the raw
 * email if the local part is empty or "—".
 *
 * @param {string | null | undefined} email
 * @returns {string}
 */
export function deriveNameFromEmail(email) {
  if (!email) return '';
  const trimmed = String(email).trim();
  if (!trimmed || trimmed === '—') return '';
  const local = trimmed.split('@', 1)[0] || trimmed;
  return local
    .replace(/[._-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Resolve the user's display name from chrome.storage.local. Prefers
 * the backend ``user.name`` (StorageKey.USER_NAME); falls back to the
 * email local part; returns '' if neither is set.
 *
 * @returns {Promise<string>}
 */
export async function loadDisplayName() {
  try {
    const got = await chrome.storage.local.get([
      StorageKey.USER_NAME,
      StorageKey.USER_EMAIL,
    ]);
    const stored = got[StorageKey.USER_NAME];
    if (typeof stored === 'string' && stored.trim()) return stored.trim();
    return deriveNameFromEmail(got[StorageKey.USER_EMAIL]);
  } catch {
    return '';
  }
}

/**
 * Resolve a display name from a pre-read storage payload (the
 * ``changes`` map fed to ``chrome.storage.onChanged`` listeners, OR a
 * synchronous cache the caller already keeps). Lets callers stay
 * synchronous in their render path while still using the same
 * precedence rules. ``USER_NAME`` wins; ``USER_EMAIL`` falls back.
 *
 * @param {{ userName?: string | null, userEmail?: string | null }} bundle
 * @returns {string}
 */
export function resolveDisplayName({ userName, userEmail } = {}) {
  if (typeof userName === 'string' && userName.trim()) return userName.trim();
  return deriveNameFromEmail(userEmail);
}


// Synthetic-letter label the STT provider emits when it has no real
// diarization (Speaker A, Speaker B, …). The backend correlator
// resolves real names against the recording's speaker timeline, but
// the live overlay's important-points stream lands BEFORE that
// correlation, so we filter the letters out client-side — empty
// attribution is clearer than a placeholder no one in the meeting
// recognises. Matches the existing popup filter.
const SYNTHETIC_SPEAKER_LABEL = /^Speaker [A-Z]$/i;

/**
 * Normalise the ``speaker`` field on an important-point so the
 * overlay + popup render real participant names. The backend's
 * Gemini extractor often shortens names it pulled out of the
 * transcript ("Hello, my name is Shubham." → ``speaker: "Shubham"``);
 * we promote that to the user's full backend display name
 * ("Shubham Pilivkar") when the short form is the first-name token of
 * the signed-in user. Otherwise the raw value passes through
 * unchanged so other participants stay correctly attributed.
 *
 * Returns ``null`` for empty / synthetic / unattributed inputs so the
 * caller can skip rendering the dash + name entirely. This matches
 * the existing popup filter and consolidates the rule with overlay
 * rendering + the overlay's "Copy transcript" path.
 *
 * @param {unknown} rawSpeaker — the ``speaker`` field exactly as the
 *   relay sent it (may be missing, null, blank, real name, "Shubham",
 *   or "Speaker A").
 * @param {string | null | undefined} selfName — the canonical display
 *   name for the signed-in user (caller already resolved it via
 *   ``loadDisplayName`` / ``speakerMap.selfName``).
 * @returns {string | null}
 */
export function resolveImportantPointSpeaker(rawSpeaker, selfName) {
  if (typeof rawSpeaker !== 'string') return null;
  const raw = rawSpeaker.trim();
  if (!raw) return null;
  // Synthetic letter labels — drop entirely (callers shouldn't render).
  if (SYNTHETIC_SPEAKER_LABEL.test(raw)) return null;
  if (typeof selfName === 'string' && selfName.trim()) {
    const self = selfName.trim();
    const rawLower = raw.toLowerCase();
    const selfLower = self.toLowerCase();
    // Exact (case-insensitive) match → promote to the canonical
    // casing of selfName so "shubham" / "SHUBHAM" / "Shubham" all
    // render identically as "Shubham Pilivkar".
    if (selfLower === rawLower) return self;
    // First-name (or first-token-prefix) match → promote. Token
    // comparison so a substring like "Sh" or "ham" never matches.
    if (selfLower.startsWith(`${rawLower} `)) return self;
  }
  return raw;
}
