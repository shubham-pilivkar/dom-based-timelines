// Vitest global setup. Runs once before any test file is imported, so
// chrome / IndexedDB / AudioContext stubs are in place before the
// extension source modules execute their top-level statements (e.g.
// chrome.storage.onChanged.addListener in api/client.js).

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, vi } from 'vitest';

// ----- chrome.* stub -------------------------------------------------------

// Simulates a signed-in user. Post the Firebase-auth migration a
// valid session is the full token bundle (ID token + refresh token +
// a future expiry), not a bare token — getFreshIdToken() treats a
// token with no refresh/expiry as a stale legacy credential and
// forces re-auth (AuthError). The expiry is pinned far in the future
// so it stays "fresh" even under the suite's fake timers.
const defaultLocal = {
  mm_auth_token: 'test-token',
  mm_refresh_token: 'test-refresh-token',
  mm_token_expires_at: 4102444800000, // 2100-01-01
  mm_api_base_url: 'http://test.invalid',
  mm_mic_gain: 1,
  mm_tab_gain: 1,
};

globalThis.chrome = {
  storage: {
    local: {
      get: vi.fn(async (keys) => {
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((k) => [k, defaultLocal[k]]));
        }
        if (typeof keys === 'string') {
          return { [keys]: defaultLocal[keys] };
        }
        return { ...defaultLocal };
      }),
      set: vi.fn(async () => {}),
    },
    session: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
    onChanged: {
      addListener: vi.fn(),
    },
  },
  runtime: {
    sendMessage: vi.fn(async () => ({ ok: true })),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    getContexts: vi.fn(async () => []),
    lastError: undefined,
  },
  tabs: {
    sendMessage: vi.fn(async () => ({ ok: true })),
    query: vi.fn(async () => []),
    update: vi.fn(async () => {}),
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  },
  alarms: {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => true),
    get: vi.fn(async () => null),
    onAlarm: { addListener: vi.fn() },
  },
  offscreen: {
    createDocument: vi.fn(async () => {}),
    closeDocument: vi.fn(async () => {}),
  },
  tabCapture: {
    getMediaStreamId: vi.fn((opts, cb) => cb('stream-id')),
  },
};

// ----- fetch stub -----------------------------------------------------------
//
// Each test that exercises network-touching code overrides this with
// vi.mocked(fetch).mockResolvedValueOnce(...). Default behaviour is "fail"
// so a forgotten override doesn't accidentally hit the real network.

globalThis.fetch = vi.fn(async () => {
  throw new Error('fetch not mocked in this test');
});

// ----- AudioContext stub ----------------------------------------------------

class FakeGain {
  constructor() {
    this.gain = { value: 1 };
  }
  connect(next) {
    return next;
  }
  disconnect() {}
}

class FakeAudioNode {
  connect(next) {
    return next;
  }
  disconnect() {}
}

class FakeMSDestination {
  constructor() {
    this.stream = {
      getAudioTracks: () => [{ id: 'mixed-audio', kind: 'audio' }],
    };
  }
}

class FakeAnalyser {
  constructor() {
    this.fftSize = 256;
    this.frequencyBinCount = 128;
  }
  connect(next) {
    return next;
  }
  disconnect() {}
  // Returns silence (all 128) so RMS computes to 0. Tests that exercise
  // getLevels() can override this on the mixer's analyser instance.
  getByteTimeDomainData(buf) {
    buf.fill(128);
  }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
  }
  createMediaStreamSource() {
    return new FakeAudioNode();
  }
  createGain() {
    return new FakeGain();
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  createMediaStreamDestination() {
    return new FakeMSDestination();
  }
  async close() {
    this.state = 'closed';
  }
}

globalThis.AudioContext = FakeAudioContext;

// ----- FormData / performance shims ----------------------------------------
//
// happy-dom's FormData.append type-checks its second argument against
// happy-dom's own Blob class. Blobs round-tripped through fake-indexeddb
// don't satisfy that check, so uploads in drain tests would explode
// before reaching the (mocked) fetch. The drain pump's contract here is
// "construct multipart, then fetch" — our tests only care about fetch
// call count, so a permissive stub is sufficient.

class StubFormData {
  constructor() {
    this._entries = [];
  }
  append(name, value, filename) {
    this._entries.push({ name, value, filename });
  }
  get(name) {
    const e = this._entries.find((x) => x.name === name);
    return e ? e.value : null;
  }
  getAll(name) {
    return this._entries.filter((x) => x.name === name).map((x) => x.value);
  }
  has(name) {
    return this._entries.some((x) => x.name === name);
  }
}
globalThis.FormData = StubFormData;

// Sinon fake-timers (which Vitest uses) mocks Date.now under fake timers,
// but happy-dom's performance object exposes its own .now() that the
// mock can't reach. Pin performance.now to Date.now so SELECTORS_BROKEN_MS
// timing tests advance correctly.
Object.defineProperty(globalThis.performance, 'now', {
  value: () => Date.now(),
  configurable: true,
  writable: true,
});

// ----- per-test reset -------------------------------------------------------

beforeEach(() => {
  vi.mocked(fetch).mockReset();
  vi.mocked(fetch).mockImplementation(async () => {
    throw new Error('fetch not mocked in this test');
  });
});

afterEach(() => {
  vi.useRealTimers();
});
