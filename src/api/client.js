import {
  DEFAULT_API_BASE_URL,
  START_RETRY_ATTEMPTS,
  START_RETRY_BASE_MS,
  StorageKey,
  TELEMETRY_EVENT_NAMES,
  TOKEN_REFRESH_SKEW_MS,
  UPLOAD_BACKOFF_MAX_MS,
} from '../constants.js';
// STATIC import — must NOT be `await import()`. emitEvent() is on the
// telemetry hot path and is called constantly by the service worker;
// a dynamic import there made Rollup split a duplicate chunk wrapped
// in Vite's __vitePreload (references `document`, undefined in a SW)
// AND emitted an unrewritten `import('../constants.js')` that 404s →
// SW "An unknown error occurred when fetching the script" + popup
// channel_closed. The client ↔ telemetry-buffer cycle is ESM-safe:
// telemetry-buffer only uses client's exports inside functions, never
// at module top-level, so the live bindings resolve fine.
import { bufferTelemetry } from './telemetry-buffer.js';

// Allowed names cached as a Set for O(1) membership checks at emit
// time. ``emitEvent`` is on the hot path during long meetings so the
// validator must be cheap.
const _ALLOWED_TELEMETRY_NAMES = new Set(Object.values(TELEMETRY_EVENT_NAMES));

// All endpoint paths live here so the real backend can be re-aligned
// without touching the rest of the codebase.
// Unified recording API (backend REFACTOR-2, 2026-05-16). The old
// extension-only `/api/v1/meetings/*` surface was deleted server-side
// (hard cutover → 404); desktop + extension now share one canonical
// `/api/v1/recordings/*` API. Non-recording endpoints moved to bare
// `/api/v1/{events,bot}`.
//
// AUTH (fully backend-mediated BFF): email/password →
// `POST /security/{login,signup}`; Google/Microsoft →
// `POST /security/oauth/{authorize-url,exchange}` (PKCE via
// chrome.identity); token refresh → `POST /security/refresh-token`;
// profile reads → `/user/profile`. The extension holds NO Firebase
// key and NO OAuth client id/secret — all credentials are
// server-side.
const ENDPOINTS = Object.freeze({
  // Profile / auth-check. The monolith owns the canonical user
  // document under /user/profile (the standalone backend's
  // /api/v1/me was deliberately not ported per the integration
  // decision in account_routes.py). Returns the full user row;
  // refreshUserName reads ``name`` from it and persists that as
  // mm_user_name — the single source of truth for "what should we
  // call the signed-in user" (preferred over deriving from the
  // email local part, which produces e.g. "Shubhampilivkar" without
  // the space the real name "Shubham Pilivkar" carries).
  userProfile: '/user/profile',
  // Single backend auth bootstrap — same call for first-ever signup
  // AND every subsequent login (200 = created/returned, 409
  // EMAIL_ALREADY_EXISTS = existing user, treated as success).
  // Native social login (Google / Microsoft) via the backend BFF +
  // PKCE. The backend holds the OAuth client id/secret AND the
  // Firebase key; the extension only handles a PKCE code. There is
  // NO `/security/social-signup` call from the extension and NO
  // client-side Firebase at all.
  oauthAuthorizeUrl: '/security/oauth/authorize-url',
  oauthExchange: '/security/oauth/exchange',
  // Backend-mediated email/password (BFF). The Firebase Web API key
  // stays SERVER-SIDE — the shipped extension needs NO key (Bug 1).
  // `signup` is an explicit endpoint (server-side signup, not a
  // login-failure heuristic), so it works on Firebase projects with
  // Email Enumeration Protection (Bug 2). Mirrors the desktop app.
  login: '/security/login',
  signup: '/security/signup',
  // Backend refresh: exchange the Firebase refresh token for a fresh
  // ID (access) token. Public (no Bearer — the access token is
  // expired by definition). Keeps the Firebase secure-token call +
  // its API key server-side; the client only needs the API base
  // (already in host_permissions + CSP). 401 = re-auth required.
  refreshToken: '/security/refresh-token',
  // Create a recording. Server mints the id (extension omits
  // recording_id). Returns { recording_id, status, upload_url }.
  startMeeting: '/api/v1/recordings',
  // Chunk index is now a PATH segment (server dedupes by it); the old
  // chunk_index / is_final / idempotency_key form fields are gone.
  chunks: (id, idx) => `/api/v1/recordings/${id}/chunks/${idx}`,
  finalize: (id) => `/api/v1/recordings/${id}/finalize`,
  // W3 — post-finalize poll target: status / error_code / final_url.
  recordingStatus: (id) => `/api/v1/recordings/${id}/status`,
  // W8 — per-recording lifecycle event log (doc §2.13). DISTINCT from
  // the telemetry `events` endpoint above: this one is keyed to a
  // recording and gives the backend START/STOP/… markers for
  // server-side observability + recovery.
  recordingEvents: (id) => `/api/v1/recordings/${id}/events`,
  timeline: (id) => `/api/v1/recordings/${id}/timeline`,
  events: '/api/v1/events',
  // Live transcription — REST control plane. The WebSocket URL the
  // backend returns from startTranscribeSession is opened directly by
  // the offscreen doc (not via this client) so the binary PCM frames
  // don't have to round-trip through the SW.
  startTranscribeSession: '/api/v1/transcribe/sessions',
  // Dispatch a Playwright bot to join a Google Meet / MS Teams call.
  // The bot service owns the meeting lifecycle from here; we just hand
  // it the URL + display name. 10/min/IP rate limit on the backend.
  dispatchBot: '/api/v1/bot',
  // Subscription / feature gating. Returns the per-user enabled-
  // features snapshot; the extension reads the ``external_platform``
  // sub-object to gate its three top-level surfaces (Recording,
  // Live Transcription, Add Bot). New gates added later require
  // ONLY a new entry in ``external_platform`` server-side AND a new
  // ``FeatureKey`` constant in the extension — no other plumbing.
  featuresInfo: '/subscription/get-features-info',
});

// Client-side password floor shown before a network round-trip.
// Firebase enforces ≥6; we keep the stricter UX value the popup
// already references. (Firebase remains the source of truth.)
export const PASSWORD_MIN_LENGTH = 10;

const CHUNK_DB_NAME = 'meetminutes-chunks';
// v3 adds a stable per-chunk idempotencyKey so a partially-succeeded POST
// (server received, response lost) is dedup-able when the client retries.
// Existing rows are backfilled in onupgradeneeded.
const CHUNK_DB_VERSION = 3;
const CHUNK_STORE = 'pending';
const MEETINGS_STORE = 'meetings';

