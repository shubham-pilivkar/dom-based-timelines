// Mirror the freshly-built dist/ to a NON-OneDrive folder Chrome can
// load without sync interference.
//
// Why: loading the unpacked extension from a OneDrive-synced path
// (…\OneDrive\…\dist) lets OneDrive lock / dehydrate the freshly built
// files while Chrome is fetching the service-worker script — which
// surfaces as "An unknown error occurred when fetching the script" in
// chrome://extensions every time the extension is reloaded after a
// build. Loading from a plain local folder avoids it.
//
// Usage:  npm run sync:ext        (after `npm run build`)
//         npm run build:ext       (build + sync in one step)
// Override target with MM_EXT_DIR (default C:\meetminutes-ext\dist).

import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');
const destDir = process.env.MM_EXT_DIR || 'C:\\meetminutes-ext\\dist';

if (!existsSync(distDir)) {
  console.error(`[sync:ext] dist not found at ${distDir} — run "npm run build" first.`);
  process.exit(1);
}

// Clean target so renamed/hashed chunks from a previous build don't
// linger and confuse Chrome's module loader.
try { rmSync(destDir, { recursive: true, force: true }); } catch { /* first run */ }
mkdirSync(destDir, { recursive: true });
cpSync(distDir, destDir, { recursive: true });

console.log(`[sync:ext] copied dist → ${destDir}`);
console.log('[sync:ext] In chrome://extensions, load (or point) the unpacked');
console.log(`[sync:ext] extension at: ${destDir}`);
