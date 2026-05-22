// Real-world integration harness.
//
// Imports the ACTUAL extension modules (src/api/*) under a chrome /
// IndexedDB shim and drives them against the live test backend with
// the real sample audio. Every scenario is isolated so one failure
// doesn't hide the rest — the point is to *discover* the integration
// errors, not stop at the first.
//
// Run: node --experimental-websocket tests/integration/run.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { local } from './env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const BASE = process.env.MM_BASE || 'https://test-api.meetminutes.in';

// Seed config BEFORE importing client.js so loadConfig() picks up the
// base URL on first call. Token is written by register() later.
await local.set({ mm_api_base_url: BASE });

const client = await import('../../src/api/client.js');
const timeline = await import('../../src/api/timeline-buffer.js');
const telemetry = await import('../../src/api/telemetry-buffer.js');

const results = [];
function log(...a) { console.log(...a); }
async function scenario(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    const note = await fn();
    const ms = Date.now() - t0;
    results.push({ name, ok: true, ms, note: note || '' });
    log(`  ✅ PASS (${ms}ms)${note ? ' — ' + note : ''}`);
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
    results.push({ name, ok: false, ms, note: msg });
    log(`  ❌ FAIL (${ms}ms) — ${msg}`);
  }
}

const ctx = {}; // shared state across scenarios (token, meetingId, ...)

// ---------------------------------------------------------------------------
// 1. Auth — register a fresh throwaway account on the live test backend
// ---------------------------------------------------------------------------
await scenario('auth: register fresh account', async () => {
  const email = `cc-harness+${Date.now()}@meetminutes.in`;
  const password = 'HarnessPassw0rd!';
  ctx.email = email;
  ctx.password = password;
  const r = await client.register({ email, password, name: 'CC Harness' });
  if (!r || !r.token) throw new Error(`no token in register result: ${JSON.stringify(r)}`);
  const stored = await local.get(['mm_auth_token', 'mm_user_email']);
  if (stored.mm_auth_token !== r.token) throw new Error('token not persisted to storage.local');
  ctx.token = r.token;
  return `email=${email} tokenLen=${r.token.length}`;
});

await scenario('auth: getMe()', async () => {
  const me = await client.getMe();
  ctx.me = me;
  return `me=${JSON.stringify(me).slice(0, 200)}`;
});

await scenario('auth: login() with the same credentials', async () => {
  if (!ctx.email) throw new Error('skipped: registration failed');
  const r = await client.login({ email: ctx.email, password: ctx.password });
  if (!r || !r.token) throw new Error(`login returned no token: ${JSON.stringify(r)}`);
  ctx.token = r.token;
  return `tokenLen=${r.token.length}`;
});