function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Final fallback for environments without randomUUID (some test shims).
  return `mm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * W5 — lowercase-hex SHA-256 of a blob's exact bytes. Sent as the
 * optional `sha256` chunk-upload form field so the backend can reject
 * a corrupted-in-transit chunk (422) instead of stitching garbage.
 * Computed over the bytes ACTUALLY uploaded (the encrypted ciphertext
 * for E2EE recordings — that's what the server receives + verifies),
 * so it's correct regardless of the declared content-type. Returns
 * null if Web Crypto is unavailable (the field is optional — upload
 * proceeds unverified rather than failing).
 *
 * @param {Blob} blob
 * @returns {Promise<string|null>}
 */
async function sha256Hex(blob) {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i += 1) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    return null; // never block an upload on a hashing failure
  }
}

let cachedConfig = null;

// `chrome.storage` is not exposed in every context that imports this
// module — notably the offscreen document, which pulls in client.js
// only for persistChunk()/emitEvent() (neither needs storage). Touch
// it through this guard so a missing namespace degrades to defaults
// instead of throwing.
function storageLocal() {
  return (typeof chrome !== 'undefined'
    && chrome.storage
    && chrome.storage.local) || null;
}

async function loadConfig() {
  if (cachedConfig) return cachedConfig;
  const local = storageLocal();
  let got = {};
  if (local) {
    try {
      got = await local.get([StorageKey.AUTH_TOKEN, StorageKey.API_BASE_URL]);
    } catch {
      got = {};
    }
  }
  cachedConfig = {
    token: got[StorageKey.AUTH_TOKEN] ?? null,
    baseUrl: got[StorageKey.API_BASE_URL] ?? DEFAULT_API_BASE_URL,
  };
  return cachedConfig;
}

// Invalidate the config cache when the user updates token / URL on the
// options page. Only meaningful in the service worker; the offscreen
// document doesn't expose `chrome.storage.onChanged`, and registering
// at module top level there threw an UNCAUGHT TypeError that aborted
// offscreen module evaluation → OFFSCREEN_READY never fired →
// "Start recording" failed. Guarded so importing client.js is safe in
// any context.
if (typeof chrome !== 'undefined'
  && chrome.storage
  && chrome.storage.onChanged
  && typeof chrome.storage.onChanged.addListener === 'function') {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (StorageKey.AUTH_TOKEN in changes || StorageKey.API_BASE_URL in changes) {
      cachedConfig = null;
    }
  });
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Signals "the session is gone, re-auth required" — the SW maps this
// to RecordingState.NEEDS_REAUTH. Thrown on a 401 the refresh couldn't
// recover, or when no refresh token is present.
class AuthError extends Error {
  constructor() {
    super('auth_expired');
    this.name = 'AuthError';
  }
}

/**
 * P5 — backend rejected a chunk upload because the recording has hit
 * its cumulative duration cap (default 3 h, server-configurable per
 * deployment). The matching HTTP response is 403 (NOT 413 — CDN
 * middleware rewrites 413 bodies, see the backend docstring on
 * ``RecordingDurationExceeded``).
 *
 * Distinct from a generic 4xx so the drain loop can short-circuit
 * (a cap hit is policy, not a transient or poison-chunk failure) and
 * the SW can route to its own "limit reached" UX rather than the
 * generic upload-error banner.
 */
export class RecordingDurationExceededError extends Error {
  /** @param {{ capSeconds: number, consumedSeconds: number, graceSeconds?: number, message?: string }} info */
  constructor({ capSeconds, consumedSeconds, graceSeconds = 0, message = '' }) {
    super(message || `recording_duration_exceeded_${capSeconds}s`);
    this.name = 'RecordingDurationExceededError';
    this.capSeconds = capSeconds;
    this.consumedSeconds = consumedSeconds;
    this.graceSeconds = graceSeconds;
  }
}

/**
 * Parse the server-controlled duration cap off a create-recording /
 * start-transcribe response. Defensive: missing fields collapse to
 * "disabled" (0/0/0) rather than throwing — the cap UX is best-effort,
 * not load-bearing. Negative values get clamped at 0 so a buggy server
 * never asks the UI to render "consumed: -5m".
 *
 * @param {*} body  parsed JSON body
 * @returns {{ maxDurationSeconds: number, consumedSeconds: number, warningAtSecondsRemaining: number }}
 */
export function parseDurationCap(body) {
  const safeInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  if (!body || typeof body !== 'object') {
    return {
      maxDurationSeconds: 0,
      consumedSeconds: 0,
      warningAtSecondsRemaining: 0,
    };
  }
  return {
    maxDurationSeconds: safeInt(body.max_duration_seconds),
    consumedSeconds: safeInt(body.consumed_seconds),
    warningAtSecondsRemaining: safeInt(body.warning_at_seconds_remaining),
  };
}

/**
 * Inspect a 403 response. If the body matches the backend's structured
 * ``recording_duration_exceeded`` contract, returns a typed
 * :class:`RecordingDurationExceededError`; otherwise ``null`` so the
 * caller falls through to the generic 4xx path.
 *
 * Built as a separate helper so both the live upload path AND the IDB
 * drain can reuse it without re-implementing the body sniff.
 *
 * @param {Response} response
 * @returns {Promise<RecordingDurationExceededError|null>}
 */
async function tryParseDurationCapError(response) {
  // Clone before reading — the caller may also want resp.text() for
  // the generic 4xx telemetry path.
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  if (body.error_code !== 'recording_duration_exceeded') return null;
  const cap = Number(body.cap_seconds);
  const consumed = Number(body.consumed_seconds);
  if (!Number.isFinite(cap) || !Number.isFinite(consumed)) return null;
  return new RecordingDurationExceededError({
    capSeconds: Math.floor(cap),
    consumedSeconds: Math.floor(consumed),
    graceSeconds: Math.floor(Number(body.grace_seconds) || 0),
    message: String(body.message || ''),
  });
}

async function apiBaseUrl() {
  const { baseUrl } = await loadConfig();
  return baseUrl;
}

async function readAuthBundle() {
  const local = storageLocal();
  if (!local) return {};
  try {
    return await local.get([
      StorageKey.AUTH_TOKEN,
      StorageKey.REFRESH_TOKEN,
      StorageKey.TOKEN_EXPIRES_AT,
      StorageKey.USER_EMAIL,
      StorageKey.USER_NAME,
    ]);
  } catch {
    return {};
  }
}

/**
 * Persist the Firebase token bundle. `expiresIn` is seconds (Identity
 * Toolkit returns it as a string); we store an absolute Date.now() ms
 * deadline so the freshness check is a trivial comparison.
 */
async function persistTokens({ idToken, refreshToken, expiresIn, email }) {
  const expSec = Number(expiresIn) || 3600;
  /** @type {Record<string, unknown>} */
  const set = {
    [StorageKey.AUTH_TOKEN]: idToken,
    [StorageKey.REFRESH_TOKEN]: refreshToken,
    [StorageKey.TOKEN_EXPIRES_AT]: Date.now() + expSec * 1000,
  };
  if (email) set[StorageKey.USER_EMAIL] = email;
  await chrome.storage.local.set(set);
  // loadConfig's cache is keyed off AUTH_TOKEN — the storage.onChanged
  // listener invalidates it so the next request() reads the new token.
}

// Exchange the long-lived refresh token for a fresh ID token via the
// MeetMinutes backend (`POST /security/refresh-token`), NOT Google's
// secure-token endpoint directly — the backend owns the Firebase
// secure-token call + its API key. Public route (no Bearer). Throws
// on any non-2xx (caller turns that into AuthError → NEEDS_REAUTH).
// Backend response is camelCase `{ userId, idToken, refreshToken }`
// with NO expiry field; Firebase ID tokens are always valid for
// 3600s, which persistTokens() assumes when expiresIn is absent.
async function refreshViaBackend(refreshToken) {
  const baseUrl = await apiBaseUrl();
  const res = await fetch(`${baseUrl}${ENDPOINTS.refreshToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`refresh_failed_${res.status}`);
  return res.json(); // { userId, idToken, refreshToken }
}

// Single-flight: the MV3 SW can fire many requests at once after a
// wake; without this each would kick its own refresh, racing writes
// and hammering the (rate-limited) backend refresh route.
let _refreshInFlight = null;

/**
 * Return a usable Firebase ID token, refreshing if it's within the
 * skew window of expiry (or `force`). Returns null when signed out.
 * Throws AuthError when a refresh is required but fails / is
 * impossible (no refresh token — e.g. a legacy pre-Firebase token
 * from before this migration; the upgrade path clears those).
 *
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<string|null>}
 */
async function getFreshIdToken({ force = false } = {}) {
  const b = await readAuthBundle();
  const idToken = b[StorageKey.AUTH_TOKEN] ?? null;
  const refreshToken = b[StorageKey.REFRESH_TOKEN] ?? null;
  const expiresAt = Number(b[StorageKey.TOKEN_EXPIRES_AT]) || 0;
  if (!idToken && !refreshToken) return null; // signed out

  const stillFresh = idToken
    && Date.now() < expiresAt - TOKEN_REFRESH_SKEW_MS;
  if (!force && stillFresh) return idToken;

  if (!refreshToken) {
    // ID token present but no refresh token: a stale legacy
    // (pre-Firebase) credential. Can't refresh — surface as re-auth.
    throw new AuthError();
  }

  if (!_refreshInFlight) {
    _refreshInFlight = (async () => {
      const r = await refreshViaBackend(refreshToken);
      await persistTokens({
        idToken: r.idToken,
        // Google rotates the refresh token; the backend passes the
        // rotated one straight through, so persist it (fall back to
        // the existing one if the backend ever omits it).
        refreshToken: r.refreshToken ?? refreshToken,
        // No expiry in the backend response — persistTokens() defaults
        // to 3600s, the fixed Firebase ID-token lifetime.
        expiresIn: undefined,
        email: b[StorageKey.USER_EMAIL],
      });
      return r.idToken;
    })().finally(() => { _refreshInFlight = null; });
  }
  try {
    return await _refreshInFlight;
  } catch {
    throw new AuthError();
  }
}

