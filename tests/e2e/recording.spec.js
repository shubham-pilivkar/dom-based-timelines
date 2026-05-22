// Recording-flow e2e — exercises the SW orchestration end-to-end against
// a mock backend. We deliberately do NOT depend on real chrome.tabCapture
// in headless: the API requires activeTab + user invocation of the
// extension's action button, which Playwright can't reproduce without a
// headed browser. Instead we monkey-patch getMediaStreamId in the SW to
// return a synthetic id; the offscreen then fails at getUserMedia
// (expected — the id isn't real). This still validates the part we
// care about most: SW orchestration of streamId → /meetings/start →
// offscreen creation → state transitions.
//
// A second test confirms our bug fix for the failure path: when
// tabCapture is refused, the SW must transition to ERROR rather than
// stay stuck in STARTING.

import { test, expect, chromium } from '@playwright/test';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../dist');

let context;
let extensionId;
let optionsPath;
let server;
let serverPort;
/** @type {Array<{ method: string, path: string, body: Buffer }>} */
let requests;

function startMockBackend() {
  requests = [];
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        requests.push({ method: req.method, path: req.url, body });
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.url === '/api/v1/meetings/start') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              meeting_id: 'm-test',
              upload_url: '/api/v1/meetings/m-test/chunks',
            }),
          );
          return;
        }
        if (
          req.url.includes('/chunks') ||
          req.url.endsWith('/finalize') ||
          req.url.includes('/timeline') ||
          req.url.includes('/events') ||
          req.url === '/api/v1/me'
        ) {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}

test.beforeAll(async () => {
  if (!existsSync(EXTENSION_PATH)) {
    throw new Error('dist/ not found — run `npm run build` first.');
  }
  optionsPath = JSON.parse(
    readFileSync(path.join(EXTENSION_PATH, 'manifest.json'), 'utf8'),
  ).options_page;

  await startMockBackend();

  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      // These let getUserMedia succeed for the mic; tabCapture is a
      // separate path and is mocked in the test that needs it to work.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2];

  await worker.evaluate(async (url) => {
    await chrome.storage.local.set({
      mm_api_base_url: url,
      mm_auth_token: 'e2e-token',
      mm_video_bitrate: 1_000_000,
      mm_audio_bitrate: 64_000,
    });
  }, `http://127.0.0.1:${serverPort}`);
});

test.afterAll(async () => {
  await context?.close();
  await new Promise((r) => server?.close(r));
});

test.beforeEach(async () => {
  // Drain prior request log + reset SW session state so each test
  // starts from IDLE.
  requests.length = 0;
  const [worker] = context.serviceWorkers();
  await worker.evaluate(async () => {
    await chrome.storage.session.set({
      mm_session_state: {
        state: 'IDLE',
        meetingId: null,
        tabId: null,
        source: null,
        url: null,
        recordingStartedAt: null,
        micAvailable: false,
        uploadQueueDepth: 0,
        currentSpeaker: null,
        errorMessage: null,
        lastChunkIndex: -1,
        lastHeartbeatAt: 0,
        monitorBlocked: false,
        queueWarning: false,
        recordingPaused: false,
      },
    });
  });
});

async function readSwState(worker) {
  return worker.evaluate(async () => {
    const got = await chrome.storage.session.get('mm_session_state');
    return got.mm_session_state ?? null;
  });
}

test('SW posts /meetings/start with the right body when tabCapture succeeds', async () => {
  const [worker] = context.serviceWorkers();

  // Monkey-patch tabCapture so the SW gets a (synthetic) stream id and
  // proceeds to call /meetings/start. The offscreen will fail at
  // getUserMedia because the id is fake — that's expected and tested
  // below via the eventual ERROR transition.
  await worker.evaluate(() => {
    chrome.tabCapture.getMediaStreamId = (_opts, cb) => cb('e2e-fake-stream');
  });

  // Driver page (any extension page works) for sending the message.
  const driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/${optionsPath}`);
  await driver.evaluate(() => {
    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      tabId: 999, // synthetic — tabCapture is mocked, doesn't dereference
      url: 'https://meet.google.com/e2e-test',
      source: 'google_meet',
    });
  });

  // Wait for the SW to actually post /meetings/start. Filter by POST
  // because CORS preflights (OPTIONS) hit the same path with an empty
  // body and would mask the real request.
  await expect
    .poll(
      () =>
        requests.filter(
          (r) => r.method === 'POST' && r.path === '/api/v1/meetings/start',
        ).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(1);

  const startReq = requests.find(
    (r) => r.method === 'POST' && r.path === '/api/v1/meetings/start',
  );
  const body = JSON.parse(startReq.body.toString());
  expect(body.source).toBe('google_meet');
  expect(body.url).toBe('https://meet.google.com/e2e-test');

  // SW should record the meeting in its IDB metadata store too.
  const recordedMeeting = await worker.evaluate(async () => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('meetminutes-chunks', 2);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('meetings', 'readonly');
        const getAll = tx.objectStore('meetings').getAll();
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
  expect(recordedMeeting.length).toBeGreaterThanOrEqual(1);
  expect(recordedMeeting[0].source).toBe('google_meet');

  // Offscreen will fail → SW should land in ERROR. (No chunks should
  // have been uploaded; no /finalize.)
  await expect
    .poll(async () => (await readSwState(worker)).state, { timeout: 15_000 })
    .toBe('ERROR');
  expect(requests.filter((r) => r.path.endsWith('/finalize')).length).toBe(0);

  await driver.close();
});

test('tabCapture refusal lands the SW in ERROR (not stuck in STARTING)', async () => {
  const [worker] = context.serviceWorkers();

  // Restore the real tabCapture so it refuses (no activeTab grant in
  // this headless environment — the canonical failure mode).
  await worker.evaluate(() => {
    delete chrome.tabCapture.getMediaStreamId;
  });
  // Reload the extension's tabCapture binding by re-importing — actually
  // chrome.tabCapture.getMediaStreamId is a getter on the namespace,
  // re-fetched per call. The previous mock was a property override; the
  // delete above restores the prototype getter.

  const driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/${optionsPath}`);
  await driver.evaluate(() => {
    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      tabId: 999,
      url: 'https://meet.google.com/refused',
      source: 'google_meet',
    });
  });

  await expect
    .poll(async () => (await readSwState(worker)).state, { timeout: 15_000 })
    .toBe('ERROR');

  const state = await readSwState(worker);
  expect(state.errorMessage).toMatch(/tabCapture_failed/);

  await driver.close();
});