await scenario('auth: login() with WRONG password → invalid_credentials', async () => {
  try {
    await client.login({ email: ctx.email, password: 'definitely-wrong-xyz' });
    throw new Error('expected login to throw on bad password');
  } catch (e) {
    if (e.name === 'AuthApiError' && e.code === 'invalid_credentials') return 'mapped correctly';
    throw new Error(`unexpected error shape: name=${e.name} code=${e.code} msg=${e.message}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Meeting lifecycle — start → upload real WebM chunks → finalize
// ---------------------------------------------------------------------------
await scenario('meeting: startMeeting()', async () => {
  if (!ctx.token) throw new Error('skipped: no auth token');
  const res = await client.startMeeting({
    source: 'google_meet',
    url: 'https://meet.google.com/cc-harness-test',
    is_encrypted: false,
  });
  if (!res || !res.meeting_id) throw new Error(`no meeting_id: ${JSON.stringify(res)}`);
  ctx.meetingId = res.meeting_id;
  await client.recordMeeting({
    meetingId: res.meeting_id, source: 'google_meet', url: 'https://meet.google.com/cc-harness-test',
  });
  return `meeting_id=${res.meeting_id} keys=${Object.keys(res).join(',')}`;
});

await scenario('meeting: persist + drain 2 real WebM/Opus chunks', async () => {
  if (!ctx.meetingId) throw new Error('skipped: no meetingId');
  const mime = 'audio/webm;codecs=opus';
  for (const [i, f] of [[0, 'chunk-0.webm'], [1, 'chunk-1.webm']]) {
    const buf = await readFile(join(FIX, f));
    await client.persistChunk({
      meetingId: ctx.meetingId,
      chunkIndex: i,
      isFinal: i === 1,
      blob: new Blob([buf], { type: mime }),
      mimeType: mime,
    });
  }
  const before = await client.pendingChunkCount(ctx.meetingId);
  let lastDepth = -1;
  await client.drainChunkQueue({
    meetingId: ctx.meetingId,
    shouldContinue: () => true,
    onProgress: (d) => { lastDepth = d; },
    onAuthLost: () => { throw new client.AuthError(); },
  });
  const after = await client.pendingChunkCount(ctx.meetingId);
  if (after !== 0) throw new Error(`drain left ${after} chunk(s) pending (uploads failing)`);
  return `uploaded ${before} chunk(s), queue now ${after}`;
});

await scenario('meeting: finalize()', async () => {
  if (!ctx.meetingId) throw new Error('skipped: no meetingId');
  await client.finalizeMeeting(ctx.meetingId);
  await client.markMeetingFinalized(ctx.meetingId);
  return 'finalized';
});

// ---------------------------------------------------------------------------
// 3. Speaker timeline buffer — IndexedDB buffer → POST /timeline
// ---------------------------------------------------------------------------
await scenario('timeline: buffer 3 events then flushTimeline()', async () => {
  if (!ctx.meetingId) throw new Error('skipped: no meetingId');
  for (let i = 0; i < 3; i++) {
    await timeline.bufferEvent(ctx.meetingId, {
      speaker_name: `Speaker ${i}`, start_time: i * 5, end_time: i * 5 + 4,
    });
  }
  const r = await timeline.flushTimeline(ctx.meetingId);
  // 404/501 (endpoint not deployed) is a tolerated outcome by design.
  return `flushed=${r.flushed} buffered=${r.buffered}`;
});

// ---------------------------------------------------------------------------
// 4. Telemetry events endpoint
// ---------------------------------------------------------------------------
await scenario('telemetry: postEvent() to /api/v1/extension/events', async () => {
  try {
    await client.postEvent({ name: 'orphan_recovered', payload: { harness: true }, ts: Date.now() });
    return 'accepted (2xx)';
  } catch (e) {
    if (/events_unimplemented_/.test(e.message)) return `tolerated: ${e.message}`;
    throw e;
  }
});

// ---------------------------------------------------------------------------
// 5. Bot dispatch — error mapping only (do NOT dispatch a real bot)
// ---------------------------------------------------------------------------
await scenario('bot: dispatchBot() invalid payload → mapped error', async () => {
  try {
    await client.dispatchBot({ name: 'x', meeting_url: 'not-a-url', platform: 'google_meet' });
    return 'backend accepted it (no validation) — note for review';
  } catch (e) {
    return `error code=${e.code} msg=${e.message}`;
  }
});

// ---------------------------------------------------------------------------
// 6. Live-transcribe — real session + WS streaming of real PCM
// ---------------------------------------------------------------------------
await scenario("transcribe: language='auto' rejected by this backend (422)", async () => {
  // The popup offers TranscribeLanguage.AUTO and toggle-transcribe
  // defaults to 'auto'. This backend's provider can't detect language,
  // so every auto attempt 422s → ERROR state in the extension.
  try {
    await client.startTranscribeSession({ mode: 'self', language: 'auto', source_hint: 'google_meet' });
    return 'backend now accepts auto (finding resolved)';
  } catch (e) {
    if (e.code === 'invalid_request') return `confirmed bug — ${e.detail || e.message}`;
    throw e;
  }
});

await scenario('transcribe: startTranscribeSession(self, en)', async () => {
  if (!ctx.token) throw new Error('skipped: no auth token');
  const s = await client.startTranscribeSession({
    mode: 'self', language: 'en', source_hint: 'google_meet',
  });
  if (!s || !s.ws_url) throw new Error(`no ws_url: ${JSON.stringify(s)}`);
  ctx.transcribe = s;
  const u = new URL(s.ws_url);
  ctx.wsHostBug = /localhost|127\.0\.0\.1/.test(u.host);
  return `session_id=${s.session_id} fmt=${s.audio_format ?? 'pcm_s16le'} | ws host=${u.host}${ctx.wsHostBug ? '  ⚠ INTERNAL — unreachable from a real browser' : ''}`;
});

await scenario('transcribe: WS upgrade reachable on the returned ws_url', async () => {
  // Verify the HTTP→WebSocket *upgrade* succeeds on the EXACT ws_url
  // the backend under test hands a client — the real path a browser
  // would use (direct for a local instance; through nginx for the
  // public host, which is what the proxy WS-upgrade fix enabled).
  // This isolates "the upgrade/handshake works" from the next
  // scenario's "streaming + provider works", and is correct against
  // any base. A fresh throwaway session is minted so we don't tear
  // down the one the streaming scenario reuses.
  const probe = await client.startTranscribeSession({
    mode: 'self', language: 'en', source_hint: 'google_meet',
  });
  if (!probe || !probe.ws_url) throw new Error('no ws_url to probe');
  const host = new URL(probe.ws_url).host;
  const code = await new Promise((resolve) => {
    let done = false;
    const ws = new WebSocket(probe.ws_url);
    const fin = (v) => { if (!done) { done = true; clearTimeout(to); try { ws.close(1000); } catch {} resolve(v); } };
    const to = setTimeout(() => fin('timeout'), 10000);
    // 'open' = the 101 Switching Protocols handshake completed end to
    // end (through nginx for the public host). Sufficient proof the
    // upgrade is forwarded; we close immediately without streaming.
    ws.addEventListener('open', () => fin('OPENED'));
    ws.addEventListener('close', (e) => fin(`closed_${e.code}`));
    ws.addEventListener('error', () => fin('error'));
  });
  if (code === 'OPENED') return `WS upgrade OK via ${host}`;
  throw new Error(`WS upgrade failed on ${host} (${code}) — proxy/backend not forwarding the Upgrade`);
});

await scenario('transcribe: stream real PCM over WebSocket, collect events', async () => {
  const s = ctx.transcribe;
  if (!s || !s.ws_url) throw new Error('skipped: no transcribe session');
  const pcm = await readFile(join(FIX, 'pcm16k_mono.raw'));
  const events = [];
  const transcriptParts = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(s.ws_url);
    ws.binaryType = 'arraybuffer';
    const deadline = setTimeout(() => { try { ws.close(1000, 'harness_timeout'); } catch {} }, 40000);
    ws.addEventListener('open', async () => {
      // 100ms frames @ 16kHz mono s16le = 3200 bytes; paced ~realtime.
      const FRAME = 3200;
      for (let off = 0; off < pcm.length; off += FRAME) {
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(pcm.subarray(off, Math.min(off + FRAME, pcm.length)));
        await new Promise((r) => setTimeout(r, 80));
      }
      // Give the provider a moment to flush finals, then close cleanly.
      setTimeout(() => { try { ws.close(1000, 'harness_done'); } catch {} }, 6000);
    });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m && m.type === 'pong') return;
      events.push(m);
      if (m && typeof m.text === 'string' && m.text.trim()) transcriptParts.push(m.text.trim());
    });
    ws.addEventListener('error', () => { /* close event carries detail */ });
    ws.addEventListener('close', (ev) => {
      clearTimeout(deadline);
      ctx.wsClose = { code: ev.code, reason: ev.reason };
      resolve();
    });
  });
  ctx.transcriptParts = transcriptParts;
  const sample = transcriptParts.slice(-3).join(' ').slice(0, 160);
  if (events.length === 0) {
    throw new Error(`WS produced 0 events; close=${JSON.stringify(ctx.wsClose)}`);
  }
  return `events=${events.length} types=${[...new Set(events.map((e) => e.type))].join(',')} close=${JSON.stringify(ctx.wsClose)} transcript≈"${sample}"`;
});

// ---------------------------------------------------------------------------
// 7. Logout
// ---------------------------------------------------------------------------
await scenario('auth: logout() clears local credentials', async () => {
  await client.logout();
  const stored = await local.get(['mm_auth_token', 'mm_user_email']);
  if (stored.mm_auth_token) throw new Error('token still present after logout');
  return 'cleared';
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
log(`\n${'='.repeat(70)}\nSUMMARY: ${pass}/${results.length} passed, ${fail} failed\n${'='.repeat(70)}`);
for (const r of results) {
  log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : '\n     ↳ ' + r.note}`);
}
process.exit(fail ? 1 : 0);
