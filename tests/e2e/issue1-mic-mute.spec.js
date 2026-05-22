// Issue #1 — start recording → mid-recording the user clicks Meet's
// mic mute then unmute → verify the MIC_MUTE_STATE message flows
// (content-script → SW → offscreen) AND that the offscreen actually
// GATES the mic: the live Web Audio mic gain node goes to 0 while
// muted and back to the configured base gain on unmute.
//
// Headless can't run chrome.tabCapture, so the recording uses the
// SCREEN capture path (getDisplayMedia + fake-device flags), which the
// probe confirmed builds a REAL AudioMixer with a real mic gain node.
// We read the live gain param back through the OFFSCREEN_PING
// diagnostic (relayed deterministically by the SW).

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
    // SCREEN path → offscreen calls getDisplayMedia() itself (works
    // headless); audio-only keeps the recorder light.
    extra: { mm_capture_source: 'screen', mm_audio_only: true },
  });
  driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/${optionsPath}`);
});

test.afterAll(async () => {
  await context?.close();
  await backend?.stop();
});

// Drive a message through the SW exactly as a content script would,
// and read the SW's response.
async function send(msg) {
  return driver.evaluate((m) => chrome.runtime.sendMessage(m), msg);
}
async function ping() {
  const res = await send({ type: 'OFFSCREEN_PING' });
  return res?.data ?? res;
}

test('MIC_MUTE_STATE flows and the offscreen gates the mic gain → 0 → base', async () => {
  // 1. Start a real recording (SCREEN path).
  await send({
    type: 'START_RECORDING', tabId: 999,
    url: 'https://meet.google.com/issue1', source: 'google_meet',
  });
  const recState = await until(
    async () => {
      const s = await getSwState(worker);
      return s && (s.state === 'RECORDING' || s.state === 'ERROR') ? s : null;
    },
    { timeout: 25000 },
  );
  expect(recState, 'SW should reach RECORDING').toBeTruthy();
  expect(recState.state).toBe('RECORDING');

  // Backend got the unified create call.
  expect(
    backend.requests.some(
      (r) => r.method === 'POST' && r.url === '/api/v1/recordings',
    ),
  ).toBe(true);

  // 2. Baseline: mic live, effective gain == configured base (default 1).
  const before = await until(async () => {
    const p = await ping();
    return p && p.alive ? p : null;
  });
  expect(before.alive).toBe(true);
  expect(before.meetingMicMuted).toBe(false);
  expect(before.baseMicGain).toBe(1);
  expect(before.micEffectiveGain).toBe(1);

  // 3. User mutes themselves in Meet. The content script emits
  //    MIC_MUTE_STATE; the SW (gated on RECORDING) forwards
  //    OFFSCREEN_MIC_MUTE; the offscreen zeroes the mic gain node.
  await send({ type: 'MIC_MUTE_STATE', muted: true });
  const muted = await until(async () => {
    const p = await ping();
    return p && p.micEffectiveGain === 0 ? p : null;
  }, { timeout: 8000 });
  expect(muted, 'mic gain should reach 0 while muted').toBeTruthy();
  expect(muted.meetingMicMuted).toBe(true);
  expect(muted.micEffectiveGain).toBe(0);
  // The track stays live (base gain remembered for instant unmute).
  expect(muted.baseMicGain).toBe(1);

  // 4. User unmutes → gain restored to the configured base.
  await send({ type: 'MIC_MUTE_STATE', muted: false });
  const unmuted = await until(async () => {
    const p = await ping();
    return p && p.micEffectiveGain === 1 && p.meetingMicMuted === false ? p : null;
  }, { timeout: 8000 });
  expect(unmuted, 'mic gain should restore to base on unmute').toBeTruthy();
  expect(unmuted.micEffectiveGain).toBe(1);
});

test('SW only forwards MIC_MUTE_STATE while recording (gate holds when IDLE)', async () => {
  // Stop the recording from the previous test → back to IDLE.
  await send({ type: 'STOP_RECORDING' });
  const idle = await until(async () => {
    const s = await getSwState(worker);
    return s && s.state === 'IDLE' ? s : null;
  }, { timeout: 20000 });
  expect(idle, 'SW should return to IDLE after stop').toBeTruthy();

  // A mute toggle now must NOT reach a (gone) offscreen session — the
  // SW gate is `state === RECORDING || STARTING`. The offscreen has no
  // session, so the diagnostic reports no live gain node at all.
  await send({ type: 'MIC_MUTE_STATE', muted: true });
  await new Promise((r) => setTimeout(r, 500));
  const p = await ping();
  expect(p.alive).toBe(false);
  expect(p.micEffectiveGain).toBeNull();
});
