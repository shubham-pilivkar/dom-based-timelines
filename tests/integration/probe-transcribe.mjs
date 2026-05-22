// Focused probe: why does POST /api/v1/transcribe/sessions 422?
// Registers a throwaway account, then tries several bodies and prints
// the raw status + response body so we see the backend's reason.
import { local } from './env.mjs';
const BASE = 'https://test-api.meetminutes.in';
await local.set({ mm_api_base_url: BASE });
const client = await import('../../src/api/client.js');

const email = `cc-probe+${Date.now()}@meetminutes.in`;
const { token } = await client.register({ email, password: 'HarnessPassw0rd!', name: 'CC Probe' });

async function probe(body) {
  const r = await fetch(`${BASE}/api/v1/transcribe/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`\n${JSON.stringify(body)}\n  → ${r.status} ${text.slice(0, 400)}`);
}

for (const lang of ['auto', 'en', 'hi', 'en-US']) {
  await probe({ mode: 'self', language: lang, source_hint: 'google_meet' });
}
await probe({ mode: 'participants', language: 'en' });