/**
 * Authenticated fetch against the configured API base. Attaches a
 * fresh Firebase ID token; on a 401 it forces ONE token refresh and
 * retries once before giving up with AuthError (covers the narrow
 * window where the token expired between the freshness check and the
 * server clock).
 *
 * @param {string} path
 * @param {RequestInit} [init]
 * @param {boolean} [_retried] internal — prevents an infinite 401 loop
 */
async function request(path, init = {}, _retried = false) {
  const baseUrl = await apiBaseUrl();
  const token = await getFreshIdToken();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...authHeaders(token),
      ...(init.headers ?? {}),
    },
  });
  if (response.status === 401) {
    if (!_retried) {
      // Force-refresh once; getFreshIdToken throws AuthError if it
      // can't, which propagates (no pointless retry).
      const fresh = await getFreshIdToken({ force: true });
      if (fresh) return request(path, init, true);
    }
    throw new AuthError();
  }
  return response;
}

/**
 * Profile / auth-check. Hits the monolith's `/user/profile` — the
 * canonical user document (the standalone `/api/v1/me` was never
 * ported per account_routes.py). Exported under both names — `getMe`
 * kept as an alias so any caller written against the old name still
 * resolves.
 */
export async function getUserProfile() {
  const response = await request(ENDPOINTS.userProfile);
  if (!response.ok) throw new Error(`profile_failed_${response.status}`);
  return response.json();
}
export { getUserProfile as getMe };

/**
 * Subscription / feature gating. Returns the full features snapshot
 * from ``GET /subscription/get-features-info``. The extension reads
 * the ``external_platform`` sub-object to decide whether to enable
 * Recording / Live Transcription / Add Bot surfaces; other sub-
 * objects (languages, providers, …) are not used here but are
 * passed through verbatim so callers can plumb new feature flags
 * without touching this function.
 *
 * Throws on non-2xx so callers can distinguish a real failure from
 * a default-allow fallback.
 */
export async function getFeaturesInfo() {
  const response = await request(ENDPOINTS.featuresInfo);
  if (!response.ok) throw new Error(`features_info_failed_${response.status}`);
  return response.json();
}

/**
 * Fetch + persist the latest feature snapshot. Stores the full
 * response under ``StorageKey.FEATURES_INFO`` so the popup, options
 * page, and any other surface can read a consistent gate without
 * each one hitting the API independently. Best-effort: failures
 * leave the previous snapshot in place (default-allow on a fresh
 * install when nothing is cached, so a transient API hiccup never
 * blocks the user).
 *
 * Returns the snapshot on success, ``null`` on failure.
 */
export async function refreshFeaturesInfo() {
  try {
    const info = await getFeaturesInfo();
    if (info && typeof info === 'object') {
      await chrome.storage.local.set({
        [StorageKey.FEATURES_INFO]: info,
        [StorageKey.FEATURES_FETCHED_AT]: Date.now(),
      });
    }
    return info;
  } catch (_err) {
    // Best-effort — keep whatever's cached. The next periodic
    // refresh / auth event will retry.
    return null;
  }
}

/**
 * Fetch the backend display name and persist it under
 * ``StorageKey.USER_NAME``. The name is the canonical "what should we
 * call the signed-in user" — preferred over deriving from the email
 * local part by every UI surface (popup speaker fallback, control
 * window pill, live-transcribe overlay self-label).
 *
 * Best-effort: a failure (network blip, missing/null name field) is
 * swallowed and the storage key is left untouched so an existing value
 * isn't accidentally cleared. Called from the auth entry points
 * (login/register/oauth) and from the SW boot path as a backfill for
 * installs that signed in before this key existed.
 *
 * @returns {Promise<string | null>}
 */
export async function refreshUserName() {
  try {
    const profile = await getUserProfile();
    const name = typeof profile?.name === 'string' && profile.name.trim()
      ? profile.name.trim()
      : null;
    if (name) {
      await chrome.storage.local.set({ [StorageKey.USER_NAME]: name });
    }
    return name;
  } catch (_err) {
    // Best-effort. AuthError / network — caller has bigger problems
    // (the next /me will retry on the next SW wake / login).
    return null;
  }
}

// Auth is fully backend-mediated (BFF): the extension never calls
// Firebase or holds any key. `login()`/`register()` POST credentials
// to `/security/{login,signup}`; `authenticateWithProvider()` runs
// Google/Microsoft via the backend `/security/oauth/*` + PKCE. All
// surface a thrown error with .name='AuthApiError' + a stable .code
// the popup maps to a message:
//   email_taken | invalid_credentials | invalid_input |
//   rate_limited | cancelled | network | unknown
class AuthApiError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'AuthApiError';
    this.code = code;
  }
}

// Backend-mediated email/password (BFF) via the dedicated
// `/security/login` + `/security/signup` endpoints. The Firebase Web
// API key stays SERVER-SIDE — the shipped extension needs NO key
// (Bug 1). `/security/signup` performs the signup server-side and
// explicitly (no EMAIL_NOT_FOUND login-failure heuristic), so it
// works on Firebase projects with Email Enumeration Protection
// (Bug 2). Mirrors the desktop app's backend_login / backend_signup.

/**
 * Map a /security/{login,signup} response to the Firebase session
 * dict, or throw a coded AuthApiError (same taxonomy the popup maps).
 */
function _parseAuthResponse(status, data, { signup }) {
  if (status >= 200 && status < 300) {
    if (!data || !data.idToken || !data.refreshToken) {
      throw new AuthApiError('unknown', 'Server returned no session.');
    }
    return data;
  }
  if (status === 409) {
    throw new AuthApiError('email_taken', 'That email is already registered.');
  }
  if (status === 401 || status === 403) {
    // Friendlier than the raw "Unauthorized" the server may send back —
    // the popup surfaces this string directly in the auth-error row.
    throw new AuthApiError(
      'invalid_credentials',
      'Email or password is incorrect. Check your details and try again.',
    );
  }
  if (status === 422) {
    throw new AuthApiError('invalid_input', 'Please check the email and password.');
  }
  if (status === 429) {
    throw new AuthApiError('rate_limited', 'Too many attempts. Try again later.');
  }
  if (status === 503) {
    throw new AuthApiError('network', 'Service temporarily unavailable.');
  }
  throw new AuthApiError(
    'unknown', `${signup ? 'Sign-up' : 'Sign-in'} failed (${status}).`,
  );
}

