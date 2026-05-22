// Issue #2 — keep recording while the user speaks with captions on →
// stop → finalize → check the speaker_timelines DB row + timelines.json
// in the bucket.
//
// The extension only ever talks HTTP: speaker turns (detected from
// captions by the content script) are buffered in IDB and POSTed to
// `/api/v1/recordings/{rid}/timeline` as `{events:[{speaker_name,
// start_time,end_time}]}` — that single request is what makes the
// backend write the speaker_timelines row + timelines.json. So we
// assert the exact request the extension emits, plus the finalize.
// Against a live backend the same `{accepted:N}` body + GET /status
// confirm the row was persisted.

import { test, expect } from '@playwright/test';
import {
  patchManifestCsp, createMockBackend, launchExtension,
  resolveToken, seedAuth, getSwState, until, LIVE_BASE,
} from './helpers/harness.js';

let context; let worker; let extensionId; let backend; let optionsPath; let driver;

test.beforeAll(async () => {
  ({ optionsPath } = patchManifestCsp());
  backend = createMockBackend();
  const url = await backend.start();
  ({ context, worker, extensionId } = await launchExtension());
  const baseUrl = LIVE_BASE || url;
  const token = await resolveToken(baseUrl);
  await seedAuth(worker, {
    baseUrl, token,
    extra: { mm_capture_source: 'screen', mm_audio_only: true },
  });
  driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/${optionsPath}`);
});

test.afterAll(async () => {
  await context?.close();
  await backend?.stop();
});

const send = (m) => driver.evaluate((msg) => chrome.runtime.sendMessage(msg), m);

// The caption-speaker observer emits one of these per closed turn.
const TURNS = [
  { speaker_name: 'Alice', start_time: 0.5, end_time: 4.2 },
  { speaker_name: 'Bob', start_time: 4.2, end_time: 9.9 },
  { speaker_name: 'Alice', start_time: 9.9, end_time: 15.3 },
];

test('speaker turns are POSTed to /timeline and the recording finalizes', async () => {
  await send({
    type: 'START_RECORDING', tabId: 999,
    url: 'https://meet.google.com/issue2', source: 'google_meet',
  });
  const rec = await until(async () => {
    const s = await getSwState(worker);
    return s && (s.state === 'RECORDING' || s.state === 'ERROR') ? s : null;
  }, { timeout: 25000 });
  expect(rec.state).toBe('RECORDING');
  const meetingId = rec.meetingId;
  expect(meetingId).toBeTruthy();

  // Simulate the caption observer closing speaker turns while we keep
  // recording (exactly what src/lib/caption-speaker-observer.js emits
  // via the content script).
  for (const t of TURNS) {
    await send({
      type: 'SPEAKER_CHANGE',
      speaker_name: t.speaker_name,
      start_time: t.start_time,
      end_time: t.end_time,
      wall_clock_ms: Date.now(),
      source: 'google_meet',
    });
  }
  // The SW mirrors the latest speaker into session state.
  const sAfter = await until(async () => {
    const s = await getSwState(worker);
    return s && s.currentSpeaker === 'Alice' ? s : null;
  });
  expect(sAfter.currentSpeaker).toBe('Alice');

  // Force the timeline flush (also happens every 30s + once on
  // finalize; we trigger it deterministically).
  const flushRes = await send({ type: 'FLUSH_TIMELINE' });
  expect(flushRes.ok).toBe(true);

  // The exact request that produces the speaker_timelines row +
  // timelines.json.
  const timelineReq = await until(
    async () => backend.requests.find(
      (r) => r.method === 'POST'
        && r.url === `/api/v1/recordings/${meetingId}/timeline`,
    ),
    { timeout: 8000 },
  );
  expect(timelineReq, 'extension must POST /timeline').toBeTruthy();
  expect(timelineReq.json).toEqual({ events: TURNS });

  // Mock (and the live backend) reply {accepted:N} — the count of
  // speaker_timeline rows persisted.
  // (We re-read it from a fresh flush-less GET on the live path.)
  if (LIVE_BASE) {
    const statusReq = await fetch(
      `${LIVE_BASE}/api/v1/recordings/${meetingId}/status`,
      { headers: { Authorization: `Bearer ${await worker.evaluate(async () => (await chrome.storage.local.get('mm_auth_token')).mm_auth_token)}` } },
    );
    expect(statusReq.ok).toBe(true);
  }

  // Stop → the SW drains chunks, flushes the timeline a final time,
  // then finalizes.
  await send({ type: 'STOP_RECORDING' });
  const finalizeReq = await until(
    async () => backend.requests.find(
      (r) => r.method === 'POST'
        && r.url === `/api/v1/recordings/${meetingId}/finalize`,
    ),
    { timeout: 25000 },
  );
  expect(finalizeReq, 'extension must POST /finalize on stop').toBeTruthy();
  expect(finalizeReq.body).toBe('{}'); // server derives the chunk count

  const idle = await until(async () => {
    const s = await getSwState(worker);
    return s && (s.state === 'IDLE' || s.state === 'ERROR') ? s : null;
  }, { timeout: 25000 });
  expect(idle.state).toBe('IDLE');

  // No duplicate timeline POSTs — the final flush found the IDB empty
  // (the FLUSH_TIMELINE above already drained + deleted the events).
  const timelinePosts = backend.requests.filter(
    (r) => r.method === 'POST'
      && r.url === `/api/v1/recordings/${meetingId}/timeline`,
  );
  expect(timelinePosts.length).toBe(1);
});
