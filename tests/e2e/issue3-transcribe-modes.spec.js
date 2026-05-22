// Issue #3 — run live-transcribe Mode 2 (participants) then Mode 3
// (both), capture the transcript events + the overlay's rendered
// turns, and flag whether the speaker names are REAL names or the
// "Speaker A/B" diarization fallback.
//
// Headless can't run chrome.tabCapture / a real mic, so:
//   * the SW's getMediaStreamId is stubbed to a sentinel id,
//   * the offscreen synthesises a silent capture stream
//     (mm_e2e_synthetic_capture),
//   * the overlay attaches an OPEN shadow root (mm_e2e_open_shadow)
//     so we can read the rendered turns.
// The transcript events themselves come from the mock WS relay — the
// real offscreen → SW → overlay routing + speaker-name resolution is
// exercised end-to-end.

import { test, expect } from '@playwright/test';
import {
  patchManifestCsp, createMockBackend, launchExtension,
  resolveToken, seedAuth, getTranscribeState, until, LIVE_BASE,
} from './helpers/harness.js';

// Real Google Meet room (provided by the maintainer). The overlay
// content script + its web_accessible_resources chunk load on the
// genuine meet.google.com origin exactly as in production. No
// join/camera/mic needed — speaker names come from SPEAKER_CHANGE
// messages, not the Meet DOM, so the pre-join screen is sufficient.
const MEET_URL = 'https://meet.google.com/hft-umov-kop';

let context; let worker; let extensionId; let backend; let meetPage; let driver;
let meetTabId;

let optionsPath;

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
      mm_user_email: 'e2e@example.com', // selfName → "E2e"
    },
  });

  // Stub the short-lived tabCapture streamId mint (no activeTab grant
  // headless). The offscreen ignores the id anyway under the synthetic
  // capture seam.
  await worker.evaluate(() => {
    chrome.tabCapture.getMediaStreamId = (_opts, cb) => cb('e2e-fake-stream');
  });

  // The "meeting tab" — the real Meet room. Land on the pre-join
  // screen (no sign-in / join needed); the overlay still injects on
  // the meet.google.com origin.
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

// Role of a WS connection: the self session is the mic substream,
// participants is the tab substream.
function roleOf(conn) {
  return backend.sessionModeBySid[conn.sid] === 'self' ? 'mic' : 'tab';
}

// Wait for a WS connection of the given role (Mode 3 mints two).
function waitForConn(role) {
  return until(
    async () => backend.wsConnections.find((c) => !c.closed && roleOf(c) === role),
    { timeout: 15000 },
  );
}

// Read the overlay's rendered finals out of the (open) shadow root.
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

const isFallback = (s) => /^Speaker\s+[A-Z0-9]+:/.test(s);

test('Mode 2 (participants): numeric speakers render real names or "Speaker A/B" fallback', async () => {
  await send({
    type: 'START_TRANSCRIBE', mode: 'participants', language: 'en',
    tabId: meetTabId, url: MEET_URL,
  });

  const conn = await waitForConn('tab');
  expect(conn, 'participants WS connected').toBeTruthy();

  const active = await until(async () => {
    const s = await getTranscribeState(worker);
    return s && s.state === 'ACTIVE' ? s : null;
  }, { timeout: 15000 });
  expect(active.state).toBe('ACTIVE');
  // Overlay mounted in the meeting tab.
  await until(async () => (await renderedTurns()) !== null, { timeout: 8000 });

  // (a) No DOM/SPEAKER_CHANGE evidence → diarization fallback label.
  conn.sendJSON({ type: 'partial', speaker: 0, text: 'alpha' });
  conn.sendJSON({ type: 'final', speaker: 0, text: 'alpha one' });
  await until(async () => {
    const t = await renderedTurns();
    return t && t.length >= 1 ? t : null;
  }, { timeout: 8000 });

  // (b) A real participant name arrives via SPEAKER_CHANGE (what the
  //     caption / tile observer emits) → the next turn resolves to it.
  await send({
    type: 'SPEAKER_CHANGE', speaker_name: 'Dana',
    source: 'google_meet', wall_clock_ms: Date.now(),
  });
  conn.sendJSON({ type: 'final', speaker: 1, text: 'bravo two' });

  const turns = await until(async () => {
    const t = await renderedTurns();
    return t && t.length >= 2 ? t : null;
  }, { timeout: 8000 });

  expect(turns).toHaveLength(2);
  // Turn 1: fallback "Speaker A".
  expect(turns[0].text).toContain('alpha one');
  expect(turns[0].speaker).toBe('Speaker A:');
  expect(isFallback(turns[0].speaker)).toBe(true);
  // Turn 2: real name resolved from SPEAKER_CHANGE.
  expect(turns[1].text).toContain('bravo two');
  expect(turns[1].speaker).toBe('Dana:');
  expect(isFallback(turns[1].speaker)).toBe(false);

  await send({ type: 'STOP_TRANSCRIBE' });
  await until(async () => {
    const s = await getTranscribeState(worker);
    return s && (s.state === 'IDLE' || s.state === 'ERROR') ? s : null;
  }, { timeout: 15000 });
});

