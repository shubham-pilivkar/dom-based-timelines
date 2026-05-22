// Issue #4 — caption-ownership policy on REAL Google Meet.
//
// Validates lib/caption-policy.js end-to-end against the live Meet
// client while the extension is recording:
//   Case 2  captions OFF at start → extension enables them + injects
//           hide-CSS (<style id="mm-caption-hide">) so the box is
//           invisible while the scraper still reads it.
//   Case 4  user turns captions OFF mid-recording → policy re-enables
//           them and re-hides (stays stealth).
//   Stop    extension-owned captions → dispose({restore}) turns them
//           back OFF and removes the hide-CSS (meeting left as it was).
//   Case 1  user already had captions ON → policy must NOT hide them
//           and must NOT turn them off on stop.
//   Case 3  user turns captions ON mid-meeting → same userWantsVisible
//           → unhide path as Case 1 (also unit-tested).
//
// HEADED real Chrome (Meet blocks automated/bundled browsers). You
// host the meeting and admit "MeetMinutes Caption-Policy Bot" once.
// Recording uses the screen path + mock backend (Issue #4 is pure DOM
// behaviour; no live backend needed).
//
// Run: MM_MEET_URL=<link> npx playwright test realmeet-caption-policy.spec.js

import { test, expect, chromium } from '@playwright/test';
import { patchManifestCsp, createMockBackend, EXTENSION_PATH, until } from './helpers/harness.js';

const MEET_URL = process.env.MM_MEET_URL || 'https://meet.google.com/zrg-epqx-ybd';
const BOT = 'MeetMinutes Caption-Policy Bot';

let context; let page; let extensionId; let backend; let optionsPath; let driver; let meetTabId;

// Read SW session state from the options page (extension context).
const swState = () => driver.evaluate(async () => {
  const g = await chrome.storage.session.get('mm_session_state');
  return g.mm_session_state ?? null;
});

