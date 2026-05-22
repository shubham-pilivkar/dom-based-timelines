// Live real-meeting probe for the DOM speaker-timeline pipeline.
//
// Joins an ACTUAL Google Meet / Microsoft Teams meeting in a real
// (headful-under-xvfb) Chromium, enables live captions, then injects
// the EXACT production `src/lib/caption-speaker-observer.js` with the
// EXACT per-platform option set used by `src/content/meet.js` /
// `src/content/teams.js`, and prints every SPEAKER_CHANGE turn it
// emits against the live DOM.
//
// The bot is a silent listener (fake media device) — a human speaks in
// the meeting so the platform's own caption engine attributes speech
// to real participant names, which is precisely what the observer
// parses. This is the only way to validate the selectors against the
// live, obfuscated DOM; unit tests can only prove the algorithm.
//
// Usage:
//   xvfb-run -a node tests/integration/live-caption-probe.mjs \
//     --platform=meet  --url='https://meet.google.com/abc-defg-hij' \
//     --name='MeetMinutes Probe' --seconds=180
//
//   xvfb-run -a node tests/integration/live-caption-probe.mjs \
//     --platform=teams --url='https://teams.microsoft.com/l/meetup-join/...' \
//     --name='MeetMinutes Probe' --seconds=180
//
// Exit 0 if >=1 caption-attributed SPEAKER_CHANGE turn was captured.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const PLATFORM = arg('platform', 'meet');
const URL = arg('url', '');
const BOT_NAME = arg('name', 'MeetMinutes Probe');
const SECONDS = parseInt(arg('seconds', '180'), 10);

