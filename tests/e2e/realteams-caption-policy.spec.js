// Issue #4 — caption-ownership policy on REAL Microsoft Teams.
// Teams analogue of realmeet-caption-policy.spec.js. Same four cases:
//   Case 2  captions OFF → extension enables + injects #mm-caption-hide
//   Case 4  user turns captions OFF mid-rec → policy re-enables + hides
//   Stop    extension-owned → captions turned OFF + hide-CSS removed
//   Case 1  user already had captions ON → never hidden / never off
//
// HEADED Chromium (loads the extension) + anti-automation. You host a
// teams.microsoft.com meeting and admit the bot once.
//
// Run: MM_TEAMS_URL='<full link>' npx playwright test realteams-caption-policy.spec.js

import { test, expect, chromium } from '@playwright/test';
import { patchManifestCsp, widenManifestForTeamsLive, createMockBackend, EXTENSION_PATH, until } from './helpers/harness.js';

const TEAMS_URL = process.env.MM_TEAMS_URL || '';
const BOT = 'MeetMinutes Teams Bot';
test.skip(!TEAMS_URL, 'set MM_TEAMS_URL to a teams.microsoft.com meeting link');

let context; let page; let extensionId; let backend; let optionsPath; let driver; let meetTabId;

const swState = () => driver.evaluate(async () => {
  const g = await chrome.storage.session.get('mm_session_state');
  return g.mm_session_state ?? null;
});

test.beforeAll(async () => {
  ({ optionsPath } = patchManifestCsp());
  widenManifestForTeamsLive(); // also run on teams.live.com (consumer)
  backend = createMockBackend();
  const url = await backend.start();

  context = await chromium.launchPersistentContext('', {
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
      '--start-maximized',
    ],
  });
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch { /* sealed */ }
  });

  page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/caption|detector|mm-|recording_lifecycle|policy/i.test(t)) console.log('TEAMS>', t.slice(0, 200));
  });
  await page.goto(TEAMS_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

  const cdp = await context.newCDPSession(page);
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
      mm_api_base_url: u, mm_auth_token: 'mock-token', mm_user_email: 'e2e@example.com',
      mm_mic_granted: true, mm_capture_source: 'screen', mm_audio_only: true,
      mm_e2e_caption_probe: true,
    });
  }, [url]);

  // Teams pre-join: stay on web, set name, Join now, wait for admit.
  for (let i = 0; i < 8; i += 1) {
    for (const rx of [/continue on this browser/i, /use the web app instead/i, /join on the web instead/i]) {
      const b = page.getByRole('button', { name: rx }).first();
      if (await b.count().catch(() => 0)) await b.click({ timeout: 4000 }).catch(() => {});
      const l = page.getByRole('link', { name: rx }).first();
      if (await l.count().catch(() => 0)) await l.click({ timeout: 4000 }).catch(() => {});
    }
    if (await page.locator("input[placeholder*='name' i],[data-tid='prejoin-display-name-input']").count().catch(() => 0)) break;
    await page.waitForTimeout(2000);
  }
  const ni = page.locator("input[placeholder*='name' i],[data-tid='prejoin-display-name-input']").first();
  if (await ni.count().catch(() => 0)) { await ni.fill(BOT, { timeout: 5000 }).catch(() => {}); }
  for (const rx of [/^join now$/i, /join now/i, /^join$/i]) {
    const b = page.getByRole('button', { name: rx }).first();
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 5000 }).catch(() => {}); break; }
  }

  console.log(`\n*** ADMIT "${BOT}" in your Teams window. Waiting up to ~4 min… ***\n`);
  const micSel = "#microphone-button,[data-tid='toggle-mute'],[data-tid='microphone-button'],[data-tid*='mute' i],button[aria-label*='microphone' i]";
  let joined = false;
  for (let i = 0; i < 120; i += 1) {
    if (page.isClosed()) throw new Error('window closed before join');
    if (await page.locator(micSel).count().catch(() => 0)) { joined = true; break; }
    if (i % 15 === 0) console.log(`  …waiting to be admitted (${i * 2}s)`);
    await page.waitForTimeout(2000);
  }
  expect(joined, 'bot admitted into the Teams call').toBe(true);
  meetTabId = await driver.evaluate(async () => {
    const t = (await chrome.tabs.query({})).find((x) => x.url && /teams\.(microsoft|live)\.com/.test(x.url));
    return t ? t.id : null;
  });
  expect(meetTabId).toBeTruthy();
  console.log('=== IN TEAMS CALL — running caption-policy scenarios ===');
});

test.afterAll(async () => { await context?.close(); await backend?.stop(); });

const send = (m) => driver.evaluate((msg) => chrome.runtime.sendMessage(msg), m);

