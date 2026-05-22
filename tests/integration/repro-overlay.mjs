// Focused real-Chrome check: does the transcription OVERLAY content
// script load + render on the meeting tab during Mode 1? Loads real
// dist, opens a meet tab (content scripts inject), captures that
// page's console/pageerror (the overlay loader logs failures there),
// drives Mode 1 to ACTIVE, then asserts the overlay shadow host
// (#meetminutes-transcribe-root) exists.
import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');
const BASE = process.env.MM_BASE || 'https://test-api.meetminutes.in';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

let token = null;
try {
  const r = await fetch(`${BASE}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `cc-ov+${Date.now()}@meetminutes.in`, password: 'HarnessPassw0rd!', name: 'OV' }),
  });
  token = (await r.json()).token; log(`token ${r.status}`);
} catch (e) { log('token failed', e.message); }

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: ['--headless=new', '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
});
const meetErrs = [];
context.on('page', async (p) => {
  const u = p.url() || '';
  if (/permission\/mic|mic\.html/.test(u)) {
    try { await p.waitForSelector('#allow', { timeout: 5000 }); await p.click('#allow'); log('  · mic #allow'); } catch { /* noop */ }
  }
});

let sw = context.serviceWorkers()[0];
for (let i = 0; i < 30 && !sw; i += 1) sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 1000 }).catch(() => null);
if (!sw) { console.log('❌ SW never registered'); await context.close(); process.exit(1); }
const extId = new URL(sw.url()).host;
log('SW ok', extId);
await sw.evaluate(async ([t, b]) => chrome.storage.local.set({ mm_auth_token: t, mm_api_base_url: b }), [token, BASE]).catch(() => {});

// Meet tab at a meeting-code URL so it persists + content scripts inject.
const meet = await context.newPage();
meet.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /overlay|transcribe|meetminutes/i.test(t)) meetErrs.push(`[meet.${m.type()}] ${t.slice(0, 300)}`); });
meet.on('pageerror', (e) => meetErrs.push(`[meet.pageerror] ${e.message}`));
await meet.goto('https://meet.google.com/abc-defg-hij', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await meet.waitForTimeout(4000);
const meetTab = await sw.evaluate(async () => {
  const t = (await chrome.tabs.query({ url: 'https://meet.google.com/*' }))[0];
  return t ? { tabId: t.id, url: t.url } : null;
});
log('meet tab:', JSON.stringify(meetTab));
// Is the overlay content script even present?
const csInjected = await meet.evaluate(() => ({
  hasListener: true,
  root: !!document.getElementById('meetminutes-transcribe-root'),
})).catch((e) => ({ err: e.message }));
log('pre-start overlay root present:', JSON.stringify(csInjected));

const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
await popup.waitForTimeout(1000);
const send = (m) => popup.evaluate(async (x) => { try { return await chrome.runtime.sendMessage(x); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } }, m);
const trState = () => sw.evaluate(async () => (await chrome.storage.session.get('mm_transcribe_state')).mm_transcribe_state || { state: 'IDLE' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send({ type: 'START_TRANSCRIBE', mode: 'self', language: 'en', tabId: meetTab && meetTab.tabId, url: meetTab && meetTab.url });
let st = { state: 'IDLE' };
for (let i = 0; i < 40; i += 1) { st = await trState(); if (st.state === 'ACTIVE' || st.state === 'ERROR') break; await sleep(1000); }
log('transcribe state:', st.state, 'err=', st.error);

await sleep(4000); // give the lifecycle relay + ensureOverlay a beat
const overlay = await meet.evaluate(() => {
  const host = document.getElementById('meetminutes-transcribe-root');
  if (!host) return { present: false };
  const cs = getComputedStyle(host);
  const r = host.getBoundingClientRect();
  return {
    present: true,
    shadow: !!host.shadowRoot || 'closed-or-none',
    display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
    rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },
  };
}).catch((e) => ({ err: e.message }));

await context.close();
console.log(`\n${'='.repeat(60)}\nOVERLAY GROUND TRUTH (Mode 1)`);
console.log('transcribe reached:', st.state, st.error ? `(err=${st.error})` : '');
console.log('overlay root after start:', JSON.stringify(overlay));
console.log(`meet-page console/errors (${meetErrs.length}):`);
meetErrs.slice(0, 15).forEach((e) => console.log('  ', e));
const ok = st.state === 'ACTIVE' && overlay && overlay.present;
console.log(`\n${ok ? '✅ overlay rendered on the meeting tab' : '❌ overlay did NOT render — see console/errors above'}`);
process.exit(ok ? 0 : 1);
