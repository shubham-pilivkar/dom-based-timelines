// Verbatim WS probe: connect to the real transcribe stream and log
// every inbound frame so we see exactly why streaming PCM errors.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { local } from './env.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MM_BASE || 'https://test-api.meetminutes.in';
await local.set({ mm_api_base_url: BASE });
const client = await import('../../src/api/client.js');

await client.register({ email: `cc-ws+${Date.now()}@meetminutes.in`, password: 'HarnessPassw0rd!', name: 'WS' });
const s = await client.startTranscribeSession({ mode: 'self', language: 'en', source_hint: 'google_meet' });
console.log('session:', JSON.stringify(s, null, 1));

const pcm = await readFile(join(HERE, 'fixtures', 'pcm16k_mono.raw'));
const ws = new WebSocket(s.ws_url);
ws.binaryType = 'arraybuffer';
let frames = 0;

ws.addEventListener('open', async () => {
  console.log('[open] streaming', pcm.length, 'bytes of 16k mono s16le PCM');
  const FRAME = 3200; // 100ms
  for (let off = 0; off < pcm.length && ws.readyState === WebSocket.OPEN; off += FRAME) {
    ws.send(pcm.subarray(off, Math.min(off + FRAME, pcm.length)));
    frames++;
    await new Promise((r) => setTimeout(r, 80));
  }
  console.log('[sent]', frames, 'binary frames; waiting 8s for finals');
  setTimeout(() => { try { ws.close(1000, 'done'); } catch {} }, 8000);
});
ws.addEventListener('message', (e) => {
  console.log('[msg]', typeof e.data === 'string' ? e.data.slice(0, 500) : `<binary ${e.data.byteLength}b>`);
});
ws.addEventListener('error', (e) => console.log('[error]', e.message || e.type || 'ws error'));
ws.addEventListener('close', (e) => { console.log('[close]', e.code, JSON.stringify(e.reason)); process.exit(0); });
setTimeout(() => { console.log('[hard-timeout]'); process.exit(1); }, 45000);
