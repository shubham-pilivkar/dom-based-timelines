// Real-meeting E2E: joins an ACTUAL Google Meet, then drives the
// three flows the headless suite must skip — transcribe Mode 2
// (participants/tab audio), Mode 3 (both), and Recording — against
// the real joined tab, capturing ground truth (bus + state + errors).
//
// Usage:
//   xvfb-run -a node --experimental-websocket \
//     tests/integration/repro-e2e-realmeet.mjs --url='https://meet.google.com/xxx'
// You must ADMIT "MeetMinutes E2E" from the Meet lobby (≤120s) and,
// for Mode 2/3, speak (or have someone speak) so transcript flows.

import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');
const BASE = process.env.MM_BASE || 'https://test-api.meetminutes.in';
const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const MEET_URL = arg('url', '');
const SECS = parseInt(arg('seconds', '60'), 10);
if (!MEET_URL) { console.error('need --url=<meet link>'); process.exit(2); }
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const results = [];
const pass = (n, d) => { results.push({ n, ok: true, d }); log(`✅ ${n} — ${d}`); };
const fail = (n, d) => { results.push({ n, ok: false, d }); log(`❌ ${n} — ${d}`); };

let token = null;
try {
  const r = await fetch(`${BASE}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `cc-rm+${Date.now()}@meetminutes.in`, password: 'HarnessPassw0rd!', name: 'RM' }),
  });
  token = (await r.json()).token;
  log(`token (${r.status})`);
} catch (e) { log('token failed', e.message); }

const context = await chromium.launchPersistentContext(`/tmp/mm-rm-${Date.now()}`, {
  headless: false,
  args: [
    '--no-sandbox', '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--disable-blink-features=AutomationControlled', '--disable-gpu',
    `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
  ],
});
context.on('page', async (p) => {
  const u = p.url() || '';
  if (/permission\/mic|mic\.html/.test(u)) {
    try { await p.waitForSelector('#allow', { timeout: 5000 }); await p.click('#allow'); log('  · clicked mic #allow'); } catch { /* noop */ }
  }
});

let sw = context.serviceWorkers()[0];
for (let i = 0; i < 30 && !sw; i += 1) sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 1000 }).catch(() => null);
if (!sw) { fail('SW', 'never registered'); await context.close(); process.exit(1); }
const extId = new URL(sw.url()).host;
log('SW ok', extId);
await sw.evaluate(async ([t, b]) => chrome.storage.local.set({ mm_auth_token: t, mm_api_base_url: b }), [token, BASE]).catch(() => {});

