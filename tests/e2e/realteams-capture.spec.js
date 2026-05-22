// Real Microsoft Teams DOM capture (HEADED, manual-assist) — the
// Teams analogue of realmeet-capture.spec.js.
//
//   Phase 1 (mic)      : dump the Teams mic control, run teamsMicMuted()
//                        logic, toggle the mic, dump again.
//   Phase 2 (captions) : while YOU speak with live captions on, sample
//                        the closed-caption region + author cells and
//                        show the speaker-name / text the observer emits.
//
// You drive it: admit "MeetMinutes Teams Bot", turn on live captions,
// talk on cue. Artifacts → tests/e2e/captures/.
//
// Run: MM_TEAMS_URL='<full teams.microsoft.com meetup-join link>' \
//      npx playwright test tests/e2e/realteams-capture.spec.js

import { test, expect, chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchManifestCsp, widenManifestForTeamsLive, EXTENSION_PATH } from './helpers/harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAP_DIR = path.join(__dirname, 'captures');
const TEAMS_URL = process.env.MM_TEAMS_URL || '';
const BOT_NAME = process.env.MM_BOT_NAME || 'MeetMinutes Teams Bot';

test.skip(!TEAMS_URL, 'set MM_TEAMS_URL to a teams.microsoft.com meeting link');

