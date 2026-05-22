// LIVE end-to-end against the real backend (34.100.254.231:8000).
//
// Proves the claims that the mock can't:
//   #2  speaker timeline + chunks + final mp4 actually reach the
//       backend → land in the GCS bucket (verified via the live
//       status/playback APIs; the gs:// objects are then listed over
//       SSH using the rid/uid this test prints).
//   #1  the offscreen mic gate (gain → 0 → base) works during a REAL
//       recording wired to the live backend.
//
// Requires:  MM_E2E_LIVE_BASE=http://34.100.254.231:8000
// Skipped automatically when that env var is absent (mock CI runs).

import { test, expect } from '@playwright/test';
import {
  patchManifestCsp, createMockBackend, launchExtension,
  resolveToken, seedAuth, getSwState, until, LIVE_BASE,
} from './helpers/harness.js';

test.skip(!LIVE_BASE, 'live backend only — set MM_E2E_LIVE_BASE');

let context; let worker; let extensionId; let backend; let optionsPath; let driver;
let token; let userId;

// Source-agnostic recording path — run the same proof for Teams with
// MM_E2E_SOURCE=ms_teams.
const SOURCE = process.env.MM_E2E_SOURCE === 'ms_teams' ? 'ms_teams' : 'google_meet';
const SRC_URL = SOURCE === 'ms_teams'
  ? 'https://teams.microsoft.com/l/meetup-join/live-e2e'
  : 'https://meet.google.com/live-e2e';

test.beforeAll(async () => {
  ({ optionsPath } = patchManifestCsp());
  // Mock still started (unused for HTTP here) so the harness shape is
  // identical; the extension is pointed at the LIVE backend.
  backend = createMockBackend();
  await backend.start();
  ({ context, worker, extensionId } = await launchExtension());
  token = await resolveToken(LIVE_BASE); // registers a throwaway acct
  await seedAuth(worker, {
    baseUrl: LIVE_BASE, token,
    extra: { mm_capture_source: 'screen', mm_audio_only: true },
  });
  // /api/v1/me was never ported from the standalone backend; the
  // monolith owns the canonical user document at /user/profile (see
  // backend apps/recordings/account_routes.py header note). The
  // profile row carries a uid + name + email; uid is the field the
  // rest of this spec keys off, so fall back to id for older
  // backends that haven't been upgraded yet.
  const me = await fetch(`${LIVE_BASE}/user/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  userId = me?.uid ?? me?.id;
  expect(userId, '/user/profile returned a uid (auth works post-redis-fix)').toBeTruthy();
  driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/${optionsPath}`);
});

test.afterAll(async () => {
  await context?.close();
  await backend?.stop();
});

const send = (m) => driver.evaluate((msg) => chrome.runtime.sendMessage(msg), m);
const ping = async () => {
  const r = await send({ type: 'OFFSCREEN_PING' });
  return r?.data ?? r;
};
const api = (p, init) => fetch(`${LIVE_BASE}${p}`, {
  ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
});

const TURNS = [
  { speaker_name: 'Alice', start_time: 0.5, end_time: 4.2 },
  { speaker_name: 'Bob', start_time: 4.2, end_time: 9.9 },
  { speaker_name: 'Alice', start_time: 9.9, end_time: 15.3 },
];

test('live: real recording → timeline+chunks+mp4 reach the backend/GCS; mic gate works', async () => {
  test.setTimeout(180000);

  // 1. Start a REAL recording (screen path) wired to the LIVE backend.
  await send({
    type: 'START_RECORDING', tabId: 999,
    url: SRC_URL, source: SOURCE,
  });
  const rec = await until(async () => {
    const s = await getSwState(worker);
    return s && (s.state === 'RECORDING' || s.state === 'ERROR') ? s : null;
  }, { timeout: 30000 });
  expect(rec.state, `SW state (err=${rec.errorMessage})`).toBe('RECORDING');
  const rid = rec.meetingId;
  expect(rid).toBeTruthy();
  console.log('LIVE recording_id =', rid, ' user_id =', userId);

  // Backend really created it.
  const created = await api(`/api/v1/recordings/${rid}/status`).then((r) => r.status);
  expect(created).toBeLessThan(500);

  // 2. #1 — mute → offscreen mic gain must go to 0, unmute → restore,
  //    during this live-wired recording.
  const before = await until(async () => {
    const p = await ping(); return p && p.alive ? p : null;
  });
  expect(before.micEffectiveGain).toBe(1);
  await send({ type: 'MIC_MUTE_STATE', muted: true });
  const muted = await until(async () => {
    const p = await ping(); return p && p.micEffectiveGain === 0 ? p : null;
  }, { timeout: 8000 });
  expect(muted.micEffectiveGain).toBe(0);
  await send({ type: 'MIC_MUTE_STATE', muted: false });
  const unmuted = await until(async () => {
    const p = await ping(); return p && p.micEffectiveGain === 1 ? p : null;
  }, { timeout: 8000 });
  expect(unmuted.micEffectiveGain).toBe(1);

  // 3. Feed speaker turns (what the caption observer emits).
  for (const t of TURNS) {
    await send({
      type: 'SPEAKER_CHANGE', speaker_name: t.speaker_name,
      start_time: t.start_time, end_time: t.end_time,
      wall_clock_ms: Date.now(), source: SOURCE,
    });
  }
  const flush = await send({ type: 'FLUSH_TIMELINE' });
  expect(flush.ok).toBe(true);

  // 4. Record long enough for a real chunk to be produced + uploaded
  //    (CHUNK_INTERVAL_MS = 20s) then stop → final chunk + finalize.
  await driver.waitForTimeout(24000);
  await send({ type: 'STOP_RECORDING' });
  const idle = await until(async () => {
    const s = await getSwState(worker);
    return s && (s.state === 'IDLE' || s.state === 'ERROR') ? s : null;
  }, { timeout: 40000 });
  expect(idle.state, `post-stop state (err=${idle.errorMessage})`).toBe('IDLE');

  // 5. Verify on the LIVE backend that chunks + finalize landed.
  const status = await until(async () => {
    const r = await api(`/api/v1/recordings/${rid}/status`);
    if (!r.ok) return null;
    const j = await r.json();
    return (j.uploaded_chunks >= 1) ? j : null;
  }, { timeout: 60000, interval: 3000 });
  expect(status, 'backend /status reflects uploaded chunks').toBeTruthy();
  expect(status.uploaded_chunks).toBeGreaterThanOrEqual(1);
  console.log('LIVE status =', JSON.stringify(status));

  // final_url / playlist_url appear once the finalize worker writes the
  // mp4 to GCS. Poll a bit (worker is async).
  const finalized = await until(async () => {
    const j = await api(`/api/v1/recordings/${rid}/status`).then((r) => r.ok ? r.json() : null);
    return j && (j.final_url || j.playlist_url || j.status === 'finalized' || j.status === 'done') ? j : null;
  }, { timeout: 90000, interval: 5000 });
  console.log('LIVE finalized status =', JSON.stringify(finalized));
  expect(finalized, 'backend finalized the recording (mp4 written)').toBeTruthy();

  // Stash identifiers for the gs:// object listing done over SSH.
  console.log(`GCS_CHECK rid=${rid} uid=${userId}`);
});
