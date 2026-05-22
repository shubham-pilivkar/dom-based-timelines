// Shared e2e harness.
//
// One place owns: the test-only manifest-CSP widening, a mock backend
// that speaks the LIVE API contract (so the specs are identical whether
// they hit the mock or a real backend), a hand-rolled WebSocket relay
// for live-transcribe, and the Chromium launch with fake-media flags.
//
// Live-backend switch: set MM_E2E_LIVE_BASE=http://host:port to run the
// specs against a real backend instead of the mock. The harness then
// registers a throwaway account there and seeds that token. (As of
// this writing the provided backend's Redis is down → tokens 401; the
// mock path keeps the suite green until /readyz is green.)

import { chromium } from '@playwright/test';
import http from 'node:http';
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = path.resolve(__dirname, '../../../dist');

export const LIVE_BASE = process.env.MM_E2E_LIVE_BASE || null;

// --- test-only: widen the built (gitignored) manifest CSP so the SW
// can reach a local http/ws backend. dist/ is a build artifact, never
// committed; `npm run build` regenerates it, so this never leaks into
// source or a shipped zip.
export function patchManifestCsp() {
  if (!existsSync(EXTENSION_PATH)) {
    throw new Error(`dist/ not found at ${EXTENSION_PATH} — run \`npm run build\` first.`);
  }
  const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const csp = manifest.content_security_policy.extension_pages;
  if (!csp.includes('http://localhost:*')) {
    manifest.content_security_policy.extension_pages = csp.replace(
      'connect-src ',
      'connect-src http://localhost:* http://127.0.0.1:* '
        + 'https://localhost:* https://127.0.0.1:* '
        + 'ws://localhost:* ws://127.0.0.1:* '
        + 'http://34.100.254.231:* ws://34.100.254.231:* ',
    );
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  return {
    popupPath: manifest.action?.default_popup,
    optionsPath: manifest.options_page,
  };
}

// Test-only: the shipped manifest only covers teams.microsoft.com.
// Consumer Teams runs on teams.live.com, where the content script
// never injects (a real product gap). Widen the BUILT (gitignored)
// manifest so the same teams.js code can be validated there. Mirrors
// every place teams.microsoft.com appears: content_scripts matches,
// web_accessible_resources matches, host_permissions. Idempotent.
export function widenManifestForTeamsLive() {
  const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const LIVE = 'https://teams.live.com/*';
  const MS = 'https://teams.microsoft.com/*';
  const addLive = (arr) => {
    if (Array.isArray(arr) && arr.includes(MS) && !arr.includes(LIVE)) arr.push(LIVE);
  };
  for (const cs of m.content_scripts || []) addLive(cs.matches);
  for (const war of m.web_accessible_resources || []) addLive(war.matches);
  if (Array.isArray(m.host_permissions) && m.host_permissions.includes(MS)
      && !m.host_permissions.includes(LIVE)) {
    m.host_permissions.push(LIVE);
  }
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
}

// ---------------------------------------------------------------------------
// Minimal RFC6455 WebSocket (server side). Enough for the transcribe
// relay: send unmasked text frames to the client, drain masked client
// frames (audio binary + heartbeat pings), answer ping/close.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Pull complete frames out of a rolling buffer. Returns the leftover.
function drainFrames(buf, onFrame) {
  let offset = 0;
  while (buf.length - offset >= 2) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      if (buf.length - offset < 4) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - offset < 10) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break; // incomplete — wait for more
    let payload = buf.subarray(p + maskLen, p + maskLen + len);
    if (masked) {
      const mask = buf.subarray(p, p + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    onFrame(opcode, payload);
    offset = p + maskLen + len;
  }
  return buf.subarray(offset);
}

// ---------------------------------------------------------------------------

export function createMockBackend() {
  /** @type {Array<{method:string,url:string,body:string,json:any}>} */
  const requests = [];
  /** @type {Array<(conn:any)=>void>} */
  const wsHandlers = [];
  const wsConnections = [];
  // Mode 3 mints TWO sessions (self=mic, participants=tab). Map the
  // returned sid → requested mode so the WS handler can tell which
  // substream a connection belongs to.
  const sessionModeBySid = {};

  function jsonBody(req, res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch { /* form / binary */ }
      requests.push({ method: req.method, url: req.url, body: raw, json });

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      const u = req.url.split('?')[0];

      if (u === '/meet') {
        // Minimal stand-in for a Meet/Teams tab — the overlay content
        // script is injected here by the SW (host_permissions covers
        // localhost). No meeting DOM needed: speaker names come from
        // SPEAKER_CHANGE messages, not the page.
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><head><title>fake meet</title></head>'
          + '<body><div id="host">e2e meeting</div></body></html>');
        return;
      }
      if (u === '/auth/register' && req.method === 'POST') {
        return jsonBody(req, res, 201, { token: 'mock-token-' + Date.now() });
      }
      if (u === '/api/v1/me') {
        return jsonBody(req, res, 200, { email: 'e2e@example.com', plan: 'pro' });
      }
      if (u === '/api/v1/recordings' && req.method === 'POST') {
        return jsonBody(req, res, 201, {
          recording_id: 'rec-e2e-1',
          status: 'recording',
          upload_url: '/api/v1/recordings/rec-e2e-1/chunks',
        });
      }
      if (/\/timeline$/.test(u) && req.method === 'POST') {
        const n = Array.isArray(json?.events) ? json.events.length : 0;
        return jsonBody(req, res, 200, { accepted: n });
      }
      if (/\/finalize$/.test(u) && req.method === 'POST') {
        return jsonBody(req, res, 202, {});
      }
      if (/\/status$/.test(u)) {
        return jsonBody(req, res, 200, {
          status: 'finalized', uploaded_chunks: 1, expected_chunks: 1,
          final_url: '/media/rec-e2e-1.mp4', playlist_url: null,
        });
      }
      if (u === '/api/v1/transcribe/sessions' && req.method === 'POST') {
        const sid = 'sess-' + crypto.randomBytes(4).toString('hex');
        sessionModeBySid[sid] = json?.mode ?? 'participants';
        // Backend embeds an INTERNAL host; the client rewrites host →
        // configured base host (localhost:PORT), scheme ws. We keep
        // the path + query (sid/token).
        return jsonBody(req, res, 200, {
          session_id: sid,
          ws_url: `ws://internal-relay:9000/api/v1/transcribe/stream?sid=${sid}&token=t`,
          ws_token: 't',
          sample_rate: 16000,
          format: 'pcm_s16le',
          audio_format: 'pcm_s16le',
        });
      }
      // chunks, events, anything else the drain pump may hit.
      res.writeHead(202); res.end();
    });
  });

  // WebSocket upgrade — the transcribe relay.
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
    );
    const url = new URL(req.url, 'http://localhost');
    const conn = {
      sid: url.searchParams.get('sid'),
      url: req.url,
      socket,
      binaryFramesReceived: 0,
      closed: false,
      sendJSON(obj) {
        if (this.closed) return;
        try { socket.write(encodeTextFrame(JSON.stringify(obj))); } catch { /* gone */ }
      },
      close() {
        if (this.closed) return;
        this.closed = true;
        try { socket.write(Buffer.from([0x88, 0x00])); socket.end(); } catch { /* gone */ }
      },
    };
    wsConnections.push(conn);
    let acc = Buffer.alloc(0);
    socket.on('data', (d) => {
      acc = drainFrames(Buffer.concat([acc, d]), (opcode, payload) => {
        if (opcode === 0x8) { conn.closed = true; try { socket.end(); } catch { /* */ } }
        else if (opcode === 0x9) { try { socket.write(Buffer.from([0x8a, 0x00])); } catch { /* */ } }
        else if (opcode === 0x2) { conn.binaryFramesReceived += 1; }
        else if (opcode === 0x1) {
          // App-level control ping ({type:'control',action:'ping'}).
          try {
            const m = JSON.parse(payload.toString());
            if (m && m.action === 'ping') conn.sendJSON({ type: 'pong', id: m.id });
          } catch { /* not json */ }
        }
      });
    });
    socket.on('error', () => { conn.closed = true; });
    socket.on('close', () => { conn.closed = true; });
    for (const h of wsHandlers) { try { h(conn); } catch { /* handler threw */ } }
  });

  return {
    requests,
    wsConnections,
    sessionModeBySid,
    onTranscribeConnect(fn) { wsHandlers.push(fn); },
    reset() { requests.length = 0; },
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      this.port = server.address().port;
      this.url = `http://localhost:${this.port}`;
      return this.url;
    },
    async stop() {
      for (const c of wsConnections) c.close();
      await new Promise((r) => server.close(r));
    },
  };
}