// Teams caption state — closed-caption region / author cell / the
// Hide-vs-Show toggle. Mirrors teamsCaptionsOn() in teams.js.
const captionState = () => page.evaluate(() => {
  const hideEl = document.getElementById('mm-caption-hide');
  const region = document.querySelector("[data-tid='closed-caption-v2-window-wrapper'],[data-tid='closed-captions-renderer'],[data-tid*='closed-caption' i]");
  const author = document.querySelector('.fui-ChatMessageCompact [data-tid="author"]');
  const offCtl = document.querySelector("button[aria-label*='Hide live captions' i],button[aria-label*='Turn off live captions' i]");
  const onCtl = document.querySelector("button[aria-label*='Show live captions' i],button[aria-label*='Turn on live captions' i]");
  return {
    hideStyleInjected: !!hideEl,
    captionsOn: !!(region || author || offCtl),
    offCtl: !!offCtl,
    onCtl: !!onCtl,
    regionPresent: !!region,
  };
});
const captionsOff = (st) => !st.offCtl && !st.regionPresent;

// Toggle Teams live captions like a user: direct control, else via
// the ••• More menu → Language and speech.
async function clickTeamsCaption(kind) {
  const direct = kind === 'on'
    ? ["button[aria-label*='Show live captions' i]", "button[aria-label*='Turn on live captions' i]"]
    : ["button[aria-label*='Hide live captions' i]", "button[aria-label*='Turn off live captions' i]"];
  for (const sel of direct) {
    const b = page.locator(sel).first();
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 4000 }).catch(() => {}); return true; }
  }
  // Fallback: More (•••) menu.
  for (const sel of ["button[data-tid='more-button']", "#callingButtons-showMoreBtn", "button[aria-label*='More' i]"]) {
    const more = page.locator(sel).first();
    if (await more.count().catch(() => 0)) { await more.click({ timeout: 3000 }).catch(() => {}); break; }
  }
  await page.waitForTimeout(800);
  const lang = page.getByRole('menuitem', { name: /language and speech|language|captions/i }).first();
  if (await lang.count().catch(() => 0)) { await lang.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(600); }
  const item = page.getByRole('menuitem', {
    name: kind === 'on' ? /turn on live captions|show live captions/i : /turn off live captions|hide live captions/i,
  }).first();
  if (await item.count().catch(() => 0)) { await item.click({ timeout: 3000 }).catch(() => {}); return true; }
  return false;
}

// #1 — faithful mirror of teams.js teamsMicMuted().
const teamsMicMutedSrc = `(${function detect() {
  try {
    const t = document.querySelector("#microphone-button,[data-tid='toggle-mute'],[data-tid='microphone-button'],[data-tid*='mute' i],[data-tid*='microphone' i],button[aria-label*='microphone' i]");
    if (t) {
      const label = (t.getAttribute('aria-label') || t.getAttribute('title') || '').toLowerCase();
      if (label.includes('unmute')) return { result: true };
      if (label.includes('mute')) return { result: false };
      const ap = t.getAttribute('aria-pressed') || t.getAttribute('aria-checked');
      if (ap === 'true') return { result: true };
      if (ap === 'false') return { result: false };
    }
    if (document.querySelector("button[aria-label*='Unmute' i],button[title*='Unmute' i]")) return { result: true };
    if (document.querySelector("[aria-label*='your mic is muted' i],[aria-label*='your microphone is muted' i],[aria-label*='microphone is muted' i]")) return { result: true };
    if (document.querySelector("button[aria-label*='Mute' i]:not([aria-label*='Unmute' i]),button[title*='Mute' i]:not([title*='Unmute' i])")) return { result: false };
    return { result: null };
  } catch (e) { return { result: null, err: e.message }; }
}})()`;

// #3 — Teams caption author/text exactly as caption-speaker-observer
// reads them (block .fui-ChatMessageCompact, author/text data-tids).
const teamsCaptionRowsSrc = `(${function rows() {
  return [...document.querySelectorAll('.fui-ChatMessageCompact')].slice(-8).map((b) => ({
    author: (b.querySelector('[data-tid="author"]')?.textContent || '').trim(),
    text: (b.querySelector('[data-tid="closed-caption-text"]')?.textContent || '').trim(),
  })).filter((r) => r.author || r.text);
}})()`;

const waitRec = (s) => until(async () => {
  const st = await swState();
  return st && st.state === s ? st : null;
}, { timeout: 30000 });

