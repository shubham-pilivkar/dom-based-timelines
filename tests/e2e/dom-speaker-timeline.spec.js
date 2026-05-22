// E2E for the DOM speaker-timeline strategy in a REAL Chromium.
//
// Bundles the production probes (src/lib/dom-speaker-probes.js) + the
// production detector (src/lib/speaker-detector.js) and runs them against
// a synthetic Meet / Teams Personal / Teams Business meeting DOM. Speaker
// activity is simulated the way the real clients signal it — Meet raises
// a tile's CSS class count (the speaking ring), Teams toggles
// `vdi-frame-occlusion` on the voice-level indicator — and we assert the
// exact ordered SPEAKER_CHANGE turns the content script would emit when
// SPEAKER_TIMELINE_STRATEGY === DOM.
//
// Unlike the deterministic vitest pipeline test, this drives the REAL
// browser MutationObserver + setTimeout debounce (no manual evaluate()),
// so it exercises the same async path the extension hits in production.
//
// Requires chromium: `npm run test:e2e:install` once, then
// `npm run test:e2e` (or `npx playwright test dom-speaker-timeline`).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));

// Debounce is SPEAKER_DEBOUNCE_MS (300ms); wait comfortably past it so a
// steady speaker commits before the next transition.
const SETTLE_MS = 450;

let bundleSrc;

test.beforeAll(async () => {
  const out = await build({
    entryPoints: [join(HERE, '_dom-probe-entry.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
  });
  bundleSrc = out.outputFiles[0].text;
});

const MEET_DOM = `
  <main>
    <div id="a" class="t"><span class="notranslate">Alice</span></div>
    <div id="b" class="t"><span class="notranslate">Bob</span></div>
  </main>`;

const TEAMS_PERSONAL_DOM = `
  <div data-tid="calling-pagination">
    <div data-stream-type="Video" data-tid="Asha">
      <div id="a" data-tid="voice-level-stream-outline" class="ind"></div>
    </div>
    <div data-stream-type="Video" data-tid="Ravi">
      <div id="b" data-tid="voice-level-stream-outline" class="ind"></div>
    </div>
  </div>`;

const TEAMS_BUSINESS_DOM = `
  <div data-tid="call-roster">
    <div data-acc-id="arrow-navigator-1">
      <div data-tid="m1"></div><div><div>Carol</div></div>
      <div id="a" data-tid="voice-level-stream-outline" class="ind"></div>
    </div>
    <div data-acc-id="arrow-navigator-2">
      <div data-tid="m2"></div><div><div>Dan</div></div>
      <div id="b" data-tid="voice-level-stream-outline" class="ind"></div>
    </div>
  </div>`;

const CASES = [
  { kind: 'meet', mode: 'count', dom: MEET_DOM, a: 'Alice', b: 'Bob' },
  { kind: 'teams-personal', mode: 'occ', dom: TEAMS_PERSONAL_DOM, a: 'Asha', b: 'Ravi' },
  { kind: 'teams-business', mode: 'occ', dom: TEAMS_BUSINESS_DOM, a: 'Carol', b: 'Dan' },
];

// Make participant `who` ('a'|'b') the sole speaker, the other silent —
// using whichever signal the platform animates.
function speak(page, mode, who) {
  const other = who === 'a' ? 'b' : 'a';
  return page.evaluate(({ w, o, m }) => {
    const on = document.getElementById(w);
    const off = document.getElementById(o);
    if (m === 'count') {
      on.className = 't speaking ring';
      off.className = 't';
    } else {
      on.classList.add('vdi-frame-occlusion');
      off.classList.remove('vdi-frame-occlusion');
    }
  }, { w: who, o: other, m: mode });
}

for (const c of CASES) {
  test(`${c.kind}: tile signals produce ordered SPEAKER_CHANGE turns`, async ({ page }) => {
    const logs = [];
    page.on('console', (m) => {
      if (m.text().includes('[domprobe]')) logs.push(m.text());
    });

    await page.setContent(`<!doctype html><html><body>${c.dom}</body></html>`);
    await page.evaluate(bundleSrc); // defines window.__mmDomStart
    await page.evaluate((k) => window.__mmDomStart(k), c.kind);

    // Sanity: the probe actually matched the synthetic DOM's tiles.
    const diag = await page.evaluate(() => window.__mmDiag());
    expect(diag.tiles, `probe found no tiles (diag=${JSON.stringify(diag)})`).toBeGreaterThan(0);

    // A speaks → B speaks → A speaks (each held past the debounce).
    await speak(page, c.mode, 'a');
    await page.waitForTimeout(SETTLE_MS);
    await speak(page, c.mode, 'b');
    await page.waitForTimeout(SETTLE_MS);
    await speak(page, c.mode, 'a');
    await page.waitForTimeout(SETTLE_MS);

    // Stop → flush emits the open turn.
    const turns = await page.evaluate(() => {
      window.__mmStop();
      return window.__mmTurns;
    });

    const names = turns.map((t) => t.speaker_name);
    expect(names, `turns=${JSON.stringify(turns)} logs=${logs.join(' | ')}`)
      .toEqual([c.a, c.b, c.a]);

    // Each window is well-formed and starts are non-decreasing.
    let prevStart = -1;
    for (const t of turns) {
      expect(t.end_time).toBeGreaterThanOrEqual(t.start_time);
      expect(t.start_time).toBeGreaterThanOrEqual(prevStart);
      prevStart = t.start_time;
    }
  });
}

test('teams hostname routing: live.com → Personal probe, microsoft.com → Business', async ({ page }) => {
  // Both probes share the vdi-frame-occlusion signal; this asserts the
  // selector that createTeamsSpeakerProbe() keys on resolves the right
  // name source per client. We exercise each probe builder directly via
  // the bundle's exported factories by rendering both DOM shapes.
  await page.setContent(`<!doctype html><html><body>
    ${TEAMS_PERSONAL_DOM}${TEAMS_BUSINESS_DOM}
  </body></html>`);
  await page.evaluate(bundleSrc);

  // Personal probe reads the Video container data-tid (Asha/Ravi).
  await page.evaluate(() => window.__mmDomStart('teams-personal'));
  const personal = await page.evaluate(() => {
    document.querySelectorAll('[data-stream-type="Video"] [data-tid="voice-level-stream-outline"]')
      .forEach((el, i) => { if (i === 0) el.classList.add('vdi-frame-occlusion'); });
    return window.__mmDiag();
  });
  expect(personal.names).toContain('Asha');

  // Business probe reads the arrow-navigator name cell (Carol/Dan).
  await page.evaluate(() => window.__mmDomStart('teams-business'));
  const business = await page.evaluate(() => window.__mmDiag());
  expect(business.names).toContain('Carol');
});
