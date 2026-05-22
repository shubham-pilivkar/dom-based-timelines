// Phase 3 — reproduce the real-Chrome live-transcribe Mode-1 failure
// HERE, with ground truth (not relayed strings). Loads the actual
// built dist as an unpacked extension, captures the REAL service-
// worker registration error + offscreen errors via CDP, then drives
// the real START_TRANSCRIBE → SW → offscreen → worklet → WS path with
// a fake mic + a live test-api token, and prints exactly what breaks.
//
// Run:  node --experimental-websocket tests/integration/repro-transcribe-mode1.mjs
import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');
const BASE = process.env.MM_BASE || 'https://test-api.meetminutes.in';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const events = [];
const rec = (ctx, kind, msg) => {
  const line = `[${ctx}] ${kind}: ${String(msg).slice(0, 600)}`;
  events.push(line);
  log('  ·', line);
};

// 1. Get a real backend token (raw REST — no extension involved yet).
let token = null;
try {
  const email = `cc-repro+${Date.now()}@meetminutes.in`;
  const r = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'HarnessPassw0rd!', name: 'Repro' }),
  });
  token = (await r.json()).token;
  log(`backend token acquired (${r.status}), len=${token ? token.length : 0}`);
} catch (e) {
  log('WARN could not acquire token (transcribe-start will 401):', e.message);
}

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    '--headless=new',
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
  ],
});

// 2. Attach console/error listeners to EVERY page (popup/offscreen)
//    as they appear, + a CDP ServiceWorker probe for the real
//    registration error if the SW never comes up.
async function wirePage(p) {
  const u = p.url() || 'page';
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') rec(u, 'console.error', t);
    else if (/transcribe|worklet|offscreen|mic|ws|error/i.test(t)) rec(u, `console.${m.type()}`, t);
  });
  p.on('pageerror', (e) => rec(u, 'pageerror', `${e.message}\n${(e.stack || '').slice(0, 300)}`));
  // The one-time mic-permission window: click "Allow" to simulate the
  // user gesture (with --use-fake-ui getUserMedia resolves → sets
  // mm_mic_granted → unblocks ensureMicPermission's 90s wait at once).
  if (/permission\/mic|mic\.html/.test(u)) {
    rec('probe', 'mic-permission-window', `opened: ${u}`);
    try {
      await p.waitForSelector('#allow', { timeout: 5000 });
      await p.click('#allow');
      rec('probe', 'mic-permission-window', 'clicked #allow');
    } catch (e) { rec('probe', 'mic-permission-window', `click failed: ${e.message}`); }
  }
}
context.on('page', (p) => { wirePage(p).catch(() => {}); });
context.pages().forEach((p) => { wirePage(p).catch(() => {}); });

const probe = await context.newPage();
let swErr = null;
try {
  const cdp = await context.newCDPSession(probe);
  await cdp.send('ServiceWorker.enable');
  cdp.on('ServiceWorker.workerErrorReported', (e) => {
    swErr = e.errorMessage || JSON.stringify(e);
    rec('cdp', 'ServiceWorker.workerErrorReported',
      `${e.errorMessage} @ ${e.sourceURL}:${e.lineNumber}`);
  });
} catch (e) { log('CDP ServiceWorker.enable failed (non-fatal):', e.message); }

// 3. Poke the extension so the lazy MV3 SW registers, then wait.
await probe.goto('about:blank').catch(() => {});
let sw = context.serviceWorkers()[0];
for (let i = 0; i < 30 && !sw; i += 1) {
  sw = context.serviceWorkers()[0]
    || await context.waitForEvent('serviceworker', { timeout: 1000 }).catch(() => null);
}
if (!sw) {
  log('❌ SERVICE WORKER NEVER REGISTERED — this is the "error fetching the script".');
  log(`   real reason (CDP): ${swErr || '(none captured — see Errors page)'}`);
  await context.close();
  console.log('\nGROUND TRUTH: SW failed to register. Reason above.');
  process.exit(1);
}
const extId = new URL(sw.url()).host;
log('✓ service worker registered:', sw.url());
sw.on('console', (m) => { if (m.type() === 'error') rec('sw', 'console.error', m.text()); });

// 4. Seed auth + base into the extension, open a Meet tab for tabId.
await sw.evaluate(async ([t, b]) => {
  await chrome.storage.local.set({ mm_auth_token: t, mm_api_base_url: b });
}, [token, BASE]).catch((e) => log('seed storage failed:', e.message));

const meet = await context.newPage();
await meet.goto('https://meet.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  .catch((e) => log('meet tab nav (non-fatal):', e.message));
const meetTab = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  return tabs[0] ? { tabId: tabs[0].id, url: tabs[0].url } : null;
});
log('meet tab:', JSON.stringify(meetTab));

