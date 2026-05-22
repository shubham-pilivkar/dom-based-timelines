// The UNTESTED LINK: does meet.js's own mic-state observer actually
// detect an in-meeting mute on the live DOM and emit MIC_MUTE_STATE,
// so the offscreen gates the recorder mic? issue1 drives MIC_MUTE_STATE
// straight from the driver (simulating what meet.js *would* send); this
// instead toggles a real <button aria-label="…microphone"> in the page
// and asserts the gate engages with NO synthetic message — i.e. the
// content-script observer → SW → offscreen path works for real.
//
// Serves a controlled page at the meet.google.com origin (so the meet.js
// content script injects) with a single mic button we flip. Recording
// uses the screen path (works headless), same as issue1.

import { test, expect } from '@playwright/test';
import {
  patchManifestCsp, createMockBackend, launchExtension,
  resolveToken, seedAuth, getSwState, until, LIVE_BASE,
} from './helpers/harness.js';

const MEET_URL = 'https://meet.google.com/observer-e2e';

let context; let worker; let extensionId; let backend; let optionsPath;
let driver; let meetPage; let meetTabId;

test.beforeAll(async () => {
  ({ optionsPath } = patchManifestCsp());
  backend = createMockBackend();
  const url = await backend.start();
  ({ context, worker, extensionId } = await launchExtension());

  // Controlled meet.google.com page: ONE mic button, initially LIVE
  // ("Turn off microphone" = unmuted). Flipping its aria-label is what
  // meet.js's meetMicMuted() reads.
  await context.route('https://meet.google.com/**', (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Meet (observer-e2e)</title></head>'
        + '<body><div id="host">e2e meeting</div>'
        + '<button id="mic" aria-label="Turn off microphone" data-is-muted="false"'
        + ' role="button">mic</button>'
        + '</body></html>',
    });
  });

  const baseUrl = LIVE_BASE || url;
  const token = await resolveToken(baseUrl);
  await seedAuth(worker, {
    baseUrl, token,
    extra: { mm_capture_source: 'screen', mm_audio_only: true },
  });

  meetPage = await context.newPage();
  await meetPage.goto(MEET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  meetTabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.includes('meet.google.com'));
    return t ? t.id : null;
  });
  expect(meetTabId, 'meet tab id').toBeTruthy();

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
// Flip the in-page mic button exactly as Meet does on mute/unmute.
const setMicMuted = (muted) => meetPage.evaluate((m) => {
  const b = document.getElementById('mic');
  b.setAttribute('aria-label', m ? 'Turn on microphone' : 'Turn off microphone');
  b.setAttribute('data-is-muted', m ? 'true' : 'false');
}, muted);

test('meet.js observer detects a DOM mic toggle and gates the recorder (no synthetic message)', async () => {
  test.setTimeout(60000);

  // Start a real recording on the meet tab (screen path). meet.js gets
  // RECORDING_LIFECYCLE 'started' → startMicObserver() begins polling
  // the in-page mic button.
  await send({
    type: 'START_RECORDING', tabId: meetTabId, url: MEET_URL, source: 'google_meet',
  });
  const rec = await until(async () => {
    const s = await getSwState(worker);
    return s && (s.state === 'RECORDING' || s.state === 'ERROR') ? s : null;
  }, { timeout: 25000 });
  expect(rec && rec.state, `rec state (err=${rec && rec.errorMessage})`).toBe('RECORDING');

  // Baseline: button is LIVE → observer reports unmuted → mic gain at base.
  const before = await until(async () => {
    const p = await ping();
    return p && p.alive ? p : null;
  }, { timeout: 8000 });
  expect(before.alive).toBe(true);
  // The observer's first tick may set this to false explicitly; either
  // way the effective gain must be the base (1), not zeroed.
  expect(before.micEffectiveGain).toBe(1);

  // ---- USER MUTES IN MEET (DOM flip ONLY — no MIC_MUTE_STATE sent by us) ----
  await setMicMuted(true);
  const muted = await until(async () => {
    const p = await ping();
    return p && p.micEffectiveGain === 0 ? p : null;
  }, { timeout: 8000 });
  expect(
    muted,
    'meet.js observer should have emitted MIC_MUTE_STATE → offscreen gated mic to 0',
  ).toBeTruthy();
  expect(muted.meetingMicMuted).toBe(true);
  expect(muted.micEffectiveGain).toBe(0);

  // ---- USER UNMUTES ----
  await setMicMuted(false);
  const unmuted = await until(async () => {
    const p = await ping();
    return p && p.micEffectiveGain === 1 && p.meetingMicMuted === false ? p : null;
  }, { timeout: 8000 });
  expect(unmuted, 'observer should restore mic gain on unmute').toBeTruthy();
  expect(unmuted.micEffectiveGain).toBe(1);

  await send({ type: 'STOP_RECORDING' });
});
