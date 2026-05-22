// Static / packaging audit. Catches the class of bug that only bites
// when the extension is actually installed: a manifest permission
// gap, a CSP that blocks the backend, a content-script file the build
// didn't emit, or a dist that drifted from src (e.g. the T1 fix not
// rebuilt). No browser needed — pure file + JSON checks.
import { readFile, access, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DIST = join(ROOT, 'dist');
const out = [];
const ok = (n, d = '') => { out.push({ ok: true, n }); console.log(`  ✅ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d) => { out.push({ ok: false, n, d }); console.log(`  ❌ ${n} — ${d}`); };
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const mfSrc = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
const mfDist = (await exists(join(DIST, 'manifest.json')))
  ? JSON.parse(await readFile(join(DIST, 'manifest.json'), 'utf8')) : null;

console.log('\n— manifest —');
mfSrc.manifest_version === 3 ? ok('manifest_version is 3')
  : bad('manifest_version', `got ${mfSrc.manifest_version}`);

// desktopCapture intentionally removed — screen capture now uses
// getDisplayMedia() in the offscreen doc, which needs no permission.
// activeTab IS required: the Ctrl+Shift+R / Ctrl+Shift+T keyboard
// commands rely on the activeTab grant to satisfy tabCapture's
// "extension has been invoked for the current page" requirement
// (see service-worker.js chrome.commands.onCommand handler). Without
// it, the user must click the toolbar icon every time — defeats the
// shortcut. Specifically broken when the user is screen-sharing and
// has jumped between tabs/windows.
const NEED_PERMS = ['tabCapture', 'activeTab', 'storage', 'offscreen', 'tabs', 'alarms', 'notifications'];
const missP = NEED_PERMS.filter((p) => !(mfSrc.permissions || []).includes(p));
missP.length ? bad('permissions', `missing: ${missP}`) : ok('all required permissions present', NEED_PERMS.join(','));

const HOSTS = mfSrc.host_permissions || [];
for (const h of ['https://meet.google.com/*', 'https://teams.microsoft.com/*']) {
  HOSTS.includes(h) ? ok(`host_permission ${h}`) : bad('host_permission', `missing ${h}`);
}
HOSTS.some((h) => /meetminutes\.in/.test(h)) ? ok('backend host permission present')
  : bad('host_permission', 'no *.meetminutes.in entry — API calls blocked on install');
// Loopback MUST be in ``host_permissions`` (granted at install), NOT
// ``optional_host_permissions``. The desktop bridge dials
// ws://127.0.0.1:<port> at runtime; an optional (ungranted) permission
// silently blocks that WebSocket → the desktop recorder stops getting
// mute / caption / speaker events. (Moving it to optional for a CWS
// pass broke exactly this — keep it in host_permissions for the
// working build; revisit only as the final pre-submission step.)
const HOSTS_ALL = [
  ...(mfSrc.host_permissions || []),
  ...(mfSrc.optional_host_permissions || []),
];
(mfSrc.host_permissions || []).some((h) => /127\.0\.0\.1|localhost/.test(h))
  ? ok('loopback host_permission present (desktop bridge works at install)')
  : (HOSTS_ALL.some((h) => /127\.0\.0\.1|localhost/.test(h))
    ? bad('host_permission', 'localhost is OPTIONAL — desktop bridge WS will be blocked until runtime-granted; move to host_permissions')
    : bad('host_permission', 'no localhost entry — desktop bridge cannot connect'));

console.log('\n— content scripts —');
const cs = mfSrc.content_scripts || [];
const meetCs = cs.find((c) => (c.matches || []).some((m) => m.includes('meet.google.com')));
const teamsCs = cs.find((c) => (c.matches || []).some((m) => m.includes('teams.microsoft.com')));
meetCs ? ok('Meet content script registered') : bad('content_scripts', 'no Meet match');
teamsCs ? ok('Teams content script registered') : bad('content_scripts', 'no Teams match');
const overlay = cs.find((c) => (c.js || []).some((j) => j.includes('overlay')));
overlay ? ok('transcribe overlay content script registered') : bad('content_scripts', 'overlay not injected');
for (const c of cs) for (const j of c.js || []) {
  (await exists(join(ROOT, j))) ? ok(`src exists: ${j}`) : bad('content_script file', `${j} missing in src`);
}

console.log('\n— CSP —');
const csp = (mfSrc.content_security_policy && mfSrc.content_security_policy.extension_pages) || '';
/connect-src[^;]*meetminutes\.in/.test(csp) ? ok('CSP connect-src allows backend')
  : bad('CSP', 'connect-src does not allow meetminutes.in — fetch/WS blocked');
// The live-transcribe streaming socket is wss:// to the PUBLIC backend
// host. https://*.meetminutes.in does NOT cover the wss: scheme — a
// missing wss entry silently CSP-blocks every transcription WS (the
// bug that made live-transcribe never connect in the real extension).
/connect-src[^;]*wss:\/\/(\*|api)\.meetminutes\.in/.test(csp)
  ? ok('CSP connect-src allows wss:// backend (live-transcribe stream)')
  : bad('CSP', 'connect-src missing wss://*.meetminutes.in — transcription WS CSP-blocked');
/connect-src[^;]*ws:\/\/(127\.0\.0\.1|localhost)/.test(csp) ? ok('CSP allows loopback ws (bridge)')
  : bad('CSP', 'connect-src blocks loopback ws — bridge fails');
/object-src 'self'|object-src 'none'/.test(csp) ? ok('CSP object-src locked down')
  : bad('CSP', 'object-src not restricted');

console.log('\n— background / action / offscreen —');
mfSrc.background && mfSrc.background.service_worker ? ok('background.service_worker set', mfSrc.background.service_worker)
  : bad('background', 'no service_worker');
mfSrc.background.type === 'module' ? ok('SW is type=module (ES imports work)')
  : bad('background', 'SW not type=module — bare `import` will throw on install');
mfSrc.action && mfSrc.action.default_popup ? ok('action.default_popup set') : bad('action', 'no popup');
mfSrc.options_page ? ok('options_page set') : bad('options_page', 'missing');
const war = mfSrc.web_accessible_resources || [];
war.some((w) => (w.resources || []).some((r) => r.includes('offscreen.html')))
  ? ok('offscreen.html is web_accessible') : bad('web_accessible_resources', 'offscreen.html not exposed');
mfSrc.commands && mfSrc.commands['toggle-recording'] && mfSrc.commands['toggle-transcribe']
  ? ok('keyboard commands declared') : bad('commands', 'toggle-recording/transcribe missing');

console.log('\n— dist build parity —');
if (!mfDist) { bad('dist', 'dist/manifest.json missing — run npm run build'); }
else {
  ok('dist/manifest.json present');
  const swPath = join(DIST, mfDist.background.service_worker);
  (await exists(swPath)) || (await exists(join(DIST, 'service-worker-loader.js')))
    ? ok('dist SW entry present') : bad('dist', `SW entry ${mfDist.background.service_worker} missing`);
  for (const c of mfDist.content_scripts || []) for (const j of c.js || []) {
    (await exists(join(DIST, j))) ? ok(`dist content script: ${j}`) : bad('dist', `${j} missing in dist`);
  }
  // T1 fix must be in the shipped popup.
  const distPopup = await readFile(join(DIST, 'src/popup/popup.html'), 'utf8').catch(() => '');
  /value="en"\s+selected/.test(distPopup)
    ? ok('T1 fix shipped: popup defaults to English (not auto)')
    : bad('dist', 'T1 fix NOT in dist popup.html — rebuild required');
  // Detached recording-control window must be built (SW opens it via
  // chrome.windows.create using chrome.runtime.getURL — no WAR needed,
  // but the page + its module script must exist in dist).
  (await exists(join(DIST, 'src/control/control.html')))
    ? ok('dist control window: src/control/control.html')
    : bad('dist', 'src/control/control.html missing in dist — rebuild required');
  // The transcribe overlay builds its shadow-root <style> from a JS
  // template literal. A stray backtick inside that CSS (e.g. a
  // ``foo`` doc-comment) silently corrupts the literal at runtime →
  // ensureOverlay() throws TypeError → the overlay NEVER renders (it
  // was broken this way for the entire project history). Guard: the
  // ``_style.textContent = \`…\``` CSS body must contain zero backticks.
  const ovSrc = await readFile(join(ROOT, 'src/transcribe/overlay.js'), 'utf8').catch(() => '');
  const ovCss = ovSrc.match(/_style\.textContent\s*=\s*`([\s\S]*?)`;/);
  if (!ovCss) {
    bad('overlay', 'could not locate the overlay _style.textContent CSS template');
  } else {
    ovCss[1].includes('`')
      ? bad('overlay', 'overlay CSS template contains a backtick — corrupts the literal, overlay will not render')
      : ok('overlay CSS template is backtick-clean (renders)');
  }
  // The live-transcribe AudioWorklet is loaded at runtime via
  // chrome.runtime.getURL('transcribe-worklet.js'). It's a runtime
  // string crxjs/Vite cannot statically see, so it MUST ship via
  // public/ (verbatim → dist root). A missing worklet silently breaks
  // ALL live transcription (addModule 404 → audio_worklet_load_failed
  // → channel_closed). Guard both the asset AND that the offscreen
  // points at the stable path (not a src/ or hashed path).
  (await exists(join(DIST, 'transcribe-worklet.js')))
    ? ok('dist transcribe worklet: transcribe-worklet.js (stable path)')
    : bad('dist', 'transcribe-worklet.js MISSING in dist — live-transcribe audio pipeline cannot start');
  // Recording-side noise gate. Same shipping pattern as
  // transcribe-worklet (public/ → dist root verbatim); same risk
  // class if it goes missing — but the failure mode is gentler
  // (recording continues, just ungated). Pin both the asset and
  // that the audio-mixer chunk requests the stable path.
  (await exists(join(DIST, 'noise-gate-worklet.js')))
    ? ok('dist noise-gate worklet: noise-gate-worklet.js (stable path)')
    : bad('dist', 'noise-gate-worklet.js MISSING in dist — tab-audio recording reverts to ungated passthrough');
  const offChunk = (await readFile(join(DIST, 'src/offscreen/offscreen.html'), 'utf8').catch(() => ''))
    .match(/assets\/[^"']*offscreen[^"']*\.js/)?.[0];
  if (offChunk) {
    const offSrc = await readFile(join(DIST, offChunk), 'utf8').catch(() => '');
    /getURL\(["']transcribe-worklet\.js["']\)/.test(offSrc)
      ? ok('offscreen loads worklet from the stable public path')
      : bad('dist', 'offscreen does not getURL("transcribe-worklet.js") — worklet path drift');
    // audio-mixer.js is imported by offscreen and is the one that
    // requests the noise-gate worklet at runtime. crxjs inlines the
    // mixer into the offscreen entry chunk, so the literal string
    // must appear there too — pin it.
    /getURL\(["']noise-gate-worklet\.js["']\)/.test(offSrc)
      ? ok('audio-mixer loads noise-gate-worklet from the stable public path')
      : bad('dist', 'audio-mixer does not getURL("noise-gate-worklet.js") — noise-gate path drift');
  }
  // The MV3 service worker (and the offscreen doc, in its own way)
  // must have a CLEAN static module graph. A dynamic import() anywhere
  // in a SW-reachable chunk makes Vite (a) split a chunk wrapped in
  // ``__vitePreload`` which touches ``document`` (undefined in a SW →
  // "An unknown error occurred when fetching the script" → SW dead →
  // popup channel_closed) and sometimes (b) emit an unrewritten
  // ``import('../src.js')`` that 404s. e2e-load can't catch this (it
  // never drives the message paths that trigger lazy imports), and
  // checking only the ENTRY chunk misses it (the real offender was
  // client.js, a SW-imported chunk). So walk the FULL transitive
  // static-import graph and assert: no missing file, no __vitePreload,
  // no literal source-path dynamic import.
  const walkGraph = async (entryRel) => {
    const seen = new Set();
    const missing = [];
    const vpre = [];
    const litDyn = [];
    const stack = [entryRel];
    while (stack.length) {
      const rel = stack.pop();
      if (seen.has(rel)) continue;
      seen.add(rel);
      const fp = join(DIST, rel);
      if (!(await exists(fp))) { missing.push(rel); continue; }
      const s = await readFile(fp, 'utf8').catch(() => '');
      const re = /(?:import|export)[^'"]*?from\s*['"](\.\.?\/[^'"]+)['"]|(?:^|[^.\w])import\s*['"](\.\.?\/[^'"]+)['"]/g;
      let m;
      // eslint-disable-next-line no-cond-assign
      while ((m = re.exec(s))) {
        const spec = m[1] || m[2];
        const child = join(rel, '..', spec).replace(/\\/g, '/');
        stack.push(child);
      }
      if (s.includes('__vitePreload')) vpre.push(rel);
      // Strip comments before scanning for dynamic imports — with
      // build.minify:false, JSDoc type imports like
      // ``@param {import('../constants.js').T}`` survive verbatim and
      // are NOT executable code (false positives otherwise).
      const code = s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      // literal SOURCE-path dynamic import that won't resolve in dist
      const dl = code.match(/import\(\s*['"](\.\.?\/[^'"]+\.js)['"]\s*\)/g) || [];
      for (const d of dl) {
        const t = d.match(/['"](\.\.?\/[^'"]+)['"]/)[1];
        const tr = join(rel, '..', t).replace(/\\/g, '/');
        if (!(await exists(join(DIST, tr)))) litDyn.push(`${rel}: ${d}`);
      }
    }
    return { size: seen.size, missing, vpre, litDyn };
  };
  const swLoader = await readFile(join(DIST, 'service-worker-loader.js'), 'utf8').catch(() => '');
  const swChunk = (swLoader.match(/assets\/[^'"]+\.js/) || [])[0];
  const offHtml = await readFile(join(DIST, 'src/offscreen/offscreen.html'), 'utf8').catch(() => '');
  const offEntry = (offHtml.match(/assets\/[^"']*offscreen[^"']*\.js/) || [])[0];
  for (const [label, entry] of [['SW', swChunk], ['offscreen', offEntry]]) {
    if (!entry) { bad('dist', `cannot resolve ${label} entry chunk`); continue; }
    const g = await walkGraph(entry);
    g.missing.length === 0
      ? ok(`${label} graph complete (${g.size} chunks, no missing imports)`)
      : bad('dist', `${label} graph MISSING: ${g.missing.join(', ')}`);
    g.vpre.length === 0
      ? ok(`${label} graph free of __vitePreload (no document-touching preload)`)
      : bad('dist', `${label} chunk(s) carry __vitePreload — dynamic import() crashes on document: ${g.vpre.join(', ')}`);
    g.litDyn.length === 0
      ? ok(`${label} graph free of unresolved source-path dynamic imports`)
      : bad('dist', `${label} has literal dynamic import() that 404s: ${g.litDyn.join(' | ')}`);
  }
}

// W9 (build-gate) — the backend hard-cut these surfaces (REFACTOR-2 /
// AUTH-REFACTOR): `/api/v1/meetings/*` → `/api/v1/recordings/*`,
// `/api/v1/me` → `/user/profile`. A straggler call would 404 only at
// runtime against the real backend. Vitest already guards this; this
// promotes it into the PACKAGING gate so a regression fails the build,
// not just the test run. Migration-history COMMENTS are allowed
// (heuristic comment-strip, same as the dist-graph walk above).
console.log('\n— removed backend surfaces (W9) —');
{
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const walkSrc = async (dir) => {
    const found = [];
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) found.push(...await walkSrc(p));
      else if (ent.name.endsWith('.js')) found.push(p);
    }
    return found;
  };
  const offenders = [];
  for (const file of await walkSrc(join(ROOT, 'src'))) {
    const code = stripComments(await readFile(file, 'utf8'));
    if (/\/api\/v1\/meetings/.test(code)
      || /['"`]\/api\/v1\/me['"`]/.test(code)) {
      offenders.push(file.replace(ROOT + '/', ''));
    }
  }
  offenders.length === 0
    ? ok('no removed /api/v1/meetings|/api/v1/me references in src/ code')
    : bad('removed-endpoint', `dead backend surface reintroduced: ${offenders.join(', ')}`);
}

console.log('\n— version —');
ok('manifest version', mfSrc.version);
if (mfDist && mfDist.version !== mfSrc.version) bad('dist', `version drift src=${mfSrc.version} dist=${mfDist.version}`);

const pass = out.filter((x) => x.ok).length;
console.log(`\n${'='.repeat(60)}\nSTATIC AUDIT: ${pass}/${out.length} checks passed\n${'='.repeat(60)}`);
const fails = out.filter((x) => !x.ok);
if (fails.length) { for (const f of fails) console.log(`❌ ${f.n} — ${f.d}`); process.exit(1); }
console.log('✅ packaging is install-safe');
