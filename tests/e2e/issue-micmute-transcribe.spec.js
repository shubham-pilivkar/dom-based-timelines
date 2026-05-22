// Repro for the user's report: "I'm on mute but my audio still passes to
// live transcription and shows in the popup, in BOTH modes."
//
// Two things must happen the moment the user mutes their in-meeting mic
// while live transcription runs:
//   (1) PUMP GATE — the offscreen mic substream must STOP sending audio
//       frames to the backend (binaryFramesReceived stops growing on the
//       'mic' WS connection). TAB substream keeps flowing.
//   (2) OVERLAY SUPPRESSION — a mic-origin final must NOT render in the
//       overlay while muted; a tab-origin final still renders. On unmute
//       the mic substream resumes both ways.
//
// Same headless seams as issue3 (synthetic capture + open shadow + mock
// WS relay), so the real offscreen → SW → overlay routing is exercised.

import { test, expect } from '@playwright/test';
import {
  patchManifestCsp, createMockBackend, launchExtension,
  resolveToken, seedAuth, getTranscribeState, until, LIVE_BASE,
} from './helpers/harness.js';

const MEET_URL = 'https://meet.google.com/hft-umov-kop';

let context; let worker; let extensionId; let backend; let meetPage; let driver;
let meetTabId; let optionsPath;

