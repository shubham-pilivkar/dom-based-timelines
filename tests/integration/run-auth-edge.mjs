// Auth-validation edge suite — exercises the real client.js auth
// surface against the live backend: weak/duplicate/invalid inputs,
// anti-enumeration, logout-without-token, case-insensitivity, and the
// error-code mapping the popup relies on.
//
// The backend enforces a 5/min/IP limit on /auth/register (a real
// security control we must NOT disable). A naive suite that registers
// a fresh account per scenario self-trips it. Two deterministic
// mitigations, neither weakening the product:
//   1. Reuse ONE primary account for every scenario that just needs
//      "an existing user" (duplicate/wrong-pw/lifecycle/case) → only
//      4 register calls total, under the limit.
//   2. ``regRetry`` backs off and retries iff the backend itself
//      returns rate_limited (e.g. a prior suite consumed tokens from
//      this IP) — so the suite stays green and also asserts the
//      product's 429→rate_limited mapping works.
import { local } from './env.mjs';
const BASE = process.env.MM_BASE || 'https://test-api.meetminutes.in';
await local.set({ mm_api_base_url: BASE });
const client = await import('../../src/api/client.js');

const R = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function S(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  try { const n = await fn(); R.push({ ok: true, name }); console.log(`  ✅ PASS${n ? ' — ' + n : ''}`); }
  catch (e) { R.push({ ok: false, name, d: e.message }); console.log(`  ❌ FAIL — ${e.message}`); }
}

// Run an auth call; if (and only if) the backend rate-limits us,
// wait out the rolling 1-min window and retry. Any other outcome
// (success OR a different AuthApiError) returns immediately so the
// scenario can assert it.
async function regRetry(fn, { tries = 4, waitMs = 20000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (e && e.name === 'AuthApiError' && e.code === 'rate_limited' && i < tries - 1) {
        await sleep(waitMs);
        continue;
      }
      throw e;
    }
  }
  throw last;
}

const expectAuthErr = async (fn, codes) => {
  try { await fn(); throw new Error('expected an AuthApiError'); }
  catch (e) {
    if (e.name !== 'AuthApiError') throw new Error(`got ${e.name}: ${e.message}`);
    if (!codes.includes(e.code)) throw new Error(`code=${e.code} (expected one of ${codes})`);
    return e.code;
  }
};

// ── One shared primary account (register #1, with 429 backoff) ──
const PRIMARY_EMAIL = `cc-authedge+${Date.now()}-${Math.random().toString(36).slice(2, 7)}@meetminutes.in`;
const PRIMARY_PW = 'PrimaryPassw0rd!';
let primaryReady = false;
await S('setup: register the shared primary account', async () => {
  await regRetry(() => client.register({ email: PRIMARY_EMAIL, password: PRIMARY_PW, name: 'Primary' }));
  primaryReady = true;
  return PRIMARY_EMAIL;
});
const needPrimary = () => { if (!primaryReady) throw new Error('skipped: primary account not registered'); };

// ── register-bearing validation scenarios (registers #2 and #3) ──
await S('register: password < 10 chars → invalid_input', async () => {
  const c = await expectAuthErr(
    () => regRetry(() => client.register({ email: `cc-bp+${Date.now()}@meetminutes.in`, password: 'short' })),
    ['invalid_input'],
  );
  return c;
});

await S('register: malformed email → invalid_input', async () => {
  const c = await expectAuthErr(
    () => regRetry(() => client.register({ email: 'not-an-email', password: 'ValidPassw0rd!' })),
    ['invalid_input'],
  );
  return c;
});

// register #4: the duplicate attempt reuses the primary email (no new
// valid account needed → one fewer registration).
await S('register: duplicate email → email_taken', async () => {
  needPrimary();
  const c = await expectAuthErr(
    () => regRetry(() => client.register({ email: PRIMARY_EMAIL, password: 'AnotherPass12!' })),
    ['email_taken'],
  );
  return c;
});

// ── login-only scenarios (login limit is separate, 10/min) ──
await S('login: unknown email → invalid_credentials (anti-enumeration)', async () => {
  const c = await expectAuthErr(
    () => client.login({ email: `cc-nope+${Date.now()}@meetminutes.in`, password: 'whatever123' }),
    ['invalid_credentials'],
  );
  return c;
});

await S('login: correct email, wrong password → invalid_credentials', async () => {
  needPrimary();
  const c = await expectAuthErr(
    () => client.login({ email: PRIMARY_EMAIL, password: 'WrongHorse9!' }),
    ['invalid_credentials'],
  );
  return c;
});

await S('session lifecycle: login → getMe → logout → getMe denied', async () => {
  needPrimary();
  const r = await client.login({ email: PRIMARY_EMAIL, password: PRIMARY_PW });
  if (!r.token) throw new Error('primary re-login failed');
  const me = await client.getMe();
  if (me.email !== PRIMARY_EMAIL) throw new Error(`getMe mismatch ${JSON.stringify(me)}`);
  await client.logout();
  try {
    await client.getMe();
    throw new Error('getMe should fail after logout');
  } catch (e) {
    if (e.name !== 'AuthError' && !/me_failed_/.test(e.message)) {
      throw new Error(`unexpected post-logout error: ${e.name} ${e.message}`);
    }
  }
  return 'login/getMe/logout/deny consistent';
});

await S('logout with no token → no throw (idempotent)', async () => {
  await local.remove(['mm_auth_token', 'mm_user_email']);
  await client.logout();
  return 'graceful';
});

// Reuses primary (registered lowercased by the client) — log in with
// the email upper-cased. No new registration.
await S('email case-insensitivity: login with upper-cased email', async () => {
  needPrimary();
  const r = await client.login({ email: PRIMARY_EMAIL.toUpperCase(), password: PRIMARY_PW });
  if (!r.token) throw new Error('case-insensitive login failed — case handling broken');
  return 'case-insensitive login OK';
});

const pass = R.filter((r) => r.ok).length;
console.log(`\n${'='.repeat(60)}\nAUTH-EDGE: ${pass}/${R.length} passed\n${'='.repeat(60)}`);
for (const r of R) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : '  ↳ ' + r.d}`);
process.exit(pass === R.length ? 0 : 1);