// ---------------------------------------------------------------------------

export async function launchExtension() {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = worker.url().split('/')[2];
  return { context, worker, extensionId };
}

// Resolve the bearer token: register a throwaway account on the live
// backend, or just mint a mock token for the mock path.
export async function resolveToken(baseUrl) {
  if (!LIVE_BASE) return 'mock-token';
  const email = `mm-e2e-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@example.com`;
  const r = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'e2ePassw0rd123!' }),
  });
  if (!r.ok) throw new Error(`live register failed ${r.status}: ${await r.text()}`);
  return (await r.json()).token;
}

// Seed chrome.storage.local so the SW talks to our backend and skips
// the one-time mic-permission window.
export async function seedAuth(worker, { baseUrl, token, extra = {} }) {
  await worker.evaluate(async ([url, tok, ex]) => {
    await chrome.storage.local.set({
      mm_api_base_url: url,
      mm_auth_token: tok,
      // Post-Firebase-migration the client refreshes the ID token via a
      // refresh token before every authed call (getFreshIdToken). Seed a
      // full bundle with a far-future expiry so the seeded idToken is
      // returned as-is (no refresh round-trip) — without this, authed
      // calls throw AuthError and the SW lands in NEEDS_REAUTH.
      mm_refresh_token: 'mock-refresh-token',
      mm_token_expires_at: Date.now() + 3600_000,
      mm_user_email: 'e2e@example.com',
      mm_mic_granted: true,
      ...ex,
    });
  }, [baseUrl, token, extra]);
}

// The overlay content script + its WAR chunk are origin-locked to
// meet.google.com / teams.microsoft.com. Serve a stub page AT that
// origin via request interception so the real injection + dynamic
// import path runs (no network, no Meet login). Speaker names come
// from SPEAKER_CHANGE messages, so the page needs no meeting DOM.
export const FAKE_MEET_URL = 'https://meet.google.com/e2e-fake-room';

export async function routeFakeMeet(context) {
  await context.route('https://meet.google.com/**', (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Meet (e2e)</title></head>'
        + '<body><div id="host">e2e meeting</div></body></html>',
    });
  });
}

export async function getSwState(worker) {
  return worker.evaluate(async () => {
    const g = await chrome.storage.session.get('mm_session_state');
    return g.mm_session_state ?? null;
  });
}

export async function getTranscribeState(worker) {
  return worker.evaluate(async () => {
    const g = await chrome.storage.session.get('mm_transcribe_state');
    return g.mm_transcribe_state ?? null;
  });
}

// Poll helper — Playwright's expect.poll is per-spec; this keeps the
// harness dependency-light.
export async function until(fn, { timeout = 20000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  return last;
}