// --- join the real meeting ---
async function clickByText(page, texts, timeout = 4000) {
  for (const t of texts) {
    const el = page.locator(`button:has-text("${t}"), [role="button"]:has-text("${t}"), span:has-text("${t}")`).first();
    try { await el.waitFor({ state: 'visible', timeout }); await el.click({ timeout: 2000 }); log(`clicked "${t}"`); return true; } catch { /* next */ }
  }
  return false;
}
const meet = await context.newPage();
log('navigating to Meet…');
await meet.goto(MEET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await meet.waitForTimeout(5000);
await clickByText(meet, ['Got it', 'Accept all', 'I agree'], 3000);
try {
  const n = meet.locator('input[aria-label*="name" i], input[placeholder*="name" i]').first();
  await n.waitFor({ state: 'visible', timeout: 6000 }); await n.fill('MeetMinutes E2E'); log('filled name');
} catch { log('no name field'); }
await clickByText(meet, ['Turn off microphone', 'Turn off camera'], 1500);
await meet.waitForTimeout(800);
if (!await clickByText(meet, ['Ask to join', 'Join now', 'Join meeting'], 8000)) { fail('join', 'no join button'); await context.close(); process.exit(1); }
log('🔔 ADMIT "MeetMinutes E2E" from the Meet lobby (≤120s)…');
try {
  await meet.waitForSelector('button[aria-label*="Leave call" i], button[aria-label*="Leave meeting" i], [aria-label*="Leave call" i]', { timeout: 120000 });
  pass('join', 'admitted to the meeting');
} catch { fail('join', 'not admitted within 120s'); await context.close(); process.exit(1); }
await meet.bringToFront();
await meet.waitForTimeout(3000);
const meetTab = await sw.evaluate(async () => {
  const t = (await chrome.tabs.query({ url: 'https://meet.google.com/*' }))[0];
  if (t) await chrome.tabs.update(t.id, { active: true });
  return t ? { tabId: t.id, url: t.url } : null;
});
log('meet tab:', JSON.stringify(meetTab));

// --- drive flows from an extension page (real popup→SW path) ---
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
await popup.waitForTimeout(1000);
await popup.evaluate(() => { window.__bus = []; chrome.runtime.onMessage.addListener((m) => { try { window.__bus.push({ t: Date.now(), type: m && m.type, phase: m && m.phase, reason: m && (m.reason || m.error) }); } catch { /* noop */ } return false; }); });
const send = (m) => popup.evaluate(async (x) => { try { return await chrome.runtime.sendMessage(x); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } }, m);
const trState = () => sw.evaluate(async () => (await chrome.storage.session.get('mm_transcribe_state')).mm_transcribe_state || { state: 'IDLE' });
const recState = () => sw.evaluate(async () => (await chrome.storage.session.get('mm_session_state')).mm_session_state || { state: 'IDLE' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(getter, pred, secs) { const seen = []; for (let i = 0; i < secs; i += 1) { const s = await getter().catch(() => null); const k = s && s.state; if (k && seen[seen.length - 1] !== k) seen.push(k); if (pred(s)) return { ok: true, s, seen }; await sleep(1000); } return { ok: false, s: await getter().catch(() => null), seen }; }

async function dispatchCmd(combo) {
  // Real extension invocation: focus the meet tab + a browser-level
  // key event (Playwright keyboard = CDP Input, not synthetic JS) →
  // fires chrome.commands AND grants activeTab for tabCapture.
  await meet.bringToFront();
  await meet.waitForTimeout(400);
  await meet.keyboard.press(combo);
}
async function transcribe(mode, label) {
  await send({ type: 'STOP_TRANSCRIBE' }).catch(() => {});
  await waitFor(trState, (s) => !s || s.state === 'IDLE', 10);
  // The toggle-transcribe command reads last-used mode from storage.
  await sw.evaluate(async (m) => chrome.storage.local.set({
    mm_transcribe_last_mode: m, mm_transcribe_last_language: 'en',
  }), mode);
  await dispatchCmd('Control+Shift+T');
  const a = await waitFor(trState, (s) => s && (s.state === 'ACTIVE' || s.state === 'ERROR'), 50);
  if (!a.s || a.s.state !== 'ACTIVE') { fail(label, `did not reach ACTIVE (timeline ${a.seen.join('→')}; err=${a.s && a.s.error})`); await send({ type: 'STOP_TRANSCRIBE' }).catch(() => {}); await waitFor(trState, (s) => !s || s.state === 'IDLE', 10); return; }
  log(`${label} ACTIVE — speak now, capturing ${SECS}s…`);
  await sleep(SECS * 1000);
  const evd = await sw.evaluate(async () => (await chrome.storage.session.get('mm_transcribe_state')).mm_transcribe_state);
  await send({ type: 'STOP_TRANSCRIBE' });
  const st = await waitFor(trState, (s) => !s || s.state === 'IDLE', 12);
  pass(label, `ACTIVE✓ hasFirstEvent=${evd && evd.hasFirstEvent} pts=${evd && (evd.importantPoints || []).length} stop→IDLE=${st.ok}`);
}
await transcribe('participants', 'transcribe Mode 2 (participants/tab)');
await transcribe('both', 'transcribe Mode 3 (both)');

// --- recording on the real joined tab ---
try {
  await send({ type: 'STOP_TRANSCRIBE' }).catch(() => {});
  await waitFor(trState, (s) => !s || s.state === 'IDLE', 12);
  await send({ type: 'STOP_RECORDING' }).catch(() => {});
  await waitFor(recState, (s) => !s || s.state === 'IDLE', 6);
  await dispatchCmd('Control+Shift+R');
  {
    const a = await waitFor(recState, (s) => s && (s.state === 'RECORDING' || s.state === 'ERROR'), 40);
    if (a.s && a.s.state === 'RECORDING') {
      const ctl = await sw.evaluate(async () => (await chrome.storage.local.get('mm_control_window_id')).mm_control_window_id ?? null);
      await send({ type: 'USER_PAUSE' }); const p = await waitFor(recState, (s) => s && s.userPaused === true, 6);
      await send({ type: 'USER_RESUME' }); const rr = await waitFor(recState, (s) => s && s.userPaused === false, 6);
      await sleep(25000); // accrue ≥1 chunk (~20s rotation)
      const mid = await recState();
      await dispatchCmd('Control+Shift+R');
      await send({ type: 'STOP_RECORDING' }).catch(() => {});
      const st = await waitFor(recState, (s) => !s || s.state === 'IDLE' || s.state === 'ERROR', 40);
      (st.s && st.s.state === 'IDLE')
        ? pass('recording', `RECORDING✓ ctlWin=${ctl != null} pause=${p.ok} resume=${rr.ok} chunks=${(mid.lastChunkIndex ?? -1) + 1} stop→IDLE✓`)
        : fail('recording', `stop state=${st.s && st.s.state} err=${st.s && st.s.error}`);
    } else { fail('recording', `no RECORDING (timeline ${a.seen.join('→')}; err=${a.s && a.s.error})`); }
  }
} catch (e) { fail('recording', e.message); }

const bus = await popup.evaluate(() => window.__bus || []).catch(() => []);
await context.close();
console.log(`\n${'='.repeat(60)}\nREAL-MEETING E2E`);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.n}${r.ok ? ` — ${r.d}` : ` — ${r.d}`}`);
const errBus = bus.filter((b) => b.phase === 'error' || (b.reason && /error|fail|undefined/i.test(String(b.reason))));
if (errBus.length) { console.log('error bus:'); errBus.forEach((b) => console.log('  ', JSON.stringify(b))); }
const okN = results.filter((r) => r.ok).length;
console.log(`\n${okN}/${results.length} real-meeting flows passed`);
process.exit(okN === results.length ? 0 : 1);