if (!URL || !['meet', 'teams'].includes(PLATFORM)) {
  console.error('Usage: --platform=meet|teams --url=<meeting url> '
    + '[--name=<bot name>] [--seconds=<n>]');
  process.exit(2);
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// The injected enable-captions logic, mirroring src/content/meet.js
// enableMeetCaptions() / src/content/teams.js enableTeamsCaptions().
const ENABLE_FNS = {
  meet: `function () {
    try {
      if (document.querySelector('button[aria-label*="Turn off captions" i]')
        || document.querySelector('.NWpY1d, .xoMHSc')
        || document.querySelector('[role="region"][aria-label*="caption" i]')) return;
      for (const t of ['keydown', 'keyup']) {
        document.dispatchEvent(new KeyboardEvent(t, {
          key: 'c', code: 'KeyC', shiftKey: true, bubbles: true }));
      }
      const b = document.querySelector(
        'button[aria-label*="Turn on captions" i],'
        + 'button[aria-label*="captions" i]:not([aria-label*="off" i])');
      if (b) b.click();
    } catch (e) {}
  }`,
  teams: `function () {
    try {
      if (document.querySelector(
        "[data-tid='closed-caption-v2-window-wrapper'],"
        + "[data-tid='closed-captions-renderer'],[data-tid*='closed-caption' i]")) return;
      const more = document.querySelector(
        "button[data-tid='more-button'],button[id='callingButtons-showMoreBtn']");
      if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
      const lang = document.querySelector(
        "div[id='LanguageSpeechMenuControl-id'],[data-tid*='language-speech' i]");
      if (lang) lang.click();
      const cc = document.querySelector(
        "div[id='closed-captions-button'],"
        + '[data-tid*="closed-caption" i][role="menuitem"]');
      if (cc) cc.click();
    } catch (e) {}
  }`,
};

// Per-platform observer options — copied verbatim from the content
// scripts so we test the real shipped configuration.
const OBSERVER_OPTS = {
  meet: '{}', // meet.js passes only enableCaptions; defaults cover the rest
  teams: `{
    badgeSelectors:
      '[data-tid="author"], [data-tid*="author" i],'
      + '[class*="author" i], [data-self-name], [data-speaker-name]',
    regionSelectors:
      "[data-tid='closed-caption-v2-window-wrapper'],"
      + "[data-tid='closed-captions-renderer'],"
      + '[data-tid*="closed-caption" i], [data-tid*="caption" i], [aria-live]',
    blockSelector:
      '.fui-ChatMessageCompact, [data-tid="closed-caption-message"],'
      + '[data-tid="closed-caption-chat-message"]',
    textSelector: '[data-tid="closed-caption-text"]',
  }`,
};

async function dump(page, tag) {
  try {
    await mkdir('/tmp/mm-probe', { recursive: true });
    const p = `/tmp/mm-probe/${PLATFORM}-${tag}-${Date.now()}.png`;
    await page.screenshot({ path: p, fullPage: false });
    log('screenshot →', p);
  } catch { /* best-effort */ }
}

async function clickByText(page, texts, timeout = 4000) {
  for (const t of texts) {
    const el = page.locator(
      `button:has-text("${t}"), [role="button"]:has-text("${t}"), `
      + `span:has-text("${t}")`,
    ).first();
    try {
      await el.waitFor({ state: 'visible', timeout });
      await el.click({ timeout: 2000 });
      log(`clicked "${t}"`);
      return true;
    } catch { /* try next */ }
  }
  return false;
}

async function joinMeet(page) {
  log('navigating to Meet…');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  // Dismiss the cookie / "Got it" interstitials if present.
  await clickByText(page, ['Got it', 'Accept all', 'I agree'], 3000);
  // Guest name field (only when not signed in).
  try {
    const nameInput = page.locator('input[aria-label*="name" i], input[placeholder*="name" i]').first();
    await nameInput.waitFor({ state: 'visible', timeout: 6000 });
    await nameInput.fill(BOT_NAME);
    log('filled guest name');
  } catch { log('no guest-name field (signed in or different layout)'); }
  // Turn the bot's cam/mic off before joining (it's a silent listener).
  await clickByText(page, ['Turn off microphone', 'Turn off camera'], 1500);
  await page.waitForTimeout(1000);
  const joined = await clickByText(
    page,
    ['Ask to join', 'Join now', 'Join meeting'],
    8000,
  );
  if (!joined) { await dump(page, 'join-failed'); throw new Error('Meet: could not find a join button'); }
  log('join requested — waiting for admission (up to 120s)…');
  // Admitted once the leave/call control or caption button shows up.
  await page.waitForSelector(
    'button[aria-label*="Leave call" i], button[aria-label*="captions" i], [aria-live]',
    { timeout: 120000 },
  );
  log('admitted to Meet ✓');
}

async function joinTeams(page) {
  log('navigating to Teams…');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  // Teams shows an app/browser chooser; force the web client.
  await clickByText(page, [
    'Continue on this browser', 'Join on the web instead', 'Use the web app instead',
  ], 8000);
  await page.waitForTimeout(4000);
  // Name field for anonymous join.
  try {
    const nameInput = page.locator('input[placeholder*="name" i], input[data-tid="prejoin-display-name-input"]').first();
    await nameInput.waitFor({ state: 'visible', timeout: 10000 });
    await nameInput.fill(BOT_NAME);
    log('filled anonymous name');
  } catch { log('no name field (signed in or different layout)'); }
  await page.waitForTimeout(1000);
  const joined = await clickByText(page, ['Join now', 'Join meeting'], 8000);
  if (!joined) { await dump(page, 'join-failed'); throw new Error('Teams: could not find Join now'); }
  log('join requested — waiting for admission (up to 120s)…');
  await page.waitForSelector(
    "button[data-tid='hangup-main-btn'], button[data-tid*='hangup' i], "
    + "button[data-tid='more-button'], #hangup-button",
    { timeout: 120000 },
  );
  log('admitted to Teams ✓');
}

(async () => {
  const observerSrc = (await readFile(
    join(ROOT, 'src', 'lib', 'caption-speaker-observer.js'), 'utf8',
  )).replace(/^export\s+function/m, 'function');

  log(`launching Chromium (headful) for ${PLATFORM}…`);
  const profileDir = `/tmp/mm-probe-profile-${Date.now()}`;
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1280, height: 800 },
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
      '--no-sandbox',
    ],
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[probe]')) log('PAGE', t);
  });

  let ok = false;
  try {
    if (PLATFORM === 'meet') await joinMeet(page);
    else await joinTeams(page);

    await page.waitForTimeout(4000);
    await dump(page, 'in-meeting');

    // Mirror production: inject the SAME caption-hiding CSS the content
    // scripts add, so the screenshot proves captions stay invisible
    // while the observer still scrapes them from the DOM.
    const HIDE_CSS = PLATFORM === 'teams'
      ? `[data-tid='closed-caption-v2-window-wrapper'],
         [data-tid='closed-captions-renderer'],
         [data-tid*='closed-caption' i],
         [data-tid='closed-caption-message'],
         [data-tid='closed-caption-chat-message']{
           opacity:0!important;pointer-events:none!important;position:fixed!important;
           left:-100000px!important;top:-100000px!important;width:1px!important;
           height:1px!important;max-height:1px!important;overflow:hidden!important;
           z-index:-2147483647!important;}`
      : `[role="region"][aria-label*="caption" i],
         [jsname="dsyhDe"],[jsname="YSxPC"],[jsname="tgaKEf"],
         .a4cQT,.nMcdL,.iOzk7,.TBMuR,.bh44bd,.VbkSUe,.z38b6{
           opacity:0!important;pointer-events:none!important;position:fixed!important;
           left:-100000px!important;top:-100000px!important;width:1px!important;
           height:1px!important;max-height:1px!important;overflow:hidden!important;
           z-index:-2147483647!important;}`;
    await page.addStyleTag({ content: HIDE_CSS });
    log('injected production caption-HIDE CSS (captions must be invisible)');

    log('injecting production caption-speaker-observer + enabling captions…');
    await page.evaluate(({ src, enableFn, opts }) => {
      // eslint-disable-next-line no-eval
      (0, eval)(src); // defines startCaptionSpeakerObserver in page scope
      window.__mmTurns = [];
      const t0 = Date.now();
      // eslint-disable-next-line no-eval
      const enableOnce = (0, eval)(`(${enableFn})`);
      const base = {
        getElapsedSeconds: () => (Date.now() - t0) / 1000,
        isActive: () => true,
        onChange: (e) => {
          window.__mmTurns.push(e);
          console.log('[probe] SPEAKER_CHANGE ' + JSON.stringify(e));
        },
        onTelemetry: (n, p) => console.log('[probe] telemetry '
          + n + ' ' + JSON.stringify(p || {})),
        // Faithful to meet.js/teams.js: retry the enable, don't single-shot.
        enableCaptions: () => {
          const on = () => !!(
            document.querySelector('button[aria-label*="Turn off captions" i]')
            || document.querySelector('.NWpY1d, .xoMHSc')
            || document.querySelector('[role="region"][aria-label*="caption" i]')
            || document.querySelector("[data-tid*='closed-caption' i]"));
          enableOnce();
          let n = 0;
          const iv = setInterval(() => {
            if (on() || ++n > 10) { clearInterval(iv); return; }
            enableOnce();
          }, 3000);
        },
      };
      // eslint-disable-next-line no-eval
      const extra = (0, eval)(`(${opts})`);
      window.__mmObs = startCaptionSpeakerObserver({ ...base, ...extra });

      // Ground-truth diagnostics for the live (obfuscated) DOM.
      window.__mmDiag = () => {
        const capBtns = [...document.querySelectorAll('button,[role="button"]')]
          .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim())
          .filter((s) => /caption|subtitle|\bcc\b/i.test(s));
        const live = document.querySelector('[aria-live]');
        // Is the caption box actually visually hidden? Find the caption
        // region and check its on-screen geometry/opacity.
        const capRegion = document.querySelector(
          '[role="region"][aria-label*="caption" i],'
          + "[data-tid='closed-caption-v2-window-wrapper'],"
          + "[data-tid='closed-captions-renderer'],[data-tid*='closed-caption' i]",
        );
        let capVisible = null;
        if (capRegion) {
          const r = capRegion.getBoundingClientRect();
          const cs = getComputedStyle(capRegion);
          const onScreen = r.width > 2 && r.height > 2
            && r.right > 0 && r.bottom > 0
            && r.left < innerWidth && r.top < innerHeight;
          capVisible = onScreen && cs.visibility !== 'hidden'
            && parseFloat(cs.opacity || '1') > 0.05;
        }
        return {
          captionButtonLabels: [...new Set(capBtns)].slice(0, 12),
          ariaLivePresent: !!live,
          ariaLiveSample: live ? (live.textContent || '').trim().slice(0, 120) : '',
          meetBadge: document.querySelectorAll('.NWpY1d, .xoMHSc').length,
          teamsBlocks: document.querySelectorAll('.fui-ChatMessageCompact').length,
          teamsAuthor: document.querySelectorAll('[data-tid="author"]').length,
          captionRegionFound: !!capRegion,
          captionVisible: capVisible,
        };
      };
    }, { src: observerSrc, enableFn: ENABLE_FNS[PLATFORM], opts: OBSERVER_OPTS[PLATFORM] });

    // Log live-DOM ground truth a few times so we learn the real
    // selectors even if auto-enable or speech is missing this run.
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(6000);
      const d = await page.evaluate(() => window.__mmDiag());
      log('DIAG', JSON.stringify(d));
    }

    log(`observer live. Speak in the meeting now — capturing for ${SECONDS}s…`);
    const deadline = Date.now() + SECONDS * 1000;
    let lastCount = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(5000);
      const snap = await page.evaluate(() => ({
        turns: window.__mmTurns || [],
        hasCaptions: window.__mmObs ? window.__mmObs.hasCaptions() : false,
      }));
      if (snap.turns.length !== lastCount) {
        log(`turns=${snap.turns.length} hasCaptions=${snap.hasCaptions}`);
        lastCount = snap.turns.length;
      }
    }

    const result = await page.evaluate(() => {
      try { window.__mmObs && window.__mmObs.flush(); } catch (e) {}
      return {
        turns: window.__mmTurns || [],
        hasCaptions: window.__mmObs ? window.__mmObs.hasCaptions() : false,
      };
    });
    await dump(page, 'final');

    await mkdir('/tmp/mm-probe', { recursive: true });
    const outFile = `/tmp/mm-probe/${PLATFORM}-turns.json`;
    await writeFile(outFile, JSON.stringify(result, null, 2));
    log('────────── RESULT ──────────');
    log(`hasCaptions = ${result.hasCaptions}`);
    log(`SPEAKER_CHANGE turns captured = ${result.turns.length}`);
    for (const t of result.turns) {
      log(`  ${t.speaker_name}  [${t.start_time.toFixed(1)}s → ${t.end_time.toFixed(1)}s]`);
    }
    log(`artifact → ${outFile}`);
    ok = result.turns.length > 0;
  } catch (err) {
    log('ERROR:', err && err.message ? err.message : String(err));
    await dump(page, 'error');
  } finally {
    await context.close();
  }

  console.log(ok
    ? `✅ ${PLATFORM}: live DOM caption capture WORKS (turns recorded)`
    : `❌ ${PLATFORM}: no caption-attributed turns captured (see /tmp/mm-probe screenshots)`);
  process.exit(ok ? 0 : 1);
})();
