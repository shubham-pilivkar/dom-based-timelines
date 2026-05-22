// Real-Meet capture bot (HEADED, manual-assist).
//
// Joins the real meeting with the extension loaded, waits for YOU to
// admit it, then captures the genuine DOM the extension's detectors
// depend on and reports what those detectors actually return on real
// Meet — so we can fix selectors against ground truth.
//
//   Phase 1 (mic)      : dump the mic control, run meetMicMuted()'s
//                        exact logic, toggle the mic, dump again.
//   Phase 2 (captions) : while YOU speak with captions on, sample the
//                        caption region + badges and show the
//                        speaker-name / text the observer would emit.
//
// You drive it: admit the bot, turn on captions, talk on cue. Watch
// the terminal — it prints what to do and a countdown. Artifacts are
// written to tests/e2e/captures/.
//
// Run:  npx playwright test tests/e2e/realmeet-capture.spec.js --headed
// (channel defaults to 'chromium'; set MM_MEET_CHANNEL=chrome to use
//  installed Google Chrome if Meet blocks the bundled build.)

import { test, expect, chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchManifestCsp, EXTENSION_PATH } from './helpers/harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAP_DIR = path.join(__dirname, 'captures');
const MEET_URL = process.env.MM_MEET_URL || 'https://meet.google.com/hft-umov-kop';
const BOT_NAME = process.env.MM_BOT_NAME || 'MeetMinutes Capture Bot';

function save(name, data) {
  mkdirSync(CAP_DIR, { recursive: true });
  const file = path.join(CAP_DIR, name);
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  console.log(`  saved → tests/e2e/captures/${name}`);
}

// The EXACT detection logic from src/content/meet.js meetMicMuted(),
// run in-page against the live DOM so we compare code vs reality.
function meetMicMutedSource() {
  return `(${function detect() {
    try {
      const mic = document.querySelector(
        'button[aria-label*="microphone" i],'
        + '[role="button"][aria-label*="microphone" i],'
        + 'button[data-tooltip*="microphone" i],'
        + '[data-tooltip*="microphone" i][role="button"]',
      );
      if (!mic) return { result: null, why: 'no mic control matched' };
      const label = (mic.getAttribute('aria-label') || mic.getAttribute('data-tooltip') || '').toLowerCase();
      if (label) {
        if (label.includes('turn on microphone') || label.includes('unmute')) return { result: true, why: 'label says muted: ' + label };
        if (label.includes('turn off microphone') || label.includes('mute')) return { result: false, why: 'label says live: ' + label };
      }
      const dm = mic.matches('[data-is-muted]') ? mic : (mic.closest('[data-is-muted]') || mic.querySelector('[data-is-muted]'));
      const v = dm && dm.getAttribute('data-is-muted');
      if (v === 'true') return { result: true, why: 'data-is-muted=true' };
      if (v === 'false') return { result: false, why: 'data-is-muted=false' };
      const ap = mic.getAttribute('aria-pressed');
      if (ap === 'true') return { result: false, why: 'aria-pressed=true' };
      if (ap === 'false') return { result: true, why: 'aria-pressed=false' };
      return { result: null, why: 'mic found but no signal (label/dm/ap all empty)' };
    } catch (e) { return { result: null, why: 'threw ' + e.message }; }
  }})()`;
}

function snapshotMic() {
  return `(${function snap() {
    const sel = 'button[aria-label*="microphone" i],[role="button"][aria-label*="microphone" i],button[data-tooltip*="microphone" i],[data-tooltip*="microphone" i][role="button"]';
    const mic = document.querySelector(sel);
    // Also widen the net so we SEE what real Meet uses if the narrow
    // query misses (aria-label containing just "mic").
    const wide = [...document.querySelectorAll('button,[role="button"]')]
      .filter((b) => /mic/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-tooltip') || '')))
      .slice(0, 6)
      .map((b) => ({
        aria: b.getAttribute('aria-label'),
        tooltip: b.getAttribute('data-tooltip'),
        dataIsMuted: b.getAttribute('data-is-muted'),
        ariaPressed: b.getAttribute('aria-pressed'),
        role: b.getAttribute('role'),
        cls: b.className,
        html: b.outerHTML.slice(0, 600),
      }));
    return {
      narrowMatched: !!mic,
      narrow: mic ? {
        aria: mic.getAttribute('aria-label'),
        tooltip: mic.getAttribute('data-tooltip'),
        dataIsMuted: mic.getAttribute('data-is-muted'),
        ariaPressed: mic.getAttribute('aria-pressed'),
        html: mic.outerHTML.slice(0, 800),
      } : null,
      wide,
    };
  }})()`;
}