test.beforeAll(async () => {
  ({ optionsPath } = patchManifestCsp());
  backend = createMockBackend();
  const url = await backend.start();

  context = await chromium.launchPersistentContext('', {
    // Chromium (Chrome-for-Testing) reliably loads the unpacked
    // extension AND its SW; branded Chrome blocks --load-extension.
    // The anti-automation flags below get it past Meet's gate.
    channel: process.env.MM_MEET_CHANNEL || 'chromium',
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--disable-blink-features=AutomationControlled',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--auto-select-desktop-capture-source=Entire screen',
      '--start-maximized',
    ],
  });
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch { /* sealed */ }
  });

  // Navigate to Meet FIRST — the content-script injection on
  // meet.google.com reliably wakes the MV3 service worker (real
  // Chrome registers it lazily; a bare waitForEvent races/timeouts).
  page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/caption|detector|mm-|recording_lifecycle|policy/i.test(t)) console.log('MEET>', t.slice(0, 200));
  });
  await page.goto(MEET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Branded Chrome doesn't surface the (dormant MV3) extension SW via
  // context.serviceWorkers(). Discover the extension id from the
  // lower-level CDP target list instead, then drive everything from
  // the options page (an extension context with chrome.* APIs) — that
  // also wakes the SW.
  const cdp = await context.newCDPSession(page);
  // Browser-wide discovery — without this, getTargets is page-scoped
  // and never lists the extension's service-worker/background target.
  let extUrl = null;
  cdp.on('Target.targetCreated', ({ targetInfo }) => {
    if (!extUrl && targetInfo.url && targetInfo.url.startsWith('chrome-extension://')) extUrl = targetInfo.url;
  });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  for (let i = 0; i < 45 && !extUrl; i += 1) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const t = targetInfos.find((x) => x.url.startsWith('chrome-extension://'));
    if (t) extUrl = t.url; else await page.waitForTimeout(1000);
  }
  if (!extUrl) throw new Error('extension target never appeared (CDP)');
  extensionId = new URL(extUrl).host;
  driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/${optionsPath}`);
  await driver.evaluate(async ([u]) => {
    await chrome.storage.local.set({
      mm_api_base_url: u,
      mm_auth_token: 'mock-token',
      mm_user_email: 'e2e@example.com',
      mm_mic_granted: true,
      mm_capture_source: 'screen',
      mm_audio_only: true,
      mm_e2e_caption_probe: true,
    });
  }, [url]);

  // Robust join (anti-automation already set): reload-and-retry until
  // the in-call mic control appears (you admit the bot).
  const micSel = 'button[aria-label*="microphone" i],[role="button"][aria-label*="microphone" i]';
  const nameSel = 'input[aria-label*="name" i], input[placeholder*="name" i]';
  console.log(`\n*** ADMIT "${BOT}" in your Meet window. Waiting up to ~4 min… ***\n`);
  let joined = false;
  for (let i = 0; i < 80; i += 1) {
    if (page.isClosed()) throw new Error('window closed before join');
    if (await page.locator(micSel).count().catch(() => 0)) { joined = true; break; }
    let body = '';
    try { body = await page.evaluate(() => (document.body.innerText || '').slice(0, 300)); } catch { /* nav */ }
    if (/asking to be let in|you'?ll join when|waiting for the host/i.test(body)) {
      console.log(`  [${i * 3}s] in lobby — admit it`); joined = true; break;
    }
    if (/can'?t join|return to home screen|check your meeting code/i.test(body)) {
      console.log(`  [${i * 3}s] bounced — reloading (be IN the meeting as host)`);
      await page.goto(MEET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000); continue;
    }
    const ni = page.locator(nameSel).first();
    if (await ni.count().catch(() => 0)) { await ni.fill(BOT, { timeout: 2500 }).catch(() => {}); }
    for (const rx of [/ask to join/i, /join now/i, /^join$/i]) {
      const b = page.getByRole('button', { name: rx }).first();
      if (await b.count().catch(() => 0)) { await b.click({ timeout: 2500 }).catch(() => {}); break; }
    }
    await page.waitForTimeout(3000);
  }
  expect(joined, 'bot admitted into the call').toBe(true);
  // Confirm fully in-call (mic control present).
  await until(async () => (await page.locator(micSel).count().catch(() => 0)) ? true : null, { timeout: 60000 });
  meetTabId = await driver.evaluate(async () => {
    const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.includes('meet.google.com'));
    return t ? t.id : null;
  });
  expect(meetTabId).toBeTruthy();
  console.log('=== IN CALL — running caption-policy scenarios ===');
});

test.afterAll(async () => {
  await context?.close();
  await backend?.stop();
});

const send = (m) => driver.evaluate((msg) => chrome.runtime.sendMessage(msg), m);

// DOM probes run inside the Meet page.
const captionState = () => page.evaluate(() => {
  const hideEl = document.getElementById('mm-caption-hide');
  const offBtn = !!document.querySelector('button[aria-label*="Turn off captions" i]');
  const onBtn = !!document.querySelector('button[aria-label*="Turn on captions" i]');
  const region = document.querySelector('[role="region"][aria-label*="caption" i]');
  let regionHidden = null;
  if (region) {
    const cs = getComputedStyle(region);
    regionHidden = cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0';
  }
  return {
    hideStyleInjected: !!hideEl,
    captionsOn: offBtn || !!region,   // "Turn off" control or region present = ON
    offBtn,
    canTurnOn: onBtn,
    regionPresent: !!region,
    regionHidden,
  };
});
// Captions are OFF when the toggle flipped back to "Turn on captions"
// and there's no "Turn off" control. (Meet leaves the region element
// in the DOM briefly after disabling, so the button state — not the
// region — is the deterministic signal.)
const captionsOff = (st) => !st.offBtn && st.canTurnOn;
const clickCaption = async (kind) => { // 'on' | 'off'
  const label = kind === 'on' ? 'Turn on captions' : 'Turn off captions';
  const b = page.locator(`button[aria-label*="${label}" i]`).first();
  if (await b.count().catch(() => 0)) { await b.click({ timeout: 4000 }).catch(() => {}); return true; }
  return false;
};
const waitRec = (s) => until(async () => {
  const st = await swState();
  return st && st.state === s ? st : null;
}, { timeout: 30000 });

test('Case 2 + 4 + restore: extension-owned captions are enabled, hidden, re-hidden, then turned off on stop', async () => {
  test.setTimeout(180000);

  // Pre: ensure captions OFF (user does NOT own them).
  if (await clickCaption('off')) await page.waitForTimeout(2000);
  let s = await captionState();
  console.log('pre-start:', JSON.stringify(s));

  // START recording → SW sends RECORDING_LIFECYCLE → meet.js starts
  // caption-policy.
  await send({ type: 'START_RECORDING', tabId: meetTabId, url: MEET_URL, source: 'google_meet' });
  const rec = await waitRec('RECORDING');
  expect(rec.state, `rec (err=${rec && rec.errorMessage})`).toBe('RECORDING');

  // Case 2: within a few policy ticks captions are ON + hide-CSS in.
  const c2 = await until(async () => {
    const st = await captionState();
    return (st.hideStyleInjected && st.captionsOn) ? st : null;
  }, { timeout: 60000, interval: 1500 });
  console.log('Case 2:', JSON.stringify(c2));
  if (!c2) {
    const diag = await page.evaluate(() => ({
      capButtons: [...document.querySelectorAll('button,[role="button"]')]
        .map((b) => b.getAttribute('aria-label'))
        .filter((a) => a && /caption/i.test(a)),
      hideEl: !!document.getElementById('mm-caption-hide'),
      offBtn: !!document.querySelector('button[aria-label*="Turn off captions" i]'),
      onBtn: !!document.querySelector('button[aria-label*="Turn on captions" i]'),
      region: !!document.querySelector('[role="region"][aria-label*="caption" i]'),
      // recording-banner.js is a declared content script too — its
      // presence proves content scripts inject into this tab.
      mmBanner: !!document.querySelector('[class*="mm-"],[id*="mm-"],[data-mm]'),
      bodyHasCaptionsWord: /captions/i.test(document.body.innerText || ''),
    }));
    const st = await swState();
    console.log('DIAG swState =', JSON.stringify(st && { state: st.state, tabId: st.tabId, err: st.errorMessage }), 'meetTabId =', meetTabId);
    console.log('DIAG page =', JSON.stringify(diag));
  }
  expect(c2, 'extension enabled captions + injected hide-CSS').toBeTruthy();
  expect(c2.hideStyleInjected).toBe(true);
  expect(c2.captionsOn).toBe(true);
  if (c2.regionPresent) expect(c2.regionHidden).toBe(true);

  // Case 4: user turns captions OFF mid-recording → policy must
  // re-enable + keep hidden (stealth) within tick+grace.
  await clickCaption('off');
  const c4 = await until(async () => {
    const st = await captionState();
    return (st.captionsOn && st.hideStyleInjected) ? st : null;
  }, { timeout: 45000, interval: 1500 });
  console.log('Case 4:', JSON.stringify(c4));
  expect(c4, 'policy re-enabled captions and kept them hidden').toBeTruthy();

  // Stop: extension owns captions → restore turns them OFF + removes
  // the hide-CSS (meeting left as the user had it).
  await send({ type: 'STOP_RECORDING' });
  await waitRec('IDLE').catch(() => {});
  // Restore can lag: SW finalize → RECORDING_LIFECYCLE 'stopped' →
  // meet.js dispose({restore}) → click "Turn off captions".
  const after = await until(async () => {
    const st = await captionState();
    return (!st.hideStyleInjected && captionsOff(st)) ? st : null;
  }, { timeout: 45000, interval: 2000 });
  if (!after) {
    const st = await captionState();
    const sw = await swState();
    const probe = await page.evaluate(() => ({
      state: document.documentElement.getAttribute('data-mm-cap-state'),
      log: document.documentElement.getAttribute('data-mm-cap-log'),
      dispose: document.documentElement.getAttribute('data-mm-cap-dispose'),
    }));
    console.log('DIAG after-stop state =', JSON.stringify(st));
    console.log('DIAG swState =', JSON.stringify(sw && { state: sw.state, tabId: sw.tabId }), 'meetTabId =', meetTabId);
    console.log('DIAG cap-policy.state =', probe.state);
    console.log('DIAG cap-policy.log =', probe.log);
    console.log('DIAG cap-policy.dispose =', probe.dispose);
  }
  console.log('after stop:', JSON.stringify(after));
  expect(after, 'hide-CSS removed AND captions turned back off on stop').toBeTruthy();
  expect(after.hideStyleInjected).toBe(false);
  expect(captionsOff(after)).toBe(true);
});

test('Case 1: user already had captions ON → never hidden, never turned off', async () => {
  test.setTimeout(120000);

  // User turns captions ON before recording.
  await clickCaption('on');
  const on = await until(async () => {
    const st = await captionState();
    return st.captionsOn ? st : null;
  }, { timeout: 15000 });
  expect(on, 'user enabled captions pre-recording').toBeTruthy();

  await send({ type: 'START_RECORDING', tabId: meetTabId, url: MEET_URL, source: 'google_meet' });
  expect((await waitRec('RECORDING')).state).toBe('RECORDING');

  // Give the policy several ticks; it must NOT inject hide-CSS
  // (userWantsVisible) and captions stay visible.
  await page.waitForTimeout(8000);
  const s = await captionState();
  console.log('Case 1 during rec:', JSON.stringify(s));
  expect(s.captionsOn, 'captions still on').toBe(true);
  expect(s.hideStyleInjected, 'must NOT hide user-owned captions').toBe(false);
  if (s.regionPresent) expect(s.regionHidden).toBe(false);

  // Stop: user owns captions → must be LEFT ON (not restored off).
  await send({ type: 'STOP_RECORDING' });
  await waitRec('IDLE').catch(() => {});
  await page.waitForTimeout(4000);
  const after = await captionState();
  console.log('Case 1 after stop:', JSON.stringify(after));
  expect(after.captionsOn, 'user-owned captions left ON after stop').toBe(true);
  expect(after.hideStyleInjected).toBe(false);
});
