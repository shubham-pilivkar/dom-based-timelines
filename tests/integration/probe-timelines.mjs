// End-to-end proof for the SECOND finalize artifact the user cares
// about: speaker timelines.json. Real client.js drives:
//   register → startMeeting (sets client_started_at) → upload real
//   chunks → postTimeline(events) (creates a SpeakerTimeline row) →
//   finalize → reconciler runs run_finalize inline →
//   consolidate_speaker_timeline writes users/<uid>/<sid>/timelines.json.
// Then it polls status; a follow-up python check lists the GCS prefix.
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
const email = `cc-tl+${Date.now()}@meetminutes.in`;
await client.register({ email, password: 'HarnessPassw0rd!', name: 'TL' });

const m = await client.startMeeting({ name: 'Timelines probe', isEncrypted: false });
const rid = m.recording_id;
log('recording_id =', rid);

const mime = 'audio/webm;codecs=opus';
for (const [i, f] of [[0, 'chunk-0.webm'], [1, 'chunk-1.webm'], [2, 'chunk-2.webm']]) {
  const buf = await readFile(join(FIX, f));
  await client.persistChunk({
    meetingId: rid, chunkIndex: i, isFinal: i === 2,
    blob: new Blob([buf], { type: mime }), mimeType: mime,
  });
}
await client.drainChunkQueue({
  meetingId: rid, shouldContinue: () => true,
  onProgress: () => {}, onAuthLost: () => { throw new Error('auth lost'); },
});
log('chunks uploaded; pending =', await client.pendingChunkCount(rid));

// Real speaker-change events — exactly the shape overlay/timeline-buffer
// emit (seconds-since-start; backend normalises via client_started_at).
const events = [
  { type: 'SPEAKER_CHANGE', speaker_name: 'Alice', start_time: 0, end_time: 7 },
  { type: 'SPEAKER_CHANGE', speaker_name: 'Bob', start_time: 7, end_time: 15 },
  { type: 'SPEAKER_CHANGE', speaker_name: 'Alice', start_time: 15, end_time: 23 },
];
await client.postTimeline(rid, events);
log(`pushed ${events.length} speaker-timeline events`);

await client.finalizeMeeting(rid);
log('finalize() → 202; reconciler will run_finalize inline (no arq worker)…');

const token = (await local.get('mm_auth_token')).mm_auth_token;
const deadline = Date.now() + 300000;
let status = 'finalizing';
let body = {};
while (Date.now() < deadline) {
  const r = await fetch(`${BASE}/api/v1/recordings/${rid}/status`, {
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
log('RID', rid);
log('USER_EMAIL', email);
if (status !== 'finalized') {
  console.log(`❌ not finalized (status=${status}) — ${JSON.stringify(body).slice(0, 300)}`);
  process.exit(1);
}
console.log('✅ finalized — now verifying GCS artifacts via backend storage.');
process.exit(0);