// 5. Drive the REAL popup→SW path: send START_TRANSCRIBE (Mode 1)
//    from an extension page, with the meet tab as the target.
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`,
  { waitUntil: 'domcontentloaded', timeout: 15000 }).catch((e) => log('popup nav:', e.message));
await popup.waitForTimeout(1500);
// Tap the extension message bus from the popup (chrome.runtime
// .sendMessage is broadcast → the popup sees offscreen↔SW traffic).
// Captures the OFFSCREEN's own TRANSCRIBE_LIFECYCLE/error reason that
// the SW's channel_closed masks.
await popup.evaluate(() => {
  window.__bus = [];
  chrome.runtime.onMessage.addListener((m) => {
    try {
      window.__bus.push({
        t: Date.now(),
        type: m && m.type,
        phase: m && m.phase,
        reason: m && (m.reason || m.error),
        name: m && m.name,
      });
    } catch (e) { /* noop */ }
    return false;
  });
});
const startResp = await popup.evaluate(async (t) => {
  try {
    return await chrome.runtime.sendMessage({
      type: 'START_TRANSCRIBE', mode: 'self', language: 'en',
      tabId: t ? t.tabId : null, url: t ? t.url : 'https://meet.google.com/',
    });
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}, meetTab);
log('START_TRANSCRIBE response:', JSON.stringify(startResp));

// 6. Watch transcribe state + offscreen presence for ~140s (past the
//    90s mic-permission timeout, in case the #allow click is missed).
const seen = [];
let offscreenSeen = false;
let cdpTargets = null;
try { cdpTargets = await context.newCDPSession(probe); await cdpTargets.send('Target.setDiscoverTargets', { discover: true }); } catch { /* noop */ }
for (let i = 0; i < 70; i += 1) {
  await popup.waitForTimeout(2000);
  let st = null;
  let hasOff = null;
  try {
    [st, hasOff] = await sw.evaluate(async () => [
      (await chrome.storage.session.get('mm_transcribe_state')).mm_transcribe_state,
      (chrome.offscreen && chrome.offscreen.hasDocument) ? await chrome.offscreen.hasDocument() : 'n/a',
    ]);
  } catch (e) { st = `(sw eval failed: ${e.message})`; }
  const key = JSON.stringify(st && st.state ? { s: st.state, e: st.error, off: hasOff } : st);
  if (key !== seen[seen.length - 1]) { seen.push(key); log('transcribe →', key); }
  if (hasOff === true && !offscreenSeen) {
    offscreenSeen = true;
    rec('probe', 'offscreen', 'chrome.offscreen.hasDocument()===true');
    try {
      const ts = await cdpTargets.send('Target.getTargets');
      const off = ts.targetInfos.find((t) => /offscreen/.test(t.url));
      rec('probe', 'offscreen-target', off ? `${off.type} ${off.url}` : 'not in Target.getTargets');
    } catch { /* noop */ }
  }
  if (st && st.state === 'ERROR') break;
  if (st && st.state === 'ACTIVE' && i > 5) break;
}

// 6b. Post-mortem: is it createDocument failing, or the offscreen
//     SCRIPT crashing right after create (doc auto-closes)? Create
//     one directly and watch hasDocument; also fetch its assets.
try {
  const pm = await sw.evaluate(async () => {
    const out = { steps: [] };
    try {
      const had = await chrome.offscreen.hasDocument();
      out.steps.push(`pre hasDocument=${had}`);
      if (had) { await chrome.offscreen.closeDocument().catch(() => {}); out.steps.push('closed pre-existing'); }
    } catch (e) { out.steps.push(`pre check threw: ${e.message}`); }
    try {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
        justification: 'repro probe',
      });
      out.steps.push('createDocument resolved');
    } catch (e) { out.steps.push(`createDocument THREW: ${e.message}`); return out; }
    for (let k = 0; k < 8; k += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      let h;
      try { h = await chrome.offscreen.hasDocument(); } catch (e) { h = `err:${e.message}`; }
      out.steps.push(`+${k + 1}s hasDocument=${h}`);
      if (h === false) break;
    }
    // Fetch the offscreen html + its module chunk for HTTP status.
    try {
      const html = await fetch(chrome.runtime.getURL('src/offscreen/offscreen.html'));
      out.htmlStatus = html.status;
      const txt = await html.text();
      const m = txt.match(/src="([^"]+\.js)"/);
      out.scriptTag = m ? m[1] : '(none)';
      if (m) {
        const u = new URL(m[1], chrome.runtime.getURL('src/offscreen/offscreen.html'));
        const js = await fetch(u.href);
        out.scriptStatus = `${u.pathname} → ${js.status}`;
      }
    } catch (e) { out.fetchErr = e.message; }
    return out;
  });
  log('OFFSCREEN POST-MORTEM:', JSON.stringify(pm, null, 1));
  events.push(`[postmortem] ${JSON.stringify(pm)}`);
} catch (e) { log('post-mortem failed:', e.message); }

try {
  const bus = await popup.evaluate(() => window.__bus || []);
  log('MESSAGE BUS (offscreen↔SW traffic):');
  for (const b of bus) log('   bus:', JSON.stringify(b));
  events.push(`[bus] ${JSON.stringify(bus)}`);
} catch (e) { log('bus read failed:', e.message); }

await context.close();
console.log(`\n${'='.repeat(64)}\nGROUND TRUTH — Mode 1 live transcription`);
console.log('='.repeat(64));
console.log('SW registered:', !!sw, '| SW error (CDP):', swErr || 'none');
console.log('START_TRANSCRIBE resp:', JSON.stringify(startResp));
console.log('transcribe state timeline:', seen.join('  →  ') || '(none)');
console.log(`captured ${events.length} error/console event(s):`);
for (const e of events) console.log('  ', e);
const ok = seen.some((s) => s.includes('"s":"ACTIVE"'))
  && !seen.some((s) => s.includes('"s":"ERROR"'));
console.log(`\n${ok ? '✅ Mode 1 reached ACTIVE' : '❌ Mode 1 did NOT reach ACTIVE — see above'}`);
process.exit(ok ? 0 : 1);
