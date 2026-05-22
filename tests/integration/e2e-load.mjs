// Load the REAL built extension into Chromium and collect every
// runtime error from each MV3 context (service worker, popup, options).
// This catches the class of failure the Node harness can't: manifest
// parse errors, ES-module import failures, top-level exceptions, CSP
// violations — i.e. "so many errors when I run the extension".
import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');
const errors = [];
const note = (ctx, msg) => { errors.push({ ctx, msg }); console.log(`  ⚠ [${ctx}] ${msg}`); };

const context = await chromium.launchPersistentContext('', {
  // Let the --headless=new arg drive headlessness; passing headless:true
  // too makes Chromium pick old headless, which can't run extensions.
  headless: false,
  args: [
    '--headless=new',
    '--no-sandbox',
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
  ],
});

// MV3 service workers are lazy — they may not spin up until something
// pokes the extension. Open a tab first to give Chromium a beat to
// register, then poll for the worker for up to ~25s.
await context.newPage().then((p) => p.goto('about:blank')).catch(() => {});
let sw = context.serviceWorkers()[0];
for (let i = 0; i < 25 && !sw; i++) {
  sw = context.serviceWorkers()[0]
    || await context.waitForEvent('serviceworker', { timeout: 1000 }).catch(() => null);
}
if (!sw) {
  note('startup', 'service worker NEVER registered — manifest or SW top-level import failed');
} else {
  console.log('  ✓ service worker registered:', sw.url());
  sw.on('console', (m) => { if (m.type() === 'error') note('sw.console', m.text()); });
}
const extId = sw ? new URL(sw.url()).host : null;

// Re-evaluate SW errors by pinging GET_STATE through it (exercises the
// message router + state machine boot path).
if (sw) {
  try {
    const state = await sw.evaluate(async () => {
      return await chrome.storage.session.get('mm_session_state');
    });
    console.log('  ✓ SW session state readable:', JSON.stringify(state));
  } catch (e) {
    note('sw.eval', `GET state failed: ${e.message}`);
  }
}

// 2 & 3. Popup + Options pages — open each, collect console errors +
// uncaught exceptions thrown during render.
for (const [name, path] of [
  ['popup', 'src/popup/popup.html'],
  ['options', 'src/options/options.html'],
]) {
  if (!extId) break;
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') note(`${name}.console`, m.text()); });
  page.on('pageerror', (e) => note(`${name}.pageerror`, e.message));
  try {
    await page.goto(`chrome-extension://${extId}/${path}`, { waitUntil: 'load', timeout: 10000 });
    await page.waitForTimeout(1500); // let deferred init + message round-trips run
    const title = await page.title();
    console.log(`  ✓ ${name} rendered (title="${title}")`);
  } catch (e) {
    note(`${name}.load`, e.message);
  }
  await page.close();
}

await context.close();

console.log(`\n${'='.repeat(60)}`);
if (errors.length === 0) {
  console.log('✅ extension loaded cleanly — 0 runtime errors in SW/popup/options');
} else {
  console.log(`❌ ${errors.length} runtime error(s) collected from the loaded extension:`);
  for (const e of errors) console.log(`   [${e.ctx}] ${e.msg}`);
}
process.exit(errors.length ? 1 : 0);