test.beforeAll(async () => {
  ({ optionsPath } = patchManifestCsp());
  backend = createMockBackend();
  const url = await backend.start();
  ({ context, worker, extensionId } = await launchExtension());
  const baseUrl = LIVE_BASE || url;
  const token = await resolveToken(baseUrl);
  await seedAuth(worker, {
    baseUrl, token,
    extra: {
      mm_e2e_synthetic_capture: true,
      mm_e2e_open_shadow: true,
      mm_user_email: 'e2e@example.com',
    },
  });
  await worker.evaluate(() => {
    chrome.tabCapture.getMediaStreamId = (_opts, cb) => cb('e2e-fake-stream');
  });
  meetPage = await context.newPage();
  await meetPage.goto(MEET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  meetTabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.includes('meet.google.com'));
    return t ? t.id : null;
  });
  expect(meetTabId, 'meeting tab id').toBeTruthy();
  driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/${optionsPath}`);
});

test.afterAll(async () => {
  await context?.close();
  await backend?.stop();
});

const send = (m) => driver.evaluate((msg) => chrome.runtime.sendMessage(msg), m);
const roleOf = (conn) => (backend.sessionModeBySid[conn.sid] === 'self' ? 'mic' : 'tab');
const waitForConn = (role) => until(
  async () => backend.wsConnections.find((c) => !c.closed && roleOf(c) === role),
  { timeout: 15000 },
);
async function renderedTurns() {
  return meetPage.evaluate(() => {
    const host = document.getElementById('meetminutes-transcribe-root');
    if (!host || !host.shadowRoot) return null;
    return [...host.shadowRoot.querySelectorAll('.finals .turn')].map((t) => ({
      speaker: t.querySelector('.speaker')?.textContent || '',
      text: t.textContent || '',
      mic: t.classList.contains('turn-mic'),
    }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Mode 3 (both): muting the in-meeting mic gates the mic substream (pump + overlay)', async () => {
  test.setTimeout(60000);
  backend.reset();
  await send({
    type: 'START_TRANSCRIBE', mode: 'both', language: 'en',
    tabId: meetTabId, url: MEET_URL,
  });
  const micConn = await waitForConn('mic');
  const tabConn = await waitForConn('tab');
  expect(micConn && tabConn, 'both substreams connected').toBeTruthy();

  const active = await until(async () => {
    const s = await getTranscribeState(worker);
    return s && s.state === 'ACTIVE' ? s : null;
  }, { timeout: 15000 });
  expect(active.state).toBe('ACTIVE');
  await until(async () => (await renderedTurns()) !== null, { timeout: 8000 });

  // (1a) Baseline: the mic substream is sending audio frames upstream.
  const micFlowing = await until(async () => {
    const start = micConn.binaryFramesReceived;
    await sleep(700);
    return micConn.binaryFramesReceived > start ? micConn.binaryFramesReceived : null;
  }, { timeout: 10000 });
  expect(micFlowing, 'mic substream sends audio frames before mute').toBeTruthy();

  // ---- USER MUTES THEIR MEET MIC ----
  await send({ type: 'MIC_MUTE_STATE', muted: true });

  // (1b) PUMP GATE: the mic substream must STOP sending frames. Poll
  // until it goes quiet (latency to engage varies with SW hop + load),
  // then confirm it STAYS quiet while the tab substream keeps flowing.
  const gated = await until(async () => {
    const a = micConn.binaryFramesReceived;
    await sleep(400);
    return micConn.binaryFramesReceived === a ? true : null; // stable = gated
  }, { timeout: 10000 });
  expect(gated, 'mic substream must stop sending frames while muted').toBe(true);
  const micHold = micConn.binaryFramesReceived;
  const tabHold = tabConn.binaryFramesReceived;
  await sleep(1200);
  expect(
    micConn.binaryFramesReceived - micHold,
    'mic frames must stay stopped while muted',
  ).toBe(0);
  expect(
    tabConn.binaryFramesReceived - tabHold,
    'tab substream must keep flowing while mic muted',
  ).toBeGreaterThan(0);

  // (2) OVERLAY SUPPRESSION: a mic-origin final must NOT render while
  // muted; a tab-origin final still renders.
  const before = (await renderedTurns()).length;
  micConn.sendJSON({ type: 'final', speaker: 0, text: 'muted self speech leaking' });
  await send({
    type: 'SPEAKER_CHANGE', speaker_name: 'Frank',
    source: 'google_meet', wall_clock_ms: Date.now(),
  });
  tabConn.sendJSON({ type: 'final', speaker: 0, text: 'participant still talking' });

  const afterTab = await until(async () => {
    const t = await renderedTurns();
    return t && t.some((x) => x.text.includes('participant still talking')) ? t : null;
  }, { timeout: 8000 });
  expect(afterTab, 'tab-origin final rendered while muted').toBeTruthy();
  expect(
    afterTab.some((x) => x.text.includes('muted self speech leaking')),
    'mic-origin final must NOT render while muted',
  ).toBe(false);

  // ---- USER UNMUTES ----
  await send({ type: 'MIC_MUTE_STATE', muted: false });
  await sleep(900);

  // Pump resumes.
  const resumeStart = micConn.binaryFramesReceived;
  const micResumed = await until(async () => {
    await sleep(700);
    return micConn.binaryFramesReceived > resumeStart ? true : null;
  }, { timeout: 10000 });
  expect(micResumed, 'mic substream resumes sending frames after unmute').toBe(true);

  // Mic finals render again.
  micConn.sendJSON({ type: 'final', speaker: 0, text: 'i am unmuted now' });
  const afterUnmute = await until(async () => {
    const t = await renderedTurns();
    return t && t.some((x) => x.text.includes('i am unmuted now')) ? t : null;
  }, { timeout: 8000 });
  expect(afterUnmute, 'mic-origin final renders again after unmute').toBeTruthy();

  await send({ type: 'STOP_TRANSCRIBE' });
  await until(async () => {
    const s = await getTranscribeState(worker);
    return s && (s.state === 'IDLE' || s.state === 'ERROR') ? s : null;
  }, { timeout: 15000 });
});

test('Mode 1 (self): muting the in-meeting mic gates the only (mic) substream', async () => {
  test.setTimeout(60000);
  backend.reset();
  await send({
    type: 'START_TRANSCRIBE', mode: 'self', language: 'en',
    tabId: meetTabId, url: MEET_URL,
  });
  const micConn = await waitForConn('mic');
  expect(micConn, 'self substream connected').toBeTruthy();
  const active = await until(async () => {
    const s = await getTranscribeState(worker);
    return s && s.state === 'ACTIVE' ? s : null;
  }, { timeout: 15000 });
  expect(active.state).toBe('ACTIVE');

  // Baseline flowing.
  const flowing = await until(async () => {
    const start = micConn.binaryFramesReceived;
    await sleep(700);
    return micConn.binaryFramesReceived > start ? true : null;
  }, { timeout: 10000 });
  expect(flowing, 'self/mic substream sends frames before mute').toBe(true);

  // Mute → frames stop (poll until quiet, then confirm it holds).
  await send({ type: 'MIC_MUTE_STATE', muted: true });
  const gated = await until(async () => {
    const a = micConn.binaryFramesReceived;
    await sleep(400);
    return micConn.binaryFramesReceived === a ? true : null;
  }, { timeout: 10000 });
  expect(gated, 'self/mic substream must stop sending frames while muted').toBe(true);
  const hold = micConn.binaryFramesReceived;
  await sleep(1200);
  expect(
    micConn.binaryFramesReceived - hold,
    'self mic frames must stay stopped while muted',
  ).toBe(0);

  await send({ type: 'MIC_MUTE_STATE', muted: false });
  await send({ type: 'STOP_TRANSCRIBE' });
  await until(async () => {
    const s = await getTranscribeState(worker);
    return s && (s.state === 'IDLE' || s.state === 'ERROR') ? s : null;
  }, { timeout: 15000 });
});
