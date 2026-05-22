// Live real-meeting probe for the PARTICIPANT-TILE speaker-timeline
// path (the non-caption method). Joins a real Google Meet / Teams
// meeting in a headful-under-xvfb Chromium, injects the REAL
// production `src/lib/speaker-detector.js` state machine bundled with
// the EXACT tile-probe selectors from meet.js / teams.js, and prints
// every SPEAKER_CHANGE turn it emits against the live DOM. It also
// logs a per-tick DIAG (tiles found, who is "speaking" now, names) so
// we can see WHY a turn did or didn't fire.
//
// NEVER touches captions. The bot is a silent listener; a human (you)
// speaks so the meeting client lights its own active-speaker tile
// indicator — which is exactly what the detector reads.
//
// Usage:
//   xvfb-run -a node tests/integration/live-tile-probe.mjs \
//     --platform=meet  --url='https://meet.google.com/xxx' --seconds=180
//   xvfb-run -a node tests/integration/live-tile-probe.mjs \
//     --platform=teams --url='https://teams.live.com/meet/...' --seconds=180

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));

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
    + '[--name=<bot>] [--seconds=<n>]');
  process.exit(2);
}
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function dump(page, tag) {
  try {
    await mkdir('/tmp/mm-probe', { recursive: true });
    const p = `/tmp/mm-probe/tile-${PLATFORM}-${tag}-${Date.now()}.png`;
    await page.screenshot({ path: p });
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
    } catch { /* next */ }
  }
  return false;
}

async function joinMeet(page) {
  log('navigating to Meet…');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await clickByText(page, ['Got it', 'Accept all', 'I agree'], 3000);
  try {
    const n = page.locator('input[aria-label*="name" i], input[placeholder*="name" i]').first();
    await n.waitFor({ state: 'visible', timeout: 6000 });
    await n.fill(BOT_NAME);
    log('filled guest name');
  } catch { log('no guest-name field'); }
  await clickByText(page, ['Turn off microphone', 'Turn off camera'], 1500);
  await page.waitForTimeout(1000);
  const joined = await clickByText(page, ['Ask to join', 'Join now', 'Join meeting'], 8000);
  if (!joined) { await dump(page, 'join-failed'); throw new Error('Meet: no join button'); }
  log('join requested — admit the bot (≤120s)…');
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
  await clickByText(page, [
    'Continue on this browser', 'Join on the web instead', 'Use the web app instead',
  ], 8000);
  await page.waitForTimeout(4000);
  try {
    const n = page.locator('input[placeholder*="name" i], input[data-tid="prejoin-display-name-input"]').first();
    await n.waitFor({ state: 'visible', timeout: 10000 });
    await n.fill(BOT_NAME);
    log('filled anonymous name');
  } catch { log('no name field'); }
  await page.waitForTimeout(1000);
  const joined = await clickByText(page, ['Join now', 'Join meeting'], 8000);
  if (!joined) { await dump(page, 'join-failed'); throw new Error('Teams: no Join now'); }
  log('join requested — admit the bot (≤120s)…');
  await page.waitForSelector(
    "button[data-tid='hangup-main-btn'], button[data-tid*='hangup' i], "
    + "button[data-tid='more-button'], #hangup-button",
    { timeout: 120000 },
  );
  log('admitted to Teams ✓');
}

(async () => {
  // Bundle the REAL speaker-detector lib + verbatim tile probes.
  log('bundling production speaker-detector + tile probes…');
  const out = await build({
    entryPoints: [join(HERE, '_tile-probe-entry.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
  });
  const bundleSrc = out.outputFiles[0].text;

  const profileDir = `/tmp/mm-tileprobe-profile-${Date.now()}`;
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

    log('injecting production tile detector (NO captions touched)…');
    await page.evaluate(bundleSrc); // defines window.__mmTileStart
    await page.evaluate((p) => window.__mmTileStart(p), PLATFORM);

    log(`detector live. Speak in the meeting now — capturing ${SECONDS}s…`);
    const deadline = Date.now() + SECONDS * 1000;
    let last = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(5000);
      const snap = await page.evaluate(() => ({
        turns: window.__mmTurns || [],
        diag: window.__mmDiag ? window.__mmDiag() : null,
      }));
      log('DIAG ' + JSON.stringify(snap.diag));
      if (snap.turns.length !== last) {
        log(`turns=${snap.turns.length}`);
        last = snap.turns.length;
      }
    }

    const result = await page.evaluate(() => {
      try { window.__mmStop && window.__mmStop(); } catch (e) { /* noop */ }
      return { turns: window.__mmTurns || [] };
    });
    await dump(page, 'final');
    await mkdir('/tmp/mm-probe', { recursive: true });
    await writeFile(`/tmp/mm-probe/tile-${PLATFORM}-turns.json`,
      JSON.stringify(result, null, 2));
    log('────────── RESULT ──────────');
    log(`SPEAKER_CHANGE turns captured = ${result.turns.length}`);
    for (const t of result.turns) {
      log(`  ${t.speaker_name}  [${(t.start_time ?? 0).toFixed?.(1)
        ?? t.start_time}s → ${(t.end_time ?? 0).toFixed?.(1) ?? t.end_time}s]`);
    }
    ok = result.turns.length > 0;
  } catch (err) {
    log('ERROR:', err && err.message ? err.message : String(err));
    await dump(page, 'error');
  } finally {
    await context.close();
  }

  console.log(ok
    ? `✅ ${PLATFORM}: tile-detector timeline WORKS on the live DOM`
    : `❌ ${PLATFORM}: NO turns captured — tile selectors likely stale `
      + '(see /tmp/mm-probe screenshots + DIAG lines above)');
  process.exit(ok ? 0 : 1);
})();