test('Mode 3 (both): mic substream → self name, tab substream → participant name', async () => {
  backend.reset();
  await send({
    type: 'START_TRANSCRIBE', mode: 'both', language: 'en',
    tabId: meetTabId, url: MEET_URL,
  });

  // Two backend sessions minted (self + participants).
  const micConn = await waitForConn('mic');
  const tabConn = await waitForConn('tab');
  expect(micConn).toBeTruthy();
  expect(tabConn).toBeTruthy();
  expect(
    backend.requests.filter(
      (r) => r.url === '/api/v1/transcribe/sessions' && r.method === 'POST',
    ).length,
  ).toBe(2);

  const active = await until(async () => {
    const s = await getTranscribeState(worker);
    return s && s.state === 'ACTIVE' ? s : null;
  }, { timeout: 15000 });
  expect(active.state).toBe('ACTIVE');
  expect(active.sessionIdTab, 'Mode 3 tracks a second session id').toBeTruthy();
  await until(async () => (await renderedTurns()) !== null, { timeout: 8000 });

  // Mic substream → resolves to the signed-in user's name ("E2e"),
  // tagged with the mic row class.
  micConn.sendJSON({ type: 'final', speaker: 0, text: 'this is me talking' });
  // Tab substream → resolves a real participant name from SPEAKER_CHANGE.
  await send({
    type: 'SPEAKER_CHANGE', speaker_name: 'Frank',
    source: 'google_meet', wall_clock_ms: Date.now(),
  });
  tabConn.sendJSON({ type: 'final', speaker: 0, text: 'this is a participant' });

  const turns = await until(async () => {
    const t = await renderedTurns();
    return t && t.length >= 2 ? t : null;
  }, { timeout: 8000 });

  const micTurn = turns.find((t) => t.text.includes('this is me talking'));
  const tabTurn = turns.find((t) => t.text.includes('this is a participant'));
  expect(micTurn, 'mic-origin turn rendered').toBeTruthy();
  expect(tabTurn, 'tab-origin turn rendered').toBeTruthy();

  // Mic → self name, flagged as a mic row, NOT a "Speaker A/B" fallback.
  expect(micTurn.speaker).toBe('E2e:');
  expect(micTurn.mic).toBe(true);
  expect(isFallback(micTurn.speaker)).toBe(false);

  // Tab → real participant name (also not a fallback), normal row.
  expect(tabTurn.speaker).toBe('Frank:');
  expect(tabTurn.mic).toBe(false);
  expect(isFallback(tabTurn.speaker)).toBe(false);

  await send({ type: 'STOP_TRANSCRIBE' });
  await until(async () => {
    const s = await getTranscribeState(worker);
    return s && (s.state === 'IDLE' || s.state === 'ERROR') ? s : null;
  }, { timeout: 15000 });
});
