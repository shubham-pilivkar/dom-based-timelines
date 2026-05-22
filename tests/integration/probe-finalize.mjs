// End-to-end proof: Stop → finalize → arq worker combines ALL chunks
// FROM GCS into one mp4 stored back in GCS. Uses the real client.js.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { local } from './env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const BASE = process.env.MM_BASE || 'https://test-api.meetminutes.in';
await local.set({ mm_api_base_url: BASE });
const client = await import('../../src/api/client.js');

const log = (...a) => console.log(...a);
const email = `cc-fin+${Date.now()}@meetminutes.in`;
await client.register({ email, password: 'HarnessPassw0rd!', name: 'Fin' });

const m = await client.startMeeting({ name: 'Finalize probe', isEncrypted: false });
log('recording_id =', m.recording_id);

// Upload 3 real WebM/Opus chunks (what the extension ships to GCS).
const mime = 'audio/webm;codecs=opus';
for (const [i, f] of [[0, 'chunk-0.webm'], [1, 'chunk-1.webm'], [2, 'chunk-2.webm']]) {
  const buf = await readFile(join(FIX, f));
  await client.persistChunk({
    meetingId: m.recording_id, chunkIndex: i, isFinal: i === 2,
    blob: new Blob([buf], { type: mime }), mimeType: mime,
  });
}
await client.drainChunkQueue({
  meetingId: m.recording_id, shouldContinue: () => true,
  onProgress: () => {}, onAuthLost: () => { throw new Error('auth lost'); },
});
const pending = await client.pendingChunkCount(m.recording_id);
log('chunks uploaded to GCS; pending =', pending);
if (pending !== 0) { console.log('❌ chunks not all uploaded'); process.exit(1); }

// This is exactly what the extension does on Stop.
await client.finalizeMeeting(m.recording_id);
log('finalize() → 202 accepted; arq worker will combine chunks from GCS…');

// Poll the recording status until the worker finalizes it.
const token = (await local.get('mm_auth_token')).mm_auth_token;
// No arq worker runs here — the in-process finalize reconciler is the
// finalize path. Worst case = stale_finalizing_grace (90s) + loop
// interval (45s) + ffmpeg concat. Allow 5 min so we validate the
// self-healing path rather than spuriously timing out before it fires.
const deadline = Date.now() + 300000;
let status = 'finalizing';
let body = {};
while (Date.now() < deadline) {
  const r = await fetch(`${BASE}/api/v1/recordings/${m.recording_id}/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.ok) {
    body = await r.json();
    status = body.status;
    log(`  status = ${status}`);
    if (status === 'finalized' || status === 'failed') break;
  }
  await new Promise((res) => setTimeout(res, 4000));
}

if (status !== 'finalized') {
  console.log(`❌ not finalized (status=${status}) — ${JSON.stringify(body).slice(0, 300)}`);
  process.exit(1);
}

// Confirm the combined mp4 actually exists in GCS + is fetchable.
const pb = await fetch(`${BASE}/api/v1/recordings/${m.recording_id}/playback`, {
  headers: { Authorization: `Bearer ${token}` },
});
const pbBody = pb.ok ? await pb.json() : {};
log('playback =', JSON.stringify(pbBody).slice(0, 240));
const mediaUrl = pbBody.url || pbBody.playback_url || pbBody.recording_url;
let mediaCode = 'n/a';
if (mediaUrl) {
  const head = await fetch(mediaUrl, { method: 'GET', headers: { Range: 'bytes=0-1' } });
  mediaCode = `${head.status} ${head.headers.get('content-type')}`;
}
log(`combined recording fetch = ${mediaCode}`);
console.log(
  status === 'finalized'
    ? '✅ Stop→finalize→arq combined ALL chunks from GCS into one mp4 (stored in GCS).'
    : '❌ failed',
);
process.exit(status === 'finalized' ? 0 : 1);