test('Case 2 + 4 + restore (Teams): enable+hide, re-hide, then off on stop', async () => {
  test.setTimeout(300000);

  // === #1 — Teams mic-mute detection (real toggle via Ctrl+Shift+M) ===
  const mLive = await page.evaluate(teamsMicMutedSrc);
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+Shift+M');
  await page.waitForTimeout(2500);
  const mMuted = await page.evaluate(teamsMicMutedSrc);
  await page.keyboard.press('Control+Shift+M');
  await page.waitForTimeout(2500);
  const mRestored = await page.evaluate(teamsMicMutedSrc);
  console.log('#1 teamsMicMuted live/muted/restored =', JSON.stringify([mLive, mMuted, mRestored]));
  expect(mLive.result, 'Teams mic LIVE detected').toBe(false);
  expect(mMuted.result, 'Teams mic MUTED detected after Ctrl+Shift+M').toBe(true);
  expect(mRestored.result, 'Teams mic LIVE again after unmute').toBe(false);

  if (await clickTeamsCaption('off')) await page.waitForTimeout(2500);
  console.log('pre-start:', JSON.stringify(await captionState()));

  await send({ type: 'START_RECORDING', tabId: meetTabId, url: TEAMS_URL, source: 'ms_teams' });
  const rec = await waitRec('RECORDING');
  expect(rec.state, `rec (err=${rec && rec.errorMessage})`).toBe('RECORDING');

  const c2 = await until(async () => {
    const st = await captionState();
    return (st.hideStyleInjected && st.captionsOn) ? st : null;
  }, { timeout: 90000, interval: 2000 });
  if (!c2) {
    const probe = await page.evaluate(() => ({
      state: document.documentElement.getAttribute('data-mm-cap-state'),
      log: document.documentElement.getAttribute('data-mm-cap-log'),
    }));
    console.log('DIAG cap-state =', probe.state, ' log =', probe.log);
    console.log('DIAG captionState =', JSON.stringify(await captionState()));
  }
  console.log('Case 2:', JSON.stringify(c2));
  expect(c2, 'extension enabled Teams captions + injected hide-CSS').toBeTruthy();

  // === #3 — captions are now extension-enabled (DOM populated even
  // though hidden). SPEAK so Teams writes author+text cells; verify
  // the observer would extract a REAL participant name. ===
  console.log('\n*** #3: SPEAK in Teams now (a few sentences) — capturing author cells ~40s ***\n');
  const capRows = await until(async () => {
    const rows = await page.evaluate(teamsCaptionRowsSrc);
    const named = rows.filter((r) => r.author && r.text && (r.text.match(/[A-Za-z]{2,}/g) || []).length >= 2);
    return named.length ? named : null;
  }, { timeout: 40000, interval: 2000 });
  if (capRows) {
    const names = [...new Set(capRows.map((r) => r.author))];
    console.log('#3 Teams caption rows =', JSON.stringify(capRows.slice(-3)));
    console.log('#3 real author name(s) =', JSON.stringify(names));
    expect(names.some((n) => !/^Speaker\b/i.test(n)), 'real Teams participant name (not Speaker A/B)').toBe(true);
  } else {
    console.log('#3 ⚠️ no caption author/text captured (no speech?) — inconclusive');
  }

  await clickTeamsCaption('off');
  const c4 = await until(async () => {
    const st = await captionState();
    return (st.captionsOn && st.hideStyleInjected) ? st : null;
  }, { timeout: 60000, interval: 2000 });
  console.log('Case 4:', JSON.stringify(c4));
  expect(c4, 'policy re-enabled Teams captions + kept hidden').toBeTruthy();

  await send({ type: 'STOP_RECORDING' });
  await waitRec('IDLE').catch(() => {});
  const after = await until(async () => {
    const st = await captionState();
    return (!st.hideStyleInjected && captionsOff(st)) ? st : null;
  }, { timeout: 60000, interval: 2000 });
  if (!after) {
    const probe = await page.evaluate(() => ({
      dispose: document.documentElement.getAttribute('data-mm-cap-dispose'),
      log: document.documentElement.getAttribute('data-mm-cap-log'),
    }));
    console.log('DIAG dispose =', probe.dispose, ' log =', probe.log);
    console.log('DIAG after-stop =', JSON.stringify(await captionState()));
  }
  console.log('after stop:', JSON.stringify(after));
  expect(after, 'Teams captions OFF + hide-CSS removed on stop').toBeTruthy();
});

test('Case 1 (Teams): user-owned captions never hidden / never turned off', async () => {
  test.setTimeout(180000);
  await clickTeamsCaption('on');
  const on = await until(async () => {
    const st = await captionState();
    return st.captionsOn ? st : null;
  }, { timeout: 40000, interval: 2000 });
  expect(on, 'user enabled Teams captions pre-recording').toBeTruthy();

  await send({ type: 'START_RECORDING', tabId: meetTabId, url: TEAMS_URL, source: 'ms_teams' });
  expect((await waitRec('RECORDING')).state).toBe('RECORDING');
  await page.waitForTimeout(12000);
  const s = await captionState();
  console.log('Case 1 during rec:', JSON.stringify(s));
  expect(s.captionsOn, 'captions still on').toBe(true);
  expect(s.hideStyleInjected, 'must NOT hide user-owned Teams captions').toBe(false);

  await send({ type: 'STOP_RECORDING' });
  await waitRec('IDLE').catch(() => {});
  await page.waitForTimeout(5000);
  const after = await captionState();
  console.log('Case 1 after stop:', JSON.stringify(after));
  expect(after.captionsOn, 'user-owned Teams captions left ON after stop').toBe(true);
  expect(after.hideStyleInjected).toBe(false);
});