function save(name, data) {
  mkdirSync(CAP_DIR, { recursive: true });
  writeFileSync(path.join(CAP_DIR, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  console.log(`  saved → tests/e2e/captures/${name}`);
}

// EXACT detection logic from src/content/teams.js teamsMicMuted(),
// run in-page against the live DOM.
const teamsMicMutedSrc = `(${function detect() {
  try {
    const t = document.querySelector(
      "#microphone-button,[data-tid='toggle-mute'],[data-tid='microphone-button'],[data-tid*='mute' i],[data-tid*='microphone' i],button[aria-label*='microphone' i]",
    );
    if (t) {
      const label = (t.getAttribute('aria-label') || t.getAttribute('title') || '').toLowerCase();
      if (label.includes('unmute')) return { result: true, why: 'verb unmute → muted: ' + label };
      if (label.includes('mute')) return { result: false, why: 'verb mute → live: ' + label };
      const ap = t.getAttribute('aria-pressed') || t.getAttribute('aria-checked');
      if (ap === 'true') return { result: true, why: 'aria-pressed/checked=true' };
      if (ap === 'false') return { result: false, why: 'aria-pressed/checked=false' };
    }
    if (document.querySelector("button[aria-label*='Unmute' i],button[title*='Unmute' i]")) return { result: true, why: 'standalone Unmute affordance' };
    if (document.querySelector("[aria-label*='your mic is muted' i],[aria-label*='your microphone is muted' i],[aria-label*='microphone is muted' i]")) return { result: true, why: 'muted banner' };
    if (document.querySelector("button[aria-label*='Mute' i]:not([aria-label*='Unmute' i]),button[title*='Mute' i]:not([title*='Unmute' i])")) return { result: false, why: 'standalone Mute/title affordance' };
    return { result: null, why: 'no mic signal' };
  } catch (e) { return { result: null, why: 'threw ' + e.message }; }
}})()`;

const micSnapSrc = `(${function snap() {
  const sel = "#microphone-button,[data-tid='toggle-mute'],[data-tid='microphone-button'],[data-tid*='mute' i],[data-tid*='microphone' i],button[aria-label*='microphone' i]";
  const m = document.querySelector(sel);
  const wide = [...document.querySelectorAll('button,[role="button"]')]
    .filter((b) => /mic|mute/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.getAttribute('data-tid') || '')))
    .slice(0, 6)
    .map((b) => ({ aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), tid: b.getAttribute('data-tid'), ap: b.getAttribute('aria-pressed'), ac: b.getAttribute('aria-checked'), html: b.outerHTML.slice(0, 500) }));
  return { matched: !!m, narrow: m ? { aria: m.getAttribute('aria-label'), title: m.getAttribute('title'), tid: m.getAttribute('data-tid'), ap: m.getAttribute('aria-pressed'), ac: m.getAttribute('aria-checked'), html: m.outerHTML.slice(0, 700) } : null, wide };
}})()`;

// Teams caption probe: block .fui-ChatMessageCompact, author
// [data-tid="author"], text [data-tid="closed-caption-text"], region
// closed-caption-v2 wrappers — exactly what caption-speaker-observer
// uses for Teams.
const capProbeSrc = `(${function probe() {
  const regionSel = "[data-tid='closed-caption-v2-window-wrapper'],[data-tid='closed-captions-renderer'],[data-tid*='closed-caption' i]";
  const region = document.querySelector(regionSel);
  const blocks = [...document.querySelectorAll('.fui-ChatMessageCompact')];
  const rows = blocks.slice(-6).map((b) => ({
    author: (b.querySelector('[data-tid="author"]')?.textContent || '').trim(),
    text: (b.querySelector('[data-tid="closed-caption-text"]')?.textContent || '').trim(),
  })).filter((r) => r.author || r.text);
  return {
    hasRegion: !!region,
    blockCount: blocks.length,
    rows,
    names: [...new Set(rows.map((r) => r.author).filter(Boolean))],
    isReal: rows.some((r) => r.text && (r.text.match(/[A-Za-z]{2,}/g) || []).length >= 2),
    regionHtml: region ? region.outerHTML.slice(0, 4000) : null,
  };
}})()`;

test('real Teams DOM capture (admit bot, enable live captions, speak)', async () => {
  test.setTimeout(15 * 60 * 1000);
  patchManifestCsp();
  widenManifestForTeamsLive(); // also run on teams.live.com (consumer)

  const context = await chromium.launchPersistentContext('', {
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

  const page = await context.newPage();
  console.log('\n=== Opening Teams ===');
  await page.goto(TEAMS_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

  // Teams web pushes the desktop app — stay on the web client.
  for (let i = 0; i < 8; i += 1) {
    for (const rx of [/continue on this browser/i, /use the web app instead/i, /join on the web instead/i, /watch on the web instead/i]) {
      const b = page.getByRole('button', { name: rx }).first();
      if (await b.count().catch(() => 0)) { await b.click({ timeout: 4000 }).catch(() => {}); console.log('clicked:', rx.source); }
      const l = page.getByRole('link', { name: rx }).first();
      if (await l.count().catch(() => 0)) { await l.click({ timeout: 4000 }).catch(() => {}); }
    }
    if (await page.locator("input[placeholder*='name' i],[data-tid='prejoin-display-name-input']").count().catch(() => 0)) break;
    await page.waitForTimeout(2000);
  }

  const prejoin = await page.evaluate(() => ({
    inputs: [...document.querySelectorAll('input')].map((i) => ({ aria: i.getAttribute('aria-label'), ph: i.placeholder, tid: i.getAttribute('data-tid') })),
    buttons: [...document.querySelectorAll('button,[role="button"]')].map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 30),
  }));
  save('teams-prejoin.json', prejoin);
  console.log('PRE-JOIN buttons:', JSON.stringify(prejoin.buttons.slice(0, 12)));

  // Anonymous display name + Join now.
  const nameInput = page.locator("input[placeholder*='name' i],[data-tid='prejoin-display-name-input']").first();
  if (await nameInput.count().catch(() => 0)) {
    try { await nameInput.fill(BOT_NAME, { timeout: 5000 }); console.log('filled name'); } catch { /* signed in */ }
  }
  for (const rx of [/^join now$/i, /join now/i, /^join$/i]) {
    const b = page.getByRole('button', { name: rx }).first();
    if (await b.count().catch(() => 0)) { try { await b.click({ timeout: 5000 }); console.log('clicked join:', rx.source); break; } catch { /* next */ } }
  }

  // Wait for admission. Teams in-call → the mic toolbar control.
  console.log(`\n*** ACTION: ADMIT "${BOT_NAME}" from your Teams window. Waiting up to 4 min… ***\n`);
  const micSel = "#microphone-button,[data-tid='toggle-mute'],[data-tid='microphone-button'],[data-tid*='mute' i],button[aria-label*='microphone' i],button[title='Mute mic'],button[title='Unmute mic']";
  // The ACTUAL mute toggle on teams.live.com is title-only (no
  // data-tid/aria-label); the device-picker button matches
  // [data-tid*=microphone] and must NOT be clicked.
  const micClickSel = "button[title='Mute mic'],button[title='Unmute mic'],#microphone-button,[data-tid='toggle-mute'],[data-tid='microphone-button']";
  let inCall = false;
  for (let i = 0; i < 240; i += 1) {
    if (page.isClosed()) throw new Error('window closed before admit');
    if (await page.locator(micSel).count().catch(() => 0)) { inCall = true; break; }
    if (i % 15 === 0) console.log(`  …waiting to be admitted (${i}s) — admit "${BOT_NAME}"`);
    await page.waitForTimeout(1000);
  }
  if (!inCall) { save('teams-not-admitted.txt', await page.evaluate(() => document.body.innerText.slice(0, 800)).catch(() => '')); }
  expect(inCall, 'bot must be admitted into the Teams call').toBe(true);
  console.log('=== IN CALL ===\n');

  // --- Phase 1: mic control + teamsMicMuted().
  console.log('--- Phase 1: Teams mic control ---');
  const m1 = await page.evaluate(micSnapSrc);
  const d1 = await page.evaluate(teamsMicMutedSrc);
  console.log('mic (initial):', JSON.stringify(m1.narrow || m1.wide[0] || null));
  console.log('teamsMicMuted() →', JSON.stringify(d1));
  save('teams-mic-1.json', { m1, d1 });

  // Teams consumer mute control is title-only and resists synthetic
  // clicks — use Teams' real mute shortcut (Ctrl+Shift+M), the same
  // gesture a user makes. Click a neutral toolbar spot first so the
  // shortcut isn't swallowed by a focused control.
  void micClickSel;
  await page.locator(micClickSel).first().click({ timeout: 4000 }).catch(() => {});
  await page.keyboard.press('Control+Shift+M');
  await page.waitForTimeout(2000);
  const d2 = await page.evaluate(teamsMicMutedSrc);
  console.log('teamsMicMuted() after Ctrl+Shift+M →', JSON.stringify(d2));
  save('teams-mic-2.json', { snap: await page.evaluate(micSnapSrc), d2 });
  await page.keyboard.press('Control+Shift+M');
  await page.waitForTimeout(2000);
  const d3 = await page.evaluate(teamsMicMutedSrc);
  console.log('teamsMicMuted() restored →', JSON.stringify(d3));
  const micOk = d1.result !== null && d2.result !== null && d1.result !== d2.result;
  console.log(micOk ? '✅ Teams mic detection tracks the real toggle' : '❌ Teams mic detection BROKEN — see captures');

  // --- Phase 2: live captions / author cells.
  console.log('\n--- Phase 2: Teams live captions ---');
  console.log('*** ACTION: turn ON "Live captions" (More ••• → Language and speech) and SPEAK ~30s ***\n');
  const samples = []; let gotReal = null;
  for (let i = 0; i < 240; i += 1) {
    if (page.isClosed()) break;
    let s; try { s = await page.evaluate(capProbeSrc); } catch { await page.waitForTimeout(800); continue; }
    if (s.isReal || s.names.length) {
      console.log(`  [${i}s] names=${JSON.stringify(s.names)} rows=${JSON.stringify(s.rows.slice(-2))}`);
      samples.push({ t: i, ...s });
      if (s.isReal) { if (s.regionHtml) gotReal = s; if (samples.filter((x) => x.isReal).length >= 8) break; }
    } else if (i % 12 === 0) console.log(`  [${i}s] *** SPEAK NOW *** waiting for Teams captions (region=${s.hasRegion})…`);
    await page.waitForTimeout(1000);
  }
  save('teams-captions-samples.json', samples);
  if (gotReal) save('teams-caption-container.html', gotReal.regionHtml || '(none)');
  const names = [...new Set(samples.flatMap((s) => s.names || []))];
  console.log(`\nreal caption text captured: ${samples.some((s) => s.isReal) ? 'YES' : 'NO'}`);
  console.log(`author cell ([data-tid="author"]) resolved a NAME: ${names.length ? 'YES → ' + JSON.stringify(names) : 'NO'}`);
  console.log(samples.some((s) => s.isReal) && names.length
    ? '✅ Teams caption→speaker DOM works: observer would emit real-name timeline turns.'
    : '⚠️/❌ inconclusive or selectors stale — inspect tests/e2e/captures/teams-caption-container.html');

  console.log('\n=== Teams capture complete. Closing in 5s ===');
  await page.waitForTimeout(5000);
  await context.close();
});