async function _postAuth(path, body, { signup }) {
  let res;
  try {
    res = await fetch(`${await apiBaseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (_err) {
    throw new AuthApiError('network', 'Could not reach the server.');
  }
  const data = await res.json().catch(() => ({}));
  return _parseAuthResponse(res.status, data, { signup });
}

// POST /security/login {email,password} → Firebase session.
function backendLogin(email, password) {
  return _postAuth(ENDPOINTS.login, { email, password }, { signup: false });
}

// POST /security/signup {email,password,displayName} → Firebase
// session (backend creates the Firebase user + MeetMinutes record).
// displayName is required server-side (min 1) — fall back to email.
function backendSignup(email, password, displayName) {
  return _postAuth(
    ENDPOINTS.signup,
    { email, password, displayName: displayName || email },
    { signup: true },
  );
}

/**
 * Sign in an existing user — `POST /security/login`. The backend
 * performs the Firebase call server-side (no key in the extension)
 * and returns a session.
 *
 * @param {{ email: string, password: string }} body
 * @returns {Promise<{ token: string, email: string }>}
 */
export async function login({ email, password }) {
  const normalisedEmail = String(email).trim().toLowerCase();
  const d = await backendLogin(normalisedEmail, password);
  await persistTokens({
    idToken: d.idToken,
    refreshToken: d.refreshToken,
    // No expiry on the wire — persistTokens() defaults to 3600s.
    expiresIn: d.expiresIn,
    email: d.email || normalisedEmail,
  });
  // Best-effort: persist the backend display name so the UI surfaces
  // can render "Shubham Pilivkar" instead of the email-derived
  // "Shubhampilivkar". Never blocks signin.
  void refreshUserName();
  // Refresh the feature-gate snapshot too so the popup opens with
  // accurate gates instead of default-allow on first paint after
  // sign-in. Best-effort.
  void refreshFeaturesInfo();
  return { token: d.idToken, email: d.email || normalisedEmail };
}

/**
 * Create an account — `POST /security/signup`. Explicit server-side
 * signup (works with Email Enumeration Protection); the backend
 * creates the Firebase user + MeetMinutes record and returns a
 * session. `name` is the optional display name.
 *
 * @param {{ email: string, password: string, name?: string | null }} body
 * @returns {Promise<{ token: string, email: string }>}
 */
export async function register({ email, password, name }) {
  const normalisedEmail = String(email).trim().toLowerCase();
  const d = await backendSignup(
    normalisedEmail, password, name || normalisedEmail,
  );
  await persistTokens({
    idToken: d.idToken,
    refreshToken: d.refreshToken,
    expiresIn: d.expiresIn,
    email: d.email || normalisedEmail,
  });
  // Backend stores the displayName we just sent; mirror it locally so
  // every UI surface has the real name immediately (no
  // /user/profile round-trip race). Fall back to a /user/profile
  // fetch if the caller didn't supply one.
  if (name && name.trim()) {
    try {
      await chrome.storage.local.set({
        [StorageKey.USER_NAME]: name.trim(),
      });
    } catch (_err) { /* best-effort */ }
  } else {
    void refreshUserName();
  }
  void refreshFeaturesInfo();
  return { token: d.idToken, email: d.email || normalisedEmail };
}

/**
 * Back-compat single entry point: a `name` means signup, otherwise
 * login. (Kept for callers/tests that used the old combined fn; the
 * popup calls register()/login() directly by tab.)
 *
 * @param {{ email: string, password: string, name?: string | null }} body
 * @returns {Promise<{ token: string, email: string }>}
 */
export function authenticate(body) {
  return body && body.name
    ? register(body)
    : login({ email: body.email, password: body.password });
}

// --- Native social login (Google / Microsoft) — backend BFF + PKCE.
// The extension does NOT call Firebase or /security/social-signup.
// It runs the provider consent via chrome.identity.launchWebAuthFlow
// against a backend-built URL, then hands the auth code (+ PKCE
// verifier) to /security/oauth/exchange. The OAuth client id/secret
// and the Firebase key all stay SERVER-SIDE; the backend creates the
// user + returns a Firebase session. Mirrors the desktop loopback.

function _b64url(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 7636 S256: 32-byte random verifier (43-char base64url, within
// the backend's 43–128 bound) + its SHA-256 challenge.
async function generatePkce() {
  const rnd = new Uint8Array(32);
  crypto.getRandomValues(rnd);
  const verifier = _b64url(rnd);
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: _b64url(digest) };
}

/**
 * Native social login (Google / Microsoft), fully backend-mediated.
 * No client OAuth id/secret, no client Firebase key, no
 * /security/social-signup. PKCE → POST /security/oauth/authorize-url
 * → chrome.identity.launchWebAuthFlow (redirect
 * https://<id>.chromiumapp.org/) → POST /security/oauth/exchange →
 * Firebase session. MUST run in the service worker (launchWebAuthFlow
 * outlives the ephemeral popup).
 *
 * @param {'google'|'microsoft'} provider
 * @returns {Promise<{ token: string, email: string }>}
 */
export async function authenticateWithProvider(provider) {
  if (provider !== 'google' && provider !== 'microsoft') {
    throw new AuthApiError('invalid_input', 'Unsupported provider.');
  }
  const identity = (typeof chrome !== 'undefined' && chrome.identity) || null;
  if (!identity || typeof identity.launchWebAuthFlow !== 'function') {
    throw new AuthApiError('unknown', 'Social sign-in unavailable here.');
  }
  const redirectUri = identity.getRedirectURL();
  const base = await apiBaseUrl();
  const { verifier, challenge } = await generatePkce();

  // 1) Backend builds the provider consent URL (it owns the client
  //    id). We only send our PKCE challenge + the chromiumapp.org
  //    redirect (the backend allowlists that host).
  let r;
  try {
    r = await fetch(`${base}${ENDPOINTS.oauthAuthorizeUrl}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    });
  } catch (_err) {
    throw new AuthApiError('network', 'Could not reach the server.');
  }
  if (r.status === 503) {
    throw new AuthApiError('unknown', 'Social sign-in is not configured.');
  }
  if (!(r.status >= 200 && r.status < 300)) {
    throw new AuthApiError('unknown', `Could not start sign-in (${r.status}).`);
  }
  const a = await r.json().catch(() => ({}));
  const authUrl = a && a.authorization_url;
  const state = a && a.state;
  if (!authUrl || !state) {
    throw new AuthApiError('unknown', 'Malformed authorize response.');
  }

  // 2) Interactive consent; the provider redirects back to
  //    chromiumapp.org with ?code&state (backend uses
  //    response_type=code / response_mode=query → QUERY, not fragment).
  let redirected;
  try {
    redirected = await identity.launchWebAuthFlow({
      url: authUrl, interactive: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AuthApiError('cancelled', msg || 'Sign-in was cancelled.');
  }
  if (!redirected) {
    throw new AuthApiError('cancelled', 'Sign-in was cancelled.');
  }
  let qp;
  try {
    qp = new URL(redirected).searchParams;
  } catch {
    throw new AuthApiError('unknown', 'Bad redirect from provider.');
  }
  const oauthError = qp.get('error');
  if (oauthError) {
    const cancelled = oauthError === 'access_denied'
      || oauthError === 'user_cancelled';
    throw new AuthApiError(
      cancelled ? 'cancelled' : 'unknown',
      qp.get('error_description') || `Sign-in failed (${oauthError}).`,
    );
  }
  const code = qp.get('code');
  if (!code) {
    throw new AuthApiError('unknown', 'No authorization code returned.');
  }
  if (qp.get('state') !== state) {
    throw new AuthApiError('unknown', 'State mismatch — sign-in aborted.');
  }

  // 3) Backend exchanges code (+PKCE verifier) using the confidential
  //    client SECRET server-side and returns a Firebase session.
  let xr;
  try {
    xr = await fetch(`${base}${ENDPOINTS.oauthExchange}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
  } catch (_err) {
    throw new AuthApiError('network', 'Could not reach the server.');
  }
  if (xr.status === 503) {
    throw new AuthApiError('unknown', 'Social sign-in is not configured.');
  }
  const d = await xr.json().catch(() => ({}));
  if (!(xr.status >= 200 && xr.status < 300)) {
    throw new AuthApiError(
      xr.status === 401 ? 'invalid_credentials' : 'unknown',
      `Sign-in failed (${xr.status}).`,
    );
  }
  if (!d || !d.idToken || !d.refreshToken) {
    throw new AuthApiError('unknown', 'Sign-in did not return a session.');
  }
  const email = String(d.email || '').trim().toLowerCase();
  await persistTokens({
    idToken: d.idToken,
    refreshToken: d.refreshToken,
    expiresIn: d.expiresIn,
    email,
  });
  // Backend's OAuth exchange returns the provider's display name in
  // ``d.name`` (or ``d.displayName``); prefer that to skip a /me
  // round-trip. Fall back to a fetch when the field is absent.
  const oauthName = typeof d.name === 'string' && d.name.trim()
    ? d.name.trim()
    : (typeof d.displayName === 'string' && d.displayName.trim()
        ? d.displayName.trim()
        : null);
  if (oauthName) {
    try {
      await chrome.storage.local.set({ [StorageKey.USER_NAME]: oauthName });
    } catch (_err) { /* best-effort */ }
  } else {
    void refreshUserName();
  }
  void refreshFeaturesInfo();
  return { token: d.idToken, email };
}

/**
 * Sign out. There is no backend logout endpoint anymore (Firebase
 * sessions are client-side); just clear the local token bundle so the
 * UI returns to the signed-out state.
 *
 * @returns {Promise<void>}
 */
export async function logout() {
  try {
    await chrome.storage.local.remove([
      StorageKey.AUTH_TOKEN,
      StorageKey.REFRESH_TOKEN,
      StorageKey.TOKEN_EXPIRES_AT,
      StorageKey.USER_EMAIL,
      StorageKey.USER_NAME,
      // Feature snapshot is per-user; clearing on sign-out prevents
      // the next signed-in user from briefly seeing the previous
      // user's gates until their fresh /get-features-info round-trip
      // lands.
      StorageKey.FEATURES_INFO,
      StorageKey.FEATURES_FETCHED_AT,
    ]);
  } catch (_err) {
    // best-effort — storage may be unavailable in some contexts
  }
}

/**
 * Create a recording on the unified backend. Retries on 5xx and
 * network errors (up to 3 attempts, 1s/2s/4s backoff). 4xx fails fast
 * — deterministic (bad payload / expired token).
 *
 * Unified `POST /api/v1/recordings` (RecordingCreate, extra="forbid"):
 * the extension omits `recording_id` (server mints it), MUST send
 * `client_started_at` (required; also the anchor the backend uses to
 * normalise the speaker timeline), and may send an optional `name`.
 * The legacy `source`/`url` fields no longer exist server-side, so we
 * fold the meeting URL into `name` (≤512) for operator visibility.
 *
 * The response carries `recording_id`; we also expose it as
 * `meeting_id` so the SW's orphan-recovery / IDB code (which treats it
 * as an opaque session key) keeps working without churn.
 *
 * W4 — client-side idempotency: we mint the `recording_id` ourselves
 * and send it in the body. The backend dedupes by (recording_id,
 * user): a create whose 201 response was lost (network drop) is safe
 * to retry — the server returns 200 for the SAME recording instead of
 * minting a duplicate. The id is generated ONCE, before the retry
 * loop, so every internal 5xx/network retry reuses it. Callers may
 * also pass an explicit `recordingId` (e.g. a persisted one from
 * orphan recovery) to make the create idempotent across SW restarts.
 *
 * @param {{ url?: string, name?: string, isEncrypted?: boolean, recordingId?: string }} opts
 * @returns {Promise<{ recording_id: string, meeting_id: string, status: string, upload_url: string }>}
 */
export async function startMeeting(opts = {}) {
  const rawName = opts.name ?? opts.url ?? null;
  const recordingId = opts.recordingId || newIdempotencyKey();
  const payload = {
    recording_id: recordingId,
    client_started_at: new Date().toISOString(),
    is_encrypted: !!opts.isEncrypted,
    ...(rawName ? { name: String(rawName).slice(0, 512) } : {}),
  };
  let attempt = 0;
  let lastErr;
  while (attempt < START_RETRY_ATTEMPTS) {
    let response;
    try {
      response = await request(ENDPOINTS.startMeeting, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // AuthError is deterministic — bail without retrying.
      if (err instanceof AuthError) throw err;
      // Network-level errors (TypeError) are retryable.
      lastErr = err;
      attempt += 1;
      if (attempt >= START_RETRY_ATTEMPTS) break;
      await sleep(START_RETRY_BASE_MS * 2 ** (attempt - 1));
      continue;
    }
    // 201 created OR 200 idempotent — both carry the recording.
    if (response.ok) {
      const data = await response.json();
      return { ...data, meeting_id: data.recording_id };
    }
    if (response.status >= 400 && response.status < 500) {
      // 4xx — deterministic, fail fast. Throws OUT of the loop so the
      // catch-and-retry path doesn't see it.
      throw new Error(`start_failed_${response.status}`);
    }
    // 5xx — retry.
    lastErr = new Error(`start_failed_${response.status}`);
    attempt += 1;
    if (attempt >= START_RETRY_ATTEMPTS) break;
    await sleep(START_RETRY_BASE_MS * 2 ** (attempt - 1));
  }
  throw lastErr ?? new Error('start_failed_unknown');
}

/**
 * Upload one chunk. Unified API: the chunk index is a PATH segment
 * (`/api/v1/recordings/{id}/chunks/{idx}`) and the server dedupes by
 * (recording, index) — a same-index re-upload returns 200
 * `duplicate=true` (still `response.ok`, so the drain treats it as
 * success and advances). The old `chunk_index` / `is_final` /
 * `idempotency_key` form fields and the `X-Idempotency-Key` header no
 * longer exist server-side, so we send only the file part. `isFinal`
 * / `idempotencyKey` stay in the signature (the IDB drain still
 * supplies them) but are intentionally not put on the wire.
 *
 * @param {{ meetingId: string, blob: Blob, chunkIndex: number, isFinal: boolean, idempotencyKey: string, mimeType?: string }} args
 */
// The unified backend gates the chunk `file` part on a fixed
// content-type allowlist of BASE container types (no codecs param):
//   video/webm audio/webm video/mp4 audio/mp4 video/mp2t
//   audio/ogg audio/opus
// Two things break the naive `form.append('file', blob)`:
//   1. E2EE: encryptChunk() returns a Blob typed
//      `application/octet-stream` → 415 → the drain's poison-guard
//      permanently drops it → every encrypted recording silently
//      loses all data.
//   2. Plain recordings: the MediaRecorder blob's type carries a
//      `;codecs=…` suffix (e.g. `audio/webm;codecs=opus`) which an
//      exact base-type match would also reject.
// We always send the part under a normalised allowed type derived
// from the PRESERVED original recording mime (kept in the persisted
// chunk record even when the bytes are encrypted). The server stores
// chunk bytes opaquely and we don't send a sha256, so relabelling
// ciphertext with its original container type is safe.
const _ALLOWED_CHUNK_TYPES = new Set([
  'video/webm', 'audio/webm', 'video/mp4', 'audio/mp4',
  'video/mp2t', 'audio/ogg', 'audio/opus',
]);

/**
 * Map a (possibly codec-suffixed / encrypted / missing) recording
 * mime to a content-type the backend chunk allowlist accepts.
 * @param {string|undefined|null} mimeType  preserved original recorder mime
 * @returns {string}
 */
export function pickAllowedContentType(mimeType) {
  const raw = String(mimeType || '');
  const base = raw.split(';')[0].trim().toLowerCase();
  if (_ALLOWED_CHUNK_TYPES.has(base)) return base;
  // Unknown / 'application/octet-stream' (encrypted) / empty → fall
  // back to a permissive allowed container matching the media kind.
  return base.startsWith('audio/') ? 'audio/webm' : 'video/webm';
}

async function uploadChunkOnce({ meetingId, blob, chunkIndex, isFinal, idempotencyKey, mimeType, sha256 }) {
  void isFinal; void idempotencyKey; // no longer sent (URL idx + server dedupe)
  const contentType = pickAllowedContentType(mimeType);
  const ext = contentType.startsWith('audio/') ? 'opus.webm' : 'webm';
  const form = new FormData();
  // Wrap in a File so the multipart part carries the normalised
  // content-type (a Blob/File references the source bytes — no copy).
  const filePart = new File([blob], `chunk-${chunkIndex}.${ext}`, {
    type: contentType,
  });
  form.append('file', filePart);
  // W5 — integrity. Prefer the digest computed + persisted at
  // persistChunk time; recompute for legacy rows that predate it.
  // Omitted entirely if hashing is unavailable (field is optional —
  // a same-bytes re-upload still dedupes server-side via the index).
  const digest = sha256 || await sha256Hex(blob);
  if (digest) form.append('sha256', digest);

  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const response = await request(ENDPOINTS.chunks(meetingId, chunkIndex), {
    method: 'POST',
    body: form,
  });
  // Latency telemetry — sampled at 10% in normal flight to keep the
  // event volume manageable, then unconditionally on retry-success
  // (those are the latencies we actually care about). Effective
  // network type lets us slice p50/p95 by 4g/3g/wifi etc.
  const latencyMs = Math.round(
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
  );
  const conn = (typeof navigator !== 'undefined' && navigator.connection) || null;
  if (Math.random() < 0.1) {
    emitEvent(TELEMETRY_EVENT_NAMES.CHUNK_UPLOAD_LATENCY, {
      latencyMs,
      status: response.status,
      sizeBytes: blob.size,
      effectiveType: conn?.effectiveType ?? null,
      isFinal,
    });
  }
  // P5 — recognise the cumulative duration-cap rejection BEFORE the
  // generic 4xx path. Status 403 + the structured body produced by
  // ``app.recordings.recording.RecordingDurationExceeded`` becomes a
  // typed error so the drain can pivot to "limit reached" UX instead
  // of treating the chunk as poison.
  if (response.status === 403) {
    const capErr = await tryParseDurationCapError(response);
    if (capErr) throw capErr;
  }
  if (!response.ok) throw new Error(`chunk_upload_${response.status}`);
}

/**
 * Open a live-transcribe session on the backend. Returns the ws_url
 * (already includes ``sid`` + ``token`` query params) and metadata
 * the offscreen doc needs to bring up the WebSocket.
 *
 * The STT provider is decided server-side (env-controlled); the
 * client never selects a vendor and never sees which one ran the
 * session. Same for failover — server-armed when a compatible
 * second provider is configured.
 *
 * Surfaces backend-specific error codes through ``Error.code`` so the
 * popup can show actionable messages:
 *   - 401  → AuthError (token expired)
 *   - 422  → unsupported language for the configured backend
 *   - 429  → concurrency cap reached
 *   - 503  → no transcription provider configured server-side
 *   - other 4xx/5xx → generic transcribe_start_failed
 *
 * @param {{ mode: 'self'|'participants', language: string, source_hint?: string|null, parent_session_id?: string|null }} body
 * @returns {Promise<{ session_id: string, ws_url: string, ws_token: string, sample_rate: number, format: string }>}
 */
/**
 * Force the transcribe WebSocket URL onto the SAME host the extension
 * is configured to talk to (``API_BASE_URL`` — test-api.meetminutes.in
 * by default), with the matching secure scheme.
 *
 * The backend embeds an INTERNAL host in the ``ws_url`` it returns
 * (e.g. ``ws://localhost:9000/api/v1/transcribe/stream?sid=…``) which
 * a real browser can never reach. We keep the backend's path + query
 * (they carry the session id + token) and only swap scheme+host so
 * live transcription always connects to the public API endpoint.
 *
 * @param {string} backendWsUrl  ws_url as returned by the backend
 * @param {string} baseUrl       configured HTTP(S) API base
 * @returns {string}
 */
export function toPublicWsUrl(backendWsUrl, baseUrl) {
  try {
    const base = new URL(baseUrl);
    const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:';
    let path = '/api/v1/transcribe/stream';
    let search = '';
    try {
      const u = new URL(backendWsUrl, baseUrl);
      if (u.pathname) path = u.pathname;
      search = u.search || '';
    } catch {
      const s = String(backendWsUrl || '');
      const qi = s.indexOf('?');
      if (qi >= 0) search = s.slice(qi);
    }
    return `${scheme}//${base.host}${path}${search}`;
  } catch {
    return backendWsUrl;
  }
}

export async function startTranscribeSession(body) {
  const response = await request(ENDPOINTS.startTranscribeSession, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status === 422) {
    const err = new Error('transcribe_invalid_request');
    err.code = 'invalid_request';
    err.detail = await response.text();
    throw err;
  }
  if (response.status === 429) {
    const err = new Error('transcribe_concurrency_cap');
    err.code = 'concurrency_cap';
    throw err;
  }
  if (response.status === 503) {
    const err = new Error('transcribe_provider_unavailable');
    err.code = 'provider_unavailable';
    err.detail = await response.text();
    throw err;
  }
  if (!response.ok) {
    const err = new Error(`transcribe_start_failed_${response.status}`);
    err.code = 'unknown';
    throw err;
  }
  const data = await response.json();
  // Normalise the WS URL onto the configured public API host — the
  // backend returns an internal (localhost:9000) host the browser
  // can't reach. Covers BOTH the initial start and the SW reconnect
  // path (it re-calls this same function).
  if (data && typeof data.ws_url === 'string') {
    const { baseUrl } = await loadConfig();
    data.ws_url = toPublicWsUrl(data.ws_url, baseUrl);
  }
  return data;
}

/**
 * W2 — finalize raised a 409 the caller can act on. `missing` is the
 * (possibly empty) list of chunk indices the server still expects;
 * `terminal` is true for the un-recoverable 409/422 cases
 * (`no chunks uploaded`, declared-count disagreement) where retrying
 * is pointless and the recording should be abandoned, not orphan-
 * looped forever.
 */
export class FinalizeConflictError extends Error {
  /** @param {{ missing?: number[], terminal?: boolean, detail?: string }} info */
  constructor({ missing = [], terminal = false, detail = '' } = {}) {
    super(detail || (terminal ? 'finalize_terminal' : 'finalize_missing_chunks'));
    this.name = 'FinalizeConflictError';
    this.missing = Array.isArray(missing) ? missing : [];
    this.terminal = !!terminal;
    this.detail = detail;
  }
}

/**
 * Finalize a recording. Unified finalize takes a (required) JSON body;
 * the extension never pre-declares a count — it sends `{}` so the
 * server derives it from the highest uploaded index. 202 = accepted.
 *
 * W2 — a 409 is parsed instead of being a blind `finalize_failed_409`:
 *   - `{ detail:"missing chunks", missing:[3,7] }` → recoverable;
 *     thrown as FinalizeConflictError with `.missing` so the SW can
 *     re-drain exactly those indices and retry finalize ONCE.
 *   - `no chunks uploaded` / 422 count-disagreement → `.terminal=true`
 *     so the SW abandons the recording instead of orphan-looping.
 *
 * @param {string} meetingId
 */
export async function finalizeMeeting(meetingId) {
  const response = await request(ENDPOINTS.finalize(meetingId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (response.ok) return;
  if (response.status === 409 || response.status === 422) {
    let body = {};
    try { body = await response.json(); } catch { body = {}; }
    const detail = typeof body.detail === 'string' ? body.detail : '';
    const missing = Array.isArray(body.missing) ? body.missing : [];
    // Recoverable iff the server told us *which* chunks are missing.
    // Everything else at 409/422 (no chunks, count disagreement) is
    // terminal — retrying sends the identical request, same result.
    const terminal = missing.length === 0;
    throw new FinalizeConflictError({ missing, terminal, detail });
  }
  throw new Error(`finalize_failed_${response.status}`);
}

/**
 * W3 — `GET /api/v1/recordings/{id}/status`. Returns the raw status
 * envelope `{ status, uploaded_chunks, expected_chunks, final_url,
 * playlist_url, error, error_code }`. 404 → throws (unknown / deleted).
 *
 * @param {string} meetingId
 * @returns {Promise<{status:string, uploaded_chunks:number, expected_chunks:number, final_url:string|null, playlist_url:string|null, error:string|null, error_code:string|null}>}
 */
export async function getRecordingStatus(meetingId) {
  const response = await request(ENDPOINTS.recordingStatus(meetingId));
  if (!response.ok) throw new Error(`status_failed_${response.status}`);
  return response.json();
}

/**
 * Dispatch a Playwright bot to join a Google Meet / Microsoft Teams
 * meeting. The bot service drives a headless browser into the call
 * and records it server-side — the user's browser is uninvolved after
 * this POST returns.
 *
 * Failure handling mirrors the backend's error mapping:
 *   * 422 → invalid request (bad URL / unsupported platform / bot
 *     service refused). ``err.code = 'invalid_request'``.
 *   * 429 → rate-limited (10/min/IP). ``err.code = 'rate_limited'``.
 *   * 503 → bot service is offline / unreachable. ``err.code =
 *     'unavailable'``.
 *   * 401 → propagates AuthError (the request() helper handles this).
 *
 * @param {{ name: string, meeting_url: string, platform: 'google_meet' | 'ms_teams' }} body
 * @returns {Promise<{ bot_id: string, status: 'dispatched' | 'queued' }>}
 */
export async function dispatchBot(body) {
  const response = await request(ENDPOINTS.dispatchBot, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status === 202) {
    return response.json();
  }
  if (response.status === 422) {
    const err = new Error('bot_dispatch_invalid_request');
    err.code = 'invalid_request';
    err.detail = await response.text();
    throw err;
  }
  if (response.status === 429) {
    const err = new Error('bot_dispatch_rate_limited');
    err.code = 'rate_limited';
    throw err;
  }
  if (response.status === 503) {
    const err = new Error('bot_dispatch_unavailable');
    err.code = 'unavailable';
    err.detail = await response.text();
    throw err;
  }
  const err = new Error(`bot_dispatch_failed_${response.status}`);
  err.code = 'unknown';
  throw err;
}

/**
 * Persist a telemetry event to the buffer; the periodic flusher will
 * ship it. Buffering means events emitted before the backend endpoint
 * goes live aren't lost — the next successful flush sweeps the backlog.
 * Never blocks recording; never logs the auth token.
 *
 * The full allowlist lives in ``constants.js#TELEMETRY_EVENT_NAMES``.
 * Events not in the allowlist are dropped with a console.warn — same
 * cost as logging a typo, prevents the buffer from filling with junk.
 *
 * @param {string} name
 * @param {Record<string, unknown>} [payload]
 */
export function emitEvent(name, payload = {}) {
  if (!_ALLOWED_TELEMETRY_NAMES.has(name)) {
    // Dropping unknown events keeps telemetry signal-rate high and
    // forces additions to go through the central allowlist. A buffered
    // typo would otherwise flush forever.
    console.warn('[client] emitEvent dropped — unknown event name', name);
    return;
  }
  // Phase 0 — payload size cap. The allowlist gates the event NAME but
  // the payload is opaque JSON; a caller that accidentally stuffs a
  // large blob (a stack trace, a serialized MediaStream, a transcript
  // chunk) would bloat IDB and the events POST. 1 KiB is generous for
  // the diagnostic key/value pairs every allowed event actually emits.
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch (err) {
    console.warn('[client] emitEvent dropped — unserializable payload', name, err);
    return;
  }
  if (serialized.length > 1024) {
    console.warn(
      '[client] emitEvent dropped — payload too large',
      name,
      serialized.length,
    );
    return;
  }
  void (async () => {
    try {
      await bufferTelemetry(name, payload, Date.now());
    } catch (err) {
      console.warn('[client] emitEvent buffer failed (event dropped)', err);
    }
  })();
}

/**
 * Single telemetry POST — used by the buffer's flusher. Surfaces
 * 404/501 so the buffer can keep events around until the endpoint is
 * deployed.
 *
 * @param {{ name: string, payload: Record<string, unknown>, ts: number }} event
 */
export async function postEvent(event) {
  const response = await request(ENDPOINTS.events, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (response.status === 404 || response.status === 501) {
    throw new Error(`events_unimplemented_${response.status}`);
  }
  if (!response.ok) throw new Error(`events_failed_${response.status}`);
}

/**
 * W8 — record ONE per-recording lifecycle event (doc §2.13:
 * `POST /api/v1/recordings/{rid}/events`). Pure server-side
 * observability / recovery aid — it must NEVER affect the recording,
 * so this is best-effort and self-contained: it swallows every error
 * (auth, 404 unknown recording, network, 5xx) and resolves to a
 * boolean instead of throwing. Not buffered: a lost lifecycle marker
 * is acceptable; persisting them would add an IDB store for no user
 * value. `event_ts` is stamped client-side at call time so a delayed
 * POST still reports when the event actually happened.
 *
 * @param {string} meetingId
 * @param {string} eventType  free-form, ≤64 (e.g. START_RECORDING)
 * @param {{ eventId?: string, eventTs?: string }} [opts]
 * @returns {Promise<boolean>} true iff the backend accepted it (2xx)
 */
export async function postRecordingEvent(meetingId, eventType, opts = {}) {
  try {
    if (!meetingId || !eventType) return false;
    const body = {
      event_type: String(eventType).slice(0, 64),
      event_ts: opts.eventTs || new Date().toISOString(),
    };
    if (opts.eventId) body.event_id = String(opts.eventId).slice(0, 256);
    const response = await request(ENDPOINTS.recordingEvents(meetingId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    // AuthError / network / anything — observability is never allowed
    // to surface as a recording failure.
    return false;
  }
}

/** @param {Array<import('../constants.js').TimelineEvent>} events */
export async function postTimeline(meetingId, events) {
  const response = await request(ENDPOINTS.timeline(meetingId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  if (response.status === 404 || response.status === 501) {
    throw new Error(`timeline_unimplemented_${response.status}`);
  }
  if (!response.ok) throw new Error(`timeline_failed_${response.status}`);
}

// ----- IndexedDB ------------------------------------------------------------
//
// Two stores in one DB:
//   chunks   — pending uploads
//   meetings — metadata so we can recover orphaned (un-finalized)
//              recordings after the SW or whole browser restarts.

/** @returns {Promise<IDBDatabase>} */
function openDbOnce() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CHUNK_DB_NAME, CHUNK_DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const store = db.createObjectStore(CHUNK_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('byMeeting', 'meetingId', { unique: false });
      }
      if (!db.objectStoreNames.contains(MEETINGS_STORE)) {
        db.createObjectStore(MEETINGS_STORE, { keyPath: 'meetingId' });
      }
      // v3 — backfill idempotencyKey on every existing chunk row. Runs
      // exactly once per browser profile when the SW first updates from
      // an older install.
      if (event.oldVersion < 3 && tx) {
        const store = tx.objectStore(CHUNK_STORE);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const record = cursor.value;
          if (!record.idempotencyKey) {
            record.idempotencyKey = newIdempotencyKey();
            cursor.update(record);
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Cached connection — opened once per SW lifetime. Closed/invalidated
// on versionchange (another tab upgraded) or unexpected close.
/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = openDbOnce()
      .then((db) => {
        db.onversionchange = () => {
          try { db.close(); } catch { /* already closed */ }
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        return db;
      })
      .catch((err) => {
        dbPromise = null;
        throw err;
      });
  }
  return dbPromise;
}

/** @param {{ meetingId: string, chunkIndex: number, isFinal: boolean, blob: Blob, mimeType?: string }} record */
export async function persistChunk(record) {
  // W5 — hash the exact bytes ONCE here (before the sync IDB tx) so
  // every later retry of this chunk reuses the same digest instead of
  // re-hashing. Best-effort: a null digest just means the upload sends
  // no sha256 (still dedupe-safe via the server's (rec,idx) index).
  const sha256 = await sha256Hex(record.blob);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readwrite');
    const store = tx.objectStore(CHUNK_STORE);
    // Generate the idempotency key here, at first persistence. From this
    // point on, every retry of this chunk uses the same key — server
    // dedupes if it sees it twice.
    const req = store.add({
      ...record,
      idempotencyKey: newIdempotencyKey(),
      sha256,
      createdAt: Date.now(),
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @param {string} meetingId */
export async function listPendingChunks(meetingId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const store = tx.objectStore(CHUNK_STORE);
    const index = store.index('byMeeting');
    const req = index.getAll(meetingId);
    req.onsuccess = () => {
      const records = req.result ?? [];
      records.sort((a, b) => a.chunkIndex - b.chunkIndex);
      resolve(records);
    };
    req.onerror = () => reject(req.error);
  });
}

/** @param {number} id */
async function deleteChunk(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readwrite');
    tx.objectStore(CHUNK_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Bug 6.1 — delete EVERY pending chunk for a given meeting in one
 * IDB transaction. Used when the server has terminally rejected the
 * recording (duration cap hit): the remaining queued chunks would
 * just retry against a closed recording, 403 each time, get deleted
 * one-by-one across multiple SW wakes. Purging the whole queue
 * up-front skips that wasteful loop.
 *
 * Returns the number of rows deleted (useful for telemetry).
 * Best-effort: any per-row error is swallowed so a single bad row
 * doesn't block the rest of the purge.
 *
 * @param {string} meetingId
 * @returns {Promise<number>}
 */
async function purgeAllPendingForMeeting(meetingId) {
  if (!meetingId) return 0;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readwrite');
    const store = tx.objectStore(CHUNK_STORE);
    const index = store.index('byMeeting');
    const req = index.openCursor(meetingId);
    let deleted = 0;
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        try {
          cursor.delete();
          deleted += 1;
        } catch { /* per-row; keep iterating */ }
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve(deleted);
    tx.onerror = () => reject(tx.error);
  });
}

export async function pendingChunkCount(meetingId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const store = tx.objectStore(CHUNK_STORE);
    const req = meetingId
      ? store.index('byMeeting').count(meetingId)
      : store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ----- meetings store -------------------------------------------------------

/**
 * Record meeting metadata so we can recover after a crash. Called from
 * the SW once startMeeting succeeds.
 *
 * @param {{ meetingId: string, source: string, url: string }} record
 */
export async function recordMeeting(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEETINGS_STORE, 'readwrite');
    tx.objectStore(MEETINGS_STORE).put({
      ...record,
      createdAt: Date.now(),
      finalized: false,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** @param {string} meetingId */
export async function markMeetingFinalized(meetingId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEETINGS_STORE, 'readwrite');
    const store = tx.objectStore(MEETINGS_STORE);
    const get = store.get(meetingId);
    get.onsuccess = () => {
      const existing = get.result;
      if (!existing) {
        // If we never recorded the meeting (older sessions), insert a
        // tombstone so we don't try to recover it again.
        store.put({ meetingId, finalized: true, createdAt: Date.now() });
      } else {
        store.put({ ...existing, finalized: true });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** @returns {Promise<Array<{ meetingId: string, source?: string, url?: string, createdAt: number, finalized: boolean }>>} */
export async function listUnfinalizedMeetings() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEETINGS_STORE, 'readonly');
    const req = tx.objectStore(MEETINGS_STORE).getAll();
    req.onsuccess = () => {
      const all = req.result ?? [];
      resolve(all.filter((m) => !m.finalized));
    };
    req.onerror = () => reject(req.error);
  });
}

// ----- network gating -------------------------------------------------------

/**
 * Resolve when the browser reports it's online. If already online,
 * resolves immediately. Used inside the drain pump so we don't burn
 * CPU and log noise hammering a known-down network.
 */
function waitForOnline() {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const handler = () => {
      self.removeEventListener('online', handler);
      resolve();
    };
    self.addEventListener('online', handler);
  });
}

// ----- drain pump -----------------------------------------------------------

// Per-meeting in-flight drain promise. The MV3 service worker can
// invoke drainChunkQueue from several places near-simultaneously — the
// periodic-sync alarm, the OFFSCREEN_CHUNK_PERSISTED handler, and the
// orphan-recovery sweep. Two pumps on the same meeting would both pull
// pending[0], double-upload it (the backend dedupes by
// (session_id, chunk_index) so no corruption, but it wastes bandwidth
// and the second pump's failed dedupe upload trips the retry backoff).
// Coalesce: concurrent callers for the same meetingId await the single
// running pump instead of starting their own.
const _drainInFlight = new Map();

/**
 * Drain the chunk queue for a meeting. Concurrent calls for the same
 * meetingId share one underlying pump (see `_drainInFlight`).
 *
 * @param {{
 *   meetingId: string,
 *   shouldContinue: () => boolean,
 *   onProgress?: (depth: number) => void | Promise<void>,
 *   onAuthLost?: () => void | Promise<void>,
 *   onCapExceeded?: (info: { capSeconds: number, consumedSeconds: number }) => void | Promise<void>
 * }} args
 */
export function drainChunkQueue(args) {
  const { meetingId } = args;
  const existing = _drainInFlight.get(meetingId);
  if (existing) return existing;
  const p = (async () => {
    try {
      return await _drainChunkQueueImpl(args);
    } finally {
      _drainInFlight.delete(meetingId);
    }
  })();
  _drainInFlight.set(meetingId, p);
  return p;
}

/**
 * Drain the chunk queue for a meeting. Backoff doubles 1s -> 2s -> ...,
 * capped at UPLOAD_BACKOFF_MAX_MS. Returns when the queue is empty OR
 * `shouldContinue` returns false (e.g. recording stopped + state moved
 * to ERROR or NEEDS_REAUTH).
 *
 * @param {{ meetingId: string, shouldContinue: () => boolean, onProgress?: (depth: number) => void | Promise<void>, onAuthLost?: () => void | Promise<void> }} args
 */
async function _drainChunkQueueImpl({ meetingId, shouldContinue, onProgress, onAuthLost, onCapExceeded }) {
  let backoff = 1_000;
  let emittedMaxBackoff = false;
  while (shouldContinue()) {
    await waitForOnline();
    const pending = await listPendingChunks(meetingId);
    if (onProgress) await onProgress(pending.length);
    if (pending.length === 0) return;

    const record = pending[0];
    try {
      // Defensive: pre-v3 rows that escaped the migration would lack a
      // key. Mint one in-memory so the upload still works, even if it's
      // not persisted. Real migration runs on next openDbOnce() cycle.
      const idempotencyKey = record.idempotencyKey ?? newIdempotencyKey();
      await uploadChunkOnce({
        meetingId,
        blob: record.blob,
        chunkIndex: record.chunkIndex,
        isFinal: record.isFinal,
        idempotencyKey,
        mimeType: record.mimeType,
        // Legacy rows (persisted before W5) have no sha256 — undefined
        // makes uploadChunkOnce recompute from the blob.
        sha256: record.sha256,
      });
      await deleteChunk(record.id);
      backoff = 1_000;
      emittedMaxBackoff = false;
    } catch (err) {
      if (err instanceof AuthError) {
        emitEvent('auth_lost', { meetingId });
        if (onAuthLost) await onAuthLost();
        return;
      }
      // P5 — cumulative duration cap was reached on the server side.
      // Stop draining (the server will reject every subsequent chunk
      // with the same 403) and route to the cap UX. The backend has
      // truncated the recording at the cap so the local pending rows
      // are orphan bytes — Bug 6.1: purge the WHOLE remaining queue
      // (not just the rejected row) so SW restarts / orphan-recovery
      // don't keep cycling 403 → delete → 403 → delete across wakes.
      if (err instanceof RecordingDurationExceededError) {
        let purgedCount = 0;
        try {
          purgedCount = await purgeAllPendingForMeeting(meetingId);
        } catch (purgeErr) {
          // Fall back to deleting JUST the rejected row so we at
          // least make forward progress if the bulk purge failed.
          try { await deleteChunk(record.id); } catch { /* */ }
          purgedCount = 1;
          console.warn('[client] cap-exceeded purge failed', purgeErr);
        }
        emitEvent('chunk_dropped_duration_cap', {
          meetingId,
          chunkIndex: record.chunkIndex,
          purgedCount,
          capSeconds: err.capSeconds,
          consumedSeconds: err.consumedSeconds,
        });
        if (onCapExceeded) {
          await onCapExceeded({
            capSeconds: err.capSeconds,
            consumedSeconds: err.consumedSeconds,
          });
        }
        return;
      }
      // Poison-chunk guard: a DETERMINISTIC client rejection (bad
      // request / too large / unsupported type / unprocessable) will
      // fail identically on every retry. Retrying it forever parks
      // the pump on pending[0] permanently — every LATER chunk is
      // blocked and the recording can never finalize. Drop the
      // poisoned chunk (emit telemetry first) so the queue head
      // advances; a missing 20s segment is far better than a
      // permanently wedged recording. 408/429 stay transient.
      const m = err instanceof Error
        && /^chunk_upload_(\d{3})$/.exec(err.message);
      const status = m ? Number(m[1]) : 0;
      const poison = status === 400 || status === 413
        || status === 415 || status === 422;
      if (poison) {
        emitEvent('chunk_dropped_poison', {
          meetingId, chunkIndex: record.chunkIndex, status,
        });
        console.error(
          `[client] chunk ${record.chunkIndex} permanently rejected `
          + `(${status}); dropping so the queue can progress`, err,
        );
        try { await deleteChunk(record.id); } catch { /* best-effort */ }
        backoff = 1_000;
        emittedMaxBackoff = false;
        continue;
      }
      console.warn(`[client] chunk ${record.chunkIndex} failed; retry in ${backoff}ms`, err);
      await sleep(backoff);
      const previous = backoff;
      backoff = Math.min(backoff * 2, UPLOAD_BACKOFF_MAX_MS);
      if (backoff === UPLOAD_BACKOFF_MAX_MS && previous !== UPLOAD_BACKOFF_MAX_MS && !emittedMaxBackoff) {
        emittedMaxBackoff = true;
        const errMsg = err instanceof Error ? err.message : String(err);
        emitEvent('chunk_retry_max_backoff', { meetingId, error: errMsg });
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { AuthError, purgeAllPendingForMeeting };