function captionSnapshot() {
  return `(${function snap() {
    const badgeSel = '.NWpY1d, .xoMHSc, [class*="caption" i] [class*="name" i],[data-self-name], [data-speaker-name]';
    const regionSel = '[aria-live], [jsname="tgaKEf"], [jsname="dsyhDe"], [data-tid*="caption" i]';
    const regions = [...document.querySelectorAll(regionSel)];
    const badges = [...document.querySelectorAll(badgeSel)];
    const region = regions.find((r) => (r.textContent || '').trim().length > 0) || regions[0] || null;
    return {
      regionCount: regions.length,
      badgeCount: badges.length,
      badgeNames: badges.slice(0, 8).map((b) => (b.textContent || '').trim()).filter(Boolean),
      regionText: region ? (region.textContent || '').trim().slice(0, 400) : null,
      regionHtml: region ? region.outerHTML.slice(0, 1500) : null,
      // First [aria-live] is the accessibility anchor the observer
      // leans on — show its attrs so we can confirm it still exists.
      ariaLiveAttrs: (() => {
        const al = document.querySelector('[aria-live]');
        return al ? { live: al.getAttribute('aria-live'), cls: al.className, html: al.outerHTML.slice(0, 300) } : null;
      })(),
    };
  }})()`;
}

test('real Meet DOM capture (manual: admit bot, enable captions, speak)', async () => {
  test.setTimeout(15 * 60 * 1000); // generous — you're driving it.
  patchManifestCsp();

  // Real Google Chrome — Meet rejects the bundled Playwright Chromium
  // ("browser not supported", no join UI). Override with
  // MM_MEET_CHANNEL=chromium only for debugging.
  const context = await chromium.launchPersistentContext('', {
    channel: process.env.MM_MEET_CHANNEL || 'chrome',
    headless: false,
    viewport: null,
    // Google Meet refuses browsers it flags as automated. Drop the
    // automation switches Playwright adds and the AutomationControlled
    // blink feature so navigator.webdriver isn't advertised.
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
  // Belt-and-suspenders: hide the webdriver flag before any page JS.
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch { /* sealed */ }
  });

  const page = await context.newPage();
  console.log('\n=== Opening', MEET_URL, '(real Chrome) ===');
  await page.goto(MEET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Meet's pre-join hydrates slowly — poll for the name field / a join
  // control for up to 45s instead of a fixed wait.
  const nameSel = 'input[aria-label*="name" i], input[placeholder*="name" i]';
  const dumpState = async (tag) => {
    if (page.isClosed()) return { closed: true, bodyText: '', inputs: [], buttons: [] };
    for (let a = 0; a < 2; a += 1) {
      try {
        const st = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600),
          inputs: [...document.querySelectorAll('input')].map((i) => ({ aria: i.getAttribute('aria-label'), ph: i.placeholder })),
          buttons: [...document.querySelectorAll('button,[role="button"]')].map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 30),
        }));
        save(`state-${tag}.json`, st);
        await page.screenshot({ path: path.join(CAP_DIR, `state-${tag}.png`) }).catch(() => {});
        return st;
      } catch { await page.waitForTimeout(800); } // navigation race — retry once
    }
    return { bodyText: '', inputs: [], buttons: [], nav: true };
  };

  // Resilient join: for up to ~4 min, on each tick fill the guest name
  // + click a join control; if Meet bounced us to the can't-join page
  // (no host yet / automation flag), reload and try again. Succeeds the
  // moment the in-call mic control appears OR we're held in the lobby.
  const micSelEarly = 'button[aria-label*="microphone" i],[role="button"][aria-label*="microphone" i],button[data-tooltip*="microphone" i],[data-tooltip*="microphone" i][role="button"]';
  let joined = false;
  for (let i = 0; i < 80; i += 1) { // ~4 min (3s/tick)
    if (page.isClosed()) throw new Error('browser window was closed before join');
    if (await page.locator(micSelEarly).count().catch(() => 0)) { joined = true; break; }
    const st = await dumpState(i === 0 ? 'load' : 'prejoin');
    const lobby = /asking to be let in|you'?ll join when|waiting for the host|wait(ing)? to be (let|admitted)/i.test(st.bodyText);
    console.log(`[join ${i * 3}s] "${st.title || ''}" inputs=${st.inputs.length} lobby=${lobby} buttons=${JSON.stringify(st.buttons.slice(0, 6))}`);
    if (lobby) { console.log('  in lobby — waiting for you to admit'); joined = true; break; }

    const reject = /can'?t join this (video )?call|you can'?t join|return to home screen|check your meeting code|not supported/i
      .test(st.bodyText) && st.inputs.length === 0;
    if (reject) {
      console.log('  bounced to can\'t-join — reloading & retrying (ensure you are IN the meeting as host)');
      await page.goto(MEET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
      continue;
    }

    const ni = page.locator(nameSel).first();
    if (await ni.count().catch(() => 0)) {
      try { await ni.fill(BOT_NAME, { timeout: 3000 }); } catch { /* not ready */ }
    }
    for (const rx of [/continue without (microphone|camera)/i, /^got it$/i, /dismiss/i]) {
      const d = page.getByRole('button', { name: rx }).first();
      if (await d.count().catch(() => 0)) await d.click({ timeout: 2000 }).catch(() => {});
    }
    for (const rx of [/ask to join/i, /join now/i, /^join$/i]) {
      const b = page.getByRole('button', { name: rx }).first();
      if (await b.count().catch(() => 0)) {
        try { await b.click({ timeout: 3000 }); console.log('  clicked join:', rx.source); } catch { /* retry */ }
        break;
      }
    }
    await page.waitForTimeout(3000);
  }
  if (!joined) {
    await dumpState('join-failed');
    throw new Error('Never reached lobby/in-call in ~4 min — see tests/e2e/captures/state-*.png (automation flag or no host).');
  }

  // --- Wait for admission. YOU admit the bot from your host window.
  console.log('\n*** ACTION: in your Meet window, ADMIT "' + BOT_NAME + '" now. Waiting up to 4 min… ***\n');
  const micSel = 'button[aria-label*="microphone" i],[role="button"][aria-label*="microphone" i],button[data-tooltip*="microphone" i],[data-tooltip*="microphone" i][role="button"]';
  let inCall = false;
  for (let i = 0; i < 240; i += 1) {
    if (page.isClosed()) throw new Error('browser window was closed while waiting for admission');
    if (await page.locator(micSel).count().catch(() => 0)) { inCall = true; break; }
    if (i % 15 === 0) console.log(`  …still waiting to be admitted (${i}s) — admit "${BOT_NAME}" in your Meet window`);
    await page.waitForTimeout(1000);
  }
  if (!inCall) {
    const dump = await page.evaluate(() => document.body.innerText.slice(0, 800));
    save('not-admitted-body.txt', dump);
    console.log('NOT ADMITTED in time. Body text saved.');
  }
  expect(inCall, 'bot must be admitted into the call (you admit it)').toBe(true);
  console.log('=== IN CALL ===\n');

  // --- PHASE 1: mic-button DOM + meetMicMuted() ground truth.
  console.log('--- Phase 1: mic control ---');
  const micBefore = await page.evaluate(snapshotMic());
  const detBefore = await page.evaluate(meetMicMutedSource());
  console.log('mic snapshot (initial):', JSON.stringify(micBefore.narrow || micBefore.wide[0] || null));
  console.log('meetMicMuted() →', JSON.stringify(detBefore));
  save('mic-1-initial.json', { micBefore, detBefore });

  // Toggle the mic via its button, capture the muted state.
  const micBtn = page.locator(micSel).first();
  await micBtn.click({ timeout: 5000 }).catch(() => console.log('mic click failed'));
  await page.waitForTimeout(1500);
  const micToggled = await page.evaluate(snapshotMic());
  const detToggled = await page.evaluate(meetMicMutedSource());
  console.log('mic snapshot (after toggle):', JSON.stringify(micToggled.narrow || micToggled.wide[0] || null));
  console.log('meetMicMuted() →', JSON.stringify(detToggled));
  save('mic-2-toggled.json', { micToggled, detToggled });

  // Toggle back.
  await micBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const detRestored = await page.evaluate(meetMicMutedSource());
  console.log('meetMicMuted() (restored) →', JSON.stringify(detRestored));
  save('mic-3-restored.json', { detRestored });

  const micDetectionWorks = detBefore.result !== null
    && detToggled.result !== null
    && detBefore.result !== detToggled.result;
  console.log(micDetectionWorks
    ? '✅ mic detection tracks the real toggle'
    : '❌ mic detection BROKEN on real Meet — selectors need fixing (see captures)');

  // --- PHASE 2: captions / speaker badges while you speak.
  console.log('\n--- Phase 2: captions ---');

  // Auto-enable captions so we don't depend on the user finding the
  // button. Try the visible control, several aria-labels, then the
  // 'c' shortcut as a last resort.
  let ccClicked = false;
  for (const rx of [/turn on captions/i, /^captions$/i, /closed captions/i, /\bcc\b/i]) {
    const b = page.getByRole('button', { name: rx }).first();
    if (await b.count().catch(() => 0)) {
      try { await b.click({ timeout: 3000 }); ccClicked = true; console.log('clicked captions control:', rx.source); break; } catch { /* next */ }
    }
  }
  if (!ccClicked) { await page.keyboard.press('c').catch(() => {}); console.log("pressed 'c' to toggle captions"); }
  // A language dialog sometimes appears.
  for (const rx of [/^apply$/i, /^done$/i, /^ok$/i]) {
    const b = page.getByRole('button', { name: rx }).first();
    if (await b.count().catch(() => 0)) await b.click({ timeout: 1500 }).catch(() => {});
  }

  console.log('\n*** ACTION: SPEAK in the meeting (a few sentences). Waiting up to 4 min for real captions… ***\n');

  // Snapshot that ALSO dumps the full caption container + runs the
  // EXACT speakerOf()/textOf() logic from caption-speaker-observer.js
  // against the live DOM, so we validate the real selectors.
  const captionProbe = `(${function probe() {
    const badgeSel = '.NWpY1d, .xoMHSc, [class*="caption" i] [class*="name" i],[data-self-name], [data-speaker-name]';
    // Precise: the captions viewport is the labelled region. Fall back
    // to the current/older jsname containers.
    const region = document.querySelector('[role="region"][aria-label*="caption" i]')
      || document.querySelector('[jsname="dsyhDe"]')
      || document.querySelector('[jsname="tgaKEf"]')
      || null;
    // Cleaned text = region text MINUS any <button> labels (the
    // "Jump to bottom" affordance) and obvious junk.
    let cleaned = '';
    if (region) {
      const clone = region.cloneNode(true);
      clone.querySelectorAll('button').forEach((b) => b.remove());
      cleaned = (clone.textContent || '').replace(/\\s+/g, ' ').trim();
    }
    const JUNK = /^(jump to|turn on|turn off|captions? )/i;
    const isReal = cleaned.length > 0
      && !JUNK.test(cleaned)
      && (cleaned.match(/[A-Za-z]{2,}/g) || []).length >= 2;
    const badges = [...(region ? region.querySelectorAll(badgeSel) : [])]
      .map((b) => (b.textContent || '').trim())
      .filter((s) => s && s.length >= 2 && s.length <= 60);
    return {
      hasRegion: !!region,
      regionLabel: region ? region.getAttribute('aria-label') : null,
      cleanedText: cleaned.slice(0, 300),
      isRealCaption: isReal,
      badgeNames: [...new Set(badges)].slice(0, 8),
      badgeMatched: badges.length > 0,
      // Full region HTML — only when there's a real caption line, so
      // we capture the actual speaker-name element to fix selectors.
      captionContainerHtml: (isReal && region) ? region.outerHTML.slice(0, 6000) : null,
    };
  }})()`;

  const samples = [];
  let gotReal = null;
  let realCount = 0;
  for (let i = 0; i < 240; i += 1) {
    if (page.isClosed()) break;
    let snap;
    try { snap = await page.evaluate(captionProbe); } catch { await page.waitForTimeout(800); continue; }
    if (snap.isRealCaption || snap.badgeMatched) {
      console.log(`  [${i}s] badge=${snap.badgeMatched} names=${JSON.stringify(snap.badgeNames)} text="${(snap.cleanedText || '').slice(0, 100)}"`);
      samples.push({ t: i, ...snap });
      if (snap.isRealCaption) {
        realCount += 1;
        if (snap.captionContainerHtml) gotReal = snap;
        // Collect ~8s of evolving real caption DOM, then stop.
        if (realCount >= 8) break;
      }
    } else if (i % 10 === 0) {
      console.log(`  [${i}s] *** SPEAK NOW *** waiting for real caption text (region=${snap.hasRegion ? snap.regionLabel : 'none'})…`);
    }
    await page.waitForTimeout(1000);
  }
  save('captions-samples.json', samples);
  if (gotReal) save('caption-container.html', gotReal.captionContainerHtml || '(none)');

  const names = [...new Set(samples.flatMap((s) => s.badgeNames || []))];
  const anyReal = samples.some((s) => s.isRealCaption);
  console.log(`\nreal caption text captured: ${anyReal ? 'YES' : 'NO'}`);
  console.log(`speaker badge (.NWpY1d/.xoMHSc/…) resolved a NAME: ${names.length ? 'YES → ' + JSON.stringify(names) : 'NO'}`);
  if (!anyReal) {
    console.log('⚠️ No real caption text — no speech transcribed. (Issue #2/#3 inconclusive — speak louder/longer.)');
  } else if (names.length) {
    console.log('✅ caption→speaker DOM works on real Meet: observer would emit real-name timeline turns.');
  } else {
    console.log('❌ caption text present but NO name badge → badge selectors are STALE. '
      + 'See tests/e2e/captures/caption-container.html — fix badgeSelectors in caption-speaker-observer.js to match.');
  }

  console.log('\n=== Capture complete. Artifacts in tests/e2e/captures/. Closing in 5s ===');
  await page.waitForTimeout(5000);
  await context.close();
});
