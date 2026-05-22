// Failure-recovery + continuity suite. Exercises the real api/client.js
// resilience paths against the live backend: auth-loss mid-drain,
// orphan recovery, idempotent re-upload, deterministic auth failure,
// and the bot-dispatch happy path (validates the B1 fix doesn't
// over-reject valid URLs).
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { local } from './env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const BASE = process.env.MM_BASE || 'https://test-api.meetminutes.in';
await local.set({ mm_api_base_url: BASE });
const client = await import('../../src/api/client.js');

const results = [];
async function scenario(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ PASS${note ? ' — ' + note : ''}`);
  } catch (e) {
    results.push({ name, ok: false, note: e.message });
    console.log(`  ❌ FAIL — ${e.stack ? e.stack.split('\n').slice(0,2).join(' | ') : e}`);
  }
}

const email = `cc-rec+${Date.now()}@meetminutes.in`;
const { token } = await client.register({ email, password: 'HarnessPassw0rd!', name: 'Rec' });
const webm = await readFile(join(FIX, 'chunk-0.webm'));
const mkBlob = () => new Blob([webm], { type: 'audio/webm;codecs=opus' });

// R1 — auth lost mid-drain: junk token → onAuthLost fires, chunk kept.
await scenario('drain with expired token → onAuthLost, chunk preserved (NEEDS_REAUTH path)', async () => {
  const m = await client.startMeeting({ source: 'google_meet', url: 'https://meet.google.com/r1', is_encrypted: false });
  await client.persistChunk({ meetingId: m.meeting_id, chunkIndex: 0, isFinal: true, blob: mkBlob(), mimeType: 'audio/webm;codecs=opus' });
  await local.set({ mm_auth_token: 'totally-invalid-token' });
  let authLost = false;
  await client.drainChunkQueue({
    meetingId: m.meeting_id, shouldContinue: () => true,
    onProgress: () => {}, onAuthLost: () => { authLost = true; },
  });
  const remaining = await client.pendingChunkCount(m.meeting_id);
  await local.set({ mm_auth_token: token }); // restore
  if (!authLost) throw new Error('onAuthLost never fired on 401');
  if (remaining !== 1) throw new Error(`chunk lost — expected 1 pending, got ${remaining}`);
  return 'auth-loss handled, chunk safe on disk';
});

// R2 — orphan recovery primitives: a meeting left un-finalized is
// discoverable, drainable, and finalizable on the next "startup".
await scenario('orphan recovery: unfinalized meeting → drain + finalize → cleared', async () => {
  const m = await client.startMeeting({ source: 'ms_teams', url: 'https://teams.microsoft.com/r2', is_encrypted: false });
  await client.recordMeeting({ meetingId: m.meeting_id, source: 'ms_teams', url: 'https://teams.microsoft.com/r2' });
  await client.persistChunk({ meetingId: m.meeting_id, chunkIndex: 0, isFinal: true, blob: mkBlob(), mimeType: 'audio/webm;codecs=opus' });
  const orphansBefore = await client.listUnfinalizedMeetings();
  if (!orphansBefore.some((o) => o.meetingId === m.meeting_id)) throw new Error('meeting not listed as orphan');
  await client.drainChunkQueue({ meetingId: m.meeting_id, shouldContinue: () => true, onProgress: () => {}, onAuthLost: () => {} });
  await client.finalizeMeeting(m.meeting_id);
  await client.markMeetingFinalized(m.meeting_id);
  const orphansAfter = await client.listUnfinalizedMeetings();
  if (orphansAfter.some((o) => o.meetingId === m.meeting_id)) throw new Error('still listed as orphan after finalize');
  return `recovered + finalized ${m.meeting_id.slice(0,8)}`;
});

// R3 — idempotent re-upload: re-persisting the same chunk_index and
// draining again must not error (backend dedupes by session,index).
await scenario('idempotent re-upload: same chunk_index twice → no error, queue clears', async () => {
  const m = await client.startMeeting({ source: 'google_meet', url: 'https://meet.google.com/r3', is_encrypted: false });
  await client.persistChunk({ meetingId: m.meeting_id, chunkIndex: 0, isFinal: false, blob: mkBlob(), mimeType: 'audio/webm;codecs=opus' });
  await client.drainChunkQueue({ meetingId: m.meeting_id, shouldContinue: () => true, onProgress: () => {}, onAuthLost: () => { throw new Error('unexpected auth loss'); } });
  // Re-persist the SAME index (simulates a retry after a lost ack).
  await client.persistChunk({ meetingId: m.meeting_id, chunkIndex: 0, isFinal: true, blob: mkBlob(), mimeType: 'audio/webm;codecs=opus' });
  await client.drainChunkQueue({ meetingId: m.meeting_id, shouldContinue: () => true, onProgress: () => {}, onAuthLost: () => { throw new Error('unexpected auth loss'); } });
  const remaining = await client.pendingChunkCount(m.meeting_id);
  if (remaining !== 0) throw new Error(`duplicate chunk_index not accepted; ${remaining} stuck`);
  await client.finalizeMeeting(m.meeting_id);
  return 'backend deduped duplicate chunk_index cleanly';
});

// R4 — bot dispatch happy path (verifies B1 fix passes valid URLs).
await scenario('bot dispatch: valid Meet URL → 202 dispatched/queued', async () => {
  const r = await client.dispatchBot({
    name: 'CC Recovery Bot', meeting_url: 'https://meet.google.com/abc-defg-hij', platform: 'google_meet',
  });
  if (!r || !r.bot_id || !['dispatched', 'queued'].includes(r.status)) {
    throw new Error(`unexpected: ${JSON.stringify(r)}`);
  }
  return `bot_id=${r.bot_id} status=${r.status}`;
});

// R5 — deterministic auth failure: startMeeting with junk token must
// fail fast as AuthError (no retry storm against 401).
await scenario('startMeeting with bad token → AuthError fast, no retry storm', async () => {
  await local.set({ mm_auth_token: 'junk' });
  const t0 = Date.now();
  try {
    await client.startMeeting({ source: 'google_meet', url: 'https://meet.google.com/r5', is_encrypted: false });
    throw new Error('expected AuthError');
  } catch (e) {
    const ms = Date.now() - t0;
    await local.set({ mm_auth_token: token });
    if (e.name !== 'AuthError') throw new Error(`expected AuthError, got ${e.name}: ${e.message}`);
    if (ms > 2000) throw new Error(`took ${ms}ms — looks like it retried a deterministic 401`);
    return `failed fast in ${ms}ms`;
  }
});

// R6 — session continuity: logout clears, re-login restores a working token.
await scenario('logout → re-login restores a usable session', async () => {
  await client.logout();
  if ((await local.get('mm_auth_token')).mm_auth_token) throw new Error('token not cleared on logout');
  const r = await client.login({ email, password: 'HarnessPassw0rd!' });
  if (!r.token) throw new Error('re-login returned no token');
  const me = await client.getMe();
  if (me.email !== email) throw new Error(`getMe mismatch: ${JSON.stringify(me)}`);
  return 'session restored, getMe() works post-relogin';
});

const pass = results.filter((r) => r.ok).length;
console.log(`\n${'='.repeat(64)}\nFAILURE-RECOVERY: ${pass}/${results.length} passed\n${'='.repeat(64)}`);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : '\n     ↳ ' + r.note}`);
process.exit(pass === results.length ? 0 : 1);
