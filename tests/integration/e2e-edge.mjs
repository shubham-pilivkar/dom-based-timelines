// Exhaustive Chrome-runtime EDGE-CASE suite. Loads the real built
// extension and drives the SW message router + state machines through
// every transition, offscreen signal, tab event, bridge/content
// message, and messaging-robustness edge a real install can hit.
import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');
const BASE = 'https://test-api.meetminutes.in';

const R = [];
async function S(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  try { const n = await fn(); R.push({ ok: true, name }); console.log(`  ✅ PASS${n ? ' — ' + n : ''}`); }
  catch (e) { R.push({ ok: false, name, d: e.message }); console.log(`  ❌ FAIL — ${e.message}`); }
}

const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
});
await ctx.newPage().then((p) => p.goto('about:blank')).catch(() => {});
let sw = ctx.serviceWorkers()[0];
for (let i = 0; i < 25 && !sw; i++) sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 1000 }).catch(() => null);
if (!sw) { console.log('FATAL no SW'); process.exit(2); }
const extId = new URL(sw.url()).host;
const drv = await ctx.newPage();
await drv.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'load' });

const send = async (m) => {
  const r = await drv.evaluate((mm) => chrome.runtime.sendMessage(mm), m);
  return r && r.ok === true && Object.prototype.hasOwnProperty.call(r, 'data') ? r.data : r;
};
const sset = (o) => drv.evaluate((x) => chrome.storage.session.set(x), o);
const sget = (k) => drv.evaluate((x) => chrome.storage.session.get(x), k);
const lset = (o) => drv.evaluate((x) => chrome.storage.local.set(x), o);
const seedRec = (st, ex = {}) => sset({ mm_session_state: { state: st, ...ex } });
const seedTr = (st, ex = {}) => sset({ mm_transcribe_state: { state: st, ...ex } });
const RESET = () => sset({ mm_session_state: { state: 'IDLE' }, mm_transcribe_state: { state: 'IDLE' } });
const st = async () => (await send({ type: 'GET_STATE' }));
const trst = async () => (await send({ type: 'GET_TRANSCRIBE_STATE' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await lset({ mm_api_base_url: BASE });

// ===== A. Recording state-machine guards =====
await RESET();
await S('A1 START while STARTING → busy', async () => { await seedRec('STARTING', { tabId: 11 }); const r = await send({ type: 'START_RECORDING', tabId: 22, url: 'https://meet.google.com/a', source: 'google_meet' }); if (r.code !== 'busy') throw new Error(JSON.stringify(r)); });
await S('A2 START while STOPPING → busy', async () => { await seedRec('STOPPING', { tabId: 11 }); const r = await send({ type: 'START_RECORDING', tabId: 22, url: 'https://meet.google.com/a', source: 'google_meet' }); if (r.code !== 'busy') throw new Error(JSON.stringify(r)); });
await S('A3 START while NEEDS_REAUTH → busy', async () => { await seedRec('NEEDS_REAUTH'); const r = await send({ type: 'START_RECORDING', tabId: 22, url: 'https://meet.google.com/a', source: 'google_meet' }); if (r.code !== 'busy') throw new Error(JSON.stringify(r)); });
await S('A4 USER_PAUSE when not recording → not_recording', async () => { await RESET(); const r = await send({ type: 'USER_PAUSE' }); if (r.ok !== false || r.error !== 'not_recording') throw new Error(JSON.stringify(r)); });
await S('A5 USER_RESUME when not recording → not_recording', async () => { const r = await send({ type: 'USER_RESUME' }); if (r.ok !== false || r.error !== 'not_recording') throw new Error(JSON.stringify(r)); });
await S('A6 STOP from STARTING → STOPPING (allowed)', async () => { await seedRec('STARTING', { tabId: 11, meetingId: null }); await send({ type: 'STOP_RECORDING' }); const s = await st(); if (s.state !== 'STOPPING') throw new Error(`got ${s.state}`); });
await S('A7 FLUSH_TIMELINE with no meeting → flushed 0', async () => { await RESET(); const r = await send({ type: 'FLUSH_TIMELINE' }); if (!r || r.flushed !== 0) throw new Error(JSON.stringify(r)); });

// ===== B. Transcribe state-machine =====
await S('B1 GET_TRANSCRIBE_STATE initial → IDLE', async () => { await RESET(); const t = await trst(); if (t.state !== 'IDLE') throw new Error(JSON.stringify(t)); });
await S('B2 START_TRANSCRIBE while transcribe ACTIVE → busy_transcribing', async () => { await seedTr('ACTIVE', { tabId: 5 }); const r = await send({ type: 'START_TRANSCRIBE', mode: 'self', language: 'en', tabId: 9, url: 'https://meet.google.com/x' }); if (r.code !== 'busy_transcribing') throw new Error(JSON.stringify(r)); });
await S('B3 START_RECORDING while transcribe ACTIVE → busy_transcribing', async () => { await seedRec('IDLE'); await seedTr('ACTIVE', { tabId: 5 }); const r = await send({ type: 'START_RECORDING', tabId: 9, url: 'https://meet.google.com/x', source: 'google_meet' }); if (r.code !== 'busy_transcribing') throw new Error(JSON.stringify(r)); });
await S('B4 PAUSE_TRANSCRIBE from IDLE → cannot_pause_from_IDLE', async () => { await seedTr('IDLE'); const r = await send({ type: 'PAUSE_TRANSCRIBE' }); if (r.ok !== false || !/cannot_pause_from_IDLE/.test(r.error)) throw new Error(JSON.stringify(r)); });
await S('B5 RESUME_TRANSCRIBE from IDLE → cannot_resume_from_IDLE', async () => { const r = await send({ type: 'RESUME_TRANSCRIBE' }); if (r.ok !== false || !/cannot_resume_from_IDLE/.test(r.error)) throw new Error(JSON.stringify(r)); });
await S('B6 STOP_TRANSCRIBE from IDLE → no-op, state IDLE', async () => { await seedTr('IDLE'); const t = await send({ type: 'STOP_TRANSCRIBE' }); if (t.state !== 'IDLE') throw new Error(JSON.stringify(t)); });
await S('B7 PAUSE from ACTIVE w/o offscreen → graceful fail, rolled back to ACTIVE', async () => { await seedTr('ACTIVE', { tabId: 5 }); const r = await send({ type: 'PAUSE_TRANSCRIBE' }); const t = await trst(); if (r.ok !== false || t.state !== 'ACTIVE') throw new Error(`r=${JSON.stringify(r)} state=${t.state}`); });
await S('B8 RESUME from PAUSED w/o offscreen → graceful fail, rolled back to PAUSED', async () => { await seedTr('PAUSED', { tabId: 5 }); const r = await send({ type: 'RESUME_TRANSCRIBE' }); const t = await trst(); if (r.ok !== false || t.state !== 'PAUSED') throw new Error(`r=${JSON.stringify(r)} state=${t.state}`); });

// ===== C. Offscreen → SW signals =====
await S('C1 OFFSCREEN_ERROR → state ERROR', async () => { await RESET(); await send({ type: 'OFFSCREEN_ERROR', error: 'boom' }); const s = await st(); if (s.state !== 'ERROR' || !/offscreen_error: boom/.test(s.errorMessage)) throw new Error(JSON.stringify(s)); });
await S('C2 OFFSCREEN_HEARTBEAT → ok + lastHeartbeatAt advanced', async () => { await send({ type: 'OFFSCREEN_HEARTBEAT' }); const v = await sget('mm_session_state'); if (!v.mm_session_state || !v.mm_session_state.lastHeartbeatAt) throw new Error('heartbeat not recorded'); });
await S('C3 CHUNK_PERSISTED → lastChunkIndex updated', async () => { await seedRec('RECORDING', { meetingId: 'edge-m', tabId: 1 }); await send({ type: 'CHUNK_PERSISTED', chunkIndex: 7, isFinal: false }); const s = await st(); if (s.lastChunkIndex !== 7) throw new Error(`got ${s.lastChunkIndex}`); });
await S('C4 AUDIO_MONITOR_BLOCKED/RESTORED → monitorBlocked toggles', async () => { await send({ type: 'AUDIO_MONITOR_BLOCKED', reason: 'autoplay' }); let s = await st(); if (s.monitorBlocked !== true) throw new Error('not blocked'); await send({ type: 'AUDIO_MONITOR_RESTORED' }); s = await st(); if (s.monitorBlocked !== false) throw new Error('not restored'); });
await S('C5 RECORDING_STARTED while STARTING → RECORDING + t0', async () => { await seedRec('STARTING', { tabId: 1, meetingId: 'edge-m' }); await send({ type: 'RECORDING_STARTED', startedAt: 1700000000000, micAvailable: true }); const s = await st(); if (s.state !== 'RECORDING' || s.recordingStartedAt !== 1700000000000 || s.micAvailable !== true) throw new Error(JSON.stringify(s)); });
await S('C6 RECORDING_STARTED while IDLE → does NOT promote', async () => { await RESET(); await send({ type: 'RECORDING_STARTED', startedAt: 123, micAvailable: true }); const s = await st(); if (s.state !== 'IDLE') throw new Error(`promoted to ${s.state}`); });
await S('C7 TRANSCRIBE_LIFECYCLE started→ACTIVE then stopped→IDLE', async () => { await seedTr('STARTING', { tabId: 3 }); await send({ type: 'TRANSCRIBE_LIFECYCLE', phase: 'started', startedAt: 1 }); let t = await trst(); if (t.state !== 'ACTIVE') throw new Error(`got ${t.state}`); await send({ type: 'TRANSCRIBE_LIFECYCLE', phase: 'stopped' }); t = await trst(); if (t.state !== 'IDLE') throw new Error(`got ${t.state}`); });
await S('C8 TRANSCRIBE_FIRST_EVENT → hasFirstEvent true', async () => { await seedTr('ACTIVE', { hasFirstEvent: false, tabId: 3 }); await send({ type: 'TRANSCRIBE_FIRST_EVENT', latencyMs: 200 }); const t = await trst(); if (t.hasFirstEvent !== true) throw new Error(JSON.stringify(t)); });
await S('C9 IMPORTANT_POINTS_UPDATE dedups by id', async () => { await seedTr('ACTIVE', { importantPoints: [], tabId: 3 }); await send({ type: 'IMPORTANT_POINTS_UPDATE', points: [{ id: 'p1', type: 'decision', text: 'x' }] }); await send({ type: 'IMPORTANT_POINTS_UPDATE', points: [{ id: 'p1', type: 'decision', text: 'x' }, { id: 'p2', type: 'action_item', text: 'y' }] }); const t = await trst(); if ((t.importantPoints || []).length !== 2) throw new Error(`len=${(t.importantPoints || []).length}`); });
await S('C10 TELEMETRY_EVENT vad_stats mirrors vadDroppedPct', async () => { await seedTr('ACTIVE', { tabId: 3 }); await send({ type: 'TELEMETRY_EVENT', name: 'vad_stats', payload: { droppedPct: 42 } }); const t = await trst(); if (t.vadDroppedPct !== 42) throw new Error(`got ${t.vadDroppedPct}`); });
await S('C11 TELEMETRY_EVENT with unknown name → ok, no throw', async () => { const r = await send({ type: 'TELEMETRY_EVENT', name: 'totally_unknown_evt', payload: {} }); if (!r || r.ok !== true) throw new Error(JSON.stringify(r)); });

// ===== D. Bridge / content messages =====
// These handlers themselves return {ok,data}; messaging double-wraps,
// so after one unwrap the payload is at r.data (extension is correct).
await S('D1 GET_BRIDGE_STATUS → disabled/idle', async () => { const r = await send({ type: 'GET_BRIDGE_STATUS' }); const d = r && r.data; if (!d || d.enabled !== false || d.paired !== false) throw new Error(JSON.stringify(r)); });
await S('D2 BRIDGE_CONFIG_CHANGED → ok + status', async () => { const r = await send({ type: 'BRIDGE_CONFIG_CHANGED' }); const d = r && r.data; if (!d || typeof d.enabled !== 'boolean') throw new Error(JSON.stringify(r)); });
await S('D3 SPEAKER_CHANGE with no meeting → bridged_only', async () => { await RESET(); const r = await send({ type: 'SPEAKER_CHANGE', speaker_name: 'Bob', source: 'google_meet', start_time: 0, end_time: 1 }); const d = r && r.data; if (!d || !d.bridged_only) throw new Error(JSON.stringify(r)); });
await S('D4 TAB_BLUR_MARKER with no meeting → no_active_meeting', async () => { const r = await send({ type: 'TAB_BLUR_MARKER', at: 5 }); if (r.ok !== false || r.error !== 'no_active_meeting') throw new Error(JSON.stringify(r)); });
await S('D5 MEETING_ENDED when IDLE → no-op ok', async () => { await RESET(); const r = await send({ type: 'MEETING_ENDED' }); const s = await st(); if (!r || s.state !== 'IDLE') throw new Error(JSON.stringify({ r, s: s.state })); });
await S('D6 SPEAKER_CHANGE with active meeting → currentSpeaker set', async () => { await seedRec('RECORDING', { meetingId: 'edge-m2', tabId: 1 }); await send({ type: 'SPEAKER_CHANGE', speaker_name: 'Alice', source: 'google_meet', start_time: 0, end_time: 2 }); const s = await st(); if (s.currentSpeaker !== 'Alice') throw new Error(`got ${s.currentSpeaker}`); });

// ===== E. Messaging robustness =====
await S('E1 message with no type → ignored (undefined)', async () => { const r = await send({ foo: 1 }); if (r !== undefined) throw new Error(JSON.stringify(r)); });
await S('E2 message type=null → ignored', async () => { const r = await send({ type: null }); if (r !== undefined) throw new Error(JSON.stringify(r)); });
await S('E3 unknown type → structured error', async () => { const r = await send({ type: 'ZZZ' }); if (r.ok !== false || !/unknown_message_type/.test(r.error)) throw new Error(JSON.stringify(r)); });
await S('E4 20 concurrent GET_STATE → all consistent IDLE', async () => { await RESET(); const all = await drv.evaluate(async () => { const ps = []; for (let i = 0; i < 20; i++) ps.push(chrome.runtime.sendMessage({ type: 'GET_STATE' })); return Promise.all(ps); }); const states = all.map((x) => x.data.state); if (states.some((s) => s !== 'IDLE')) throw new Error(states.join(',')); });
await S('E5 huge junk field on known type → no crash, still IDLE', async () => { await RESET(); await send({ type: 'GET_STATE', junk: 'z'.repeat(200000) }); const s = await st(); if (s.state !== 'IDLE') throw new Error(s.state); });

// ===== F. Tab events =====
await S('F1 navigate the recording tab away → auto-stop', async () => {
  const pg = await ctx.newPage(); await pg.goto('about:blank');
  const tid = await drv.evaluate(async () => { const t = (await chrome.tabs.query({})).reverse().find((x) => x.url === 'about:blank'); return t ? t.id : null; });
  await seedRec('RECORDING', { tabId: tid, url: 'about:blank', meetingId: 'edge-nav' });
  await pg.goto('https://example.com'); await sleep(1500);
  const s = await st(); await pg.close();
  if (s.state === 'RECORDING') throw new Error('did not auto-stop on navigation');
  return `→ ${s.state}`;
});
await S('F2 navigate a NON-recording tab → recording state untouched', async () => {
  await seedRec('RECORDING', { tabId: 999999, url: 'https://meet.google.com/keep', meetingId: 'edge-keep' });
  const pg = await ctx.newPage(); await pg.goto('about:blank'); await pg.goto('https://example.org'); await sleep(800);
  const s = await st(); await pg.close();
  if (s.state !== 'RECORDING') throw new Error(`unrelated nav disturbed state → ${s.state}`);
});
await S('F3 close a NON-recording tab → recording state untouched', async () => {
  await seedRec('RECORDING', { tabId: 999998, url: 'https://meet.google.com/keep2', meetingId: 'edge-keep2' });
  const pg = await ctx.newPage(); await pg.goto('about:blank'); await pg.close(); await sleep(800);
  const s = await st();
  if (s.state !== 'RECORDING') throw new Error(`unrelated close disturbed state → ${s.state}`);
});

await ctx.close();
const pass = R.filter((r) => r.ok).length;
console.log(`\n${'='.repeat(64)}\nEDGE SUITE: ${pass}/${R.length} passed\n${'='.repeat(64)}`);
for (const r of R) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : '  ↳ ' + r.d}`);
process.exit(pass === R.length ? 0 : 1);
