// Bundle content scripts as SELF-CONTAINED IIFE files and point the
// manifest at them directly — replacing crxjs's dynamic-import loaders.
//
// WHY: crxjs ships each content script as a tiny loader that does
//   import(chrome.runtime.getURL('assets/<chunk>.js'))
// On Chrome 130+ that dynamic import is blocked by the HOST PAGE's
// Content-Security-Policy (script-src) on strict sites like Google Meet
// and Microsoft Teams — so meet.js / teams.js / overlay.js never run
// ("Failed to fetch dynamically imported module" / "An unknown error
// occurred when fetching the script"). That kills the in-page features
// (speaker-timeline scrape, mic-mute observer, live-transcribe overlay)
// and cascades into recording / transcription.
//   Ref: crxjs/chrome-extension-tools#918 ("CSP Issue on Chrome 130+").
//
// FIX: esbuild-bundle each content script into a single IIFE with every
// dependency inlined — no import() at all — so there is nothing for any
// page CSP to block. The SW / offscreen / popup keep their normal ESM
// chunks (extension-page contexts are exempt from host-page CSP).
//
// Runs AFTER `vite build` (+ check-static). Idempotent.

import { build } from 'esbuild';
import {
  readFileSync, writeFileSync, existsSync, rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// Each content script entry → its self-contained IIFE output. ``match``
// identifies the crxjs loader currently referenced in the manifest.
const ENTRIES = [
  { src: 'src/content/meet.js', out: 'assets/meet.cs.js', match: 'meet.js-loader' },
  { src: 'src/content/teams.js', out: 'assets/teams.cs.js', match: 'teams.js-loader' },
  { src: 'src/transcribe/overlay.js', out: 'assets/overlay.cs.js', match: 'overlay.js-loader' },
];

if (!existsSync(path.join(dist, 'manifest.json'))) {
  console.error('[content-iife] dist/manifest.json missing — run "npm run build" first.');
  process.exit(1);
}

// 1. Bundle each content script as a single self-contained IIFE.
for (const e of ENTRIES) {
  await build({
    entryPoints: [path.join(root, e.src)],
    outfile: path.join(dist, e.out),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  });
}

// 2. Repoint manifest.content_scripts at the IIFE files and drop the
//    now-unused content-script CHUNK web_accessible_resources (the
//    chunks are inlined into the IIFE; HTML resources stay).
const mfPath = path.join(dist, 'manifest.json');
const mf = JSON.parse(readFileSync(mfPath, 'utf8'));

const loaderFiles = new Set();
for (const cs of mf.content_scripts ?? []) {
  cs.js = (cs.js ?? []).map((j) => {
    const e = ENTRIES.find((x) => j.includes(x.match));
    if (e) { loaderFiles.add(j); return e.out; }
    return j;
  });
}

if (Array.isArray(mf.web_accessible_resources)) {
  mf.web_accessible_resources = mf.web_accessible_resources
    .map((w) => ({ ...w, resources: (w.resources ?? []).filter((r) => r.endsWith('.html')) }))
    .filter((w) => w.resources.length > 0);
}

writeFileSync(mfPath, `${JSON.stringify(mf, null, 2)}\n`);

// 3. Remove the orphaned crxjs loader files (no longer referenced).
for (const f of loaderFiles) {
  const p = path.join(dist, f);
  try { rmSync(p, { force: true }); } catch { /* already gone */ }
}

// 4. Sanity: confirm the IIFE bundles carry NO bare import()/import-from
//    (which would re-introduce the CSP-blockable fetch).
for (const e of ENTRIES) {
  const code = readFileSync(path.join(dist, e.out), 'utf8');
  if (/\bimport\s*\(/.test(code) || /\bfrom\s*["']\.\//.test(code)) {
    console.error(`[content-iife] FAIL: ${e.out} still contains a dynamic/relative import.`);
    process.exit(1);
  }
}

console.log('[content-iife] content scripts bundled as IIFE:',
  ENTRIES.map((e) => e.out).join(', '));
console.log('[content-iife] manifest content_scripts repointed; loader files removed.');
