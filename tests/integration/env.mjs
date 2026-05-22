// Integration-harness environment shim.
//
// MUST be imported (side-effecting) BEFORE any src/ module so the
// `chrome.*` + IndexedDB globals exist when client.js runs its
// top-level `chrome.storage.onChanged.addListener(...)`.
//
// Unlike tests/setup.js (which mocks fetch to fail), this shim keeps
// the REAL Node fetch / Blob / FormData / crypto so the imported
// extension code talks to the real backend. Storage is a functional
// in-memory implementation with working onChanged dispatch — that's
// load-bearing: client.js invalidates its config cache via
// storage.onChanged when AUTH_TOKEN changes.

import 'fake-indexeddb/auto';

function makeArea() {
  const data = new Map();
  return {
    _data: data,
    async get(keys) {
      if (keys == null) return Object.fromEntries(data);
      if (typeof keys === 'string') {
        return data.has(keys) ? { [keys]: data.get(keys) } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (data.has(k)) out[k] = data.get(k);
        return out;
      }
      // object form: keys-with-defaults
      const out = {};
      for (const [k, dflt] of Object.entries(keys)) {
        out[k] = data.has(k) ? data.get(k) : dflt;
      }
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        const oldValue = data.get(k);
        data.set(k, v);
        changes[k] = { oldValue, newValue: v };
      }
      dispatch(this._area, changes);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const k of arr) {
        if (data.has(k)) {
          changes[k] = { oldValue: data.get(k), newValue: undefined };
          data.delete(k);
        }
      }
      if (Object.keys(changes).length) dispatch(this._area, changes);
    },
  };
}

const listeners = [];
function dispatch(area, changes) {
  for (const fn of listeners) {
    try { fn(changes, area); } catch { /* listener must not break storage */ }
  }
}

const local = makeArea();
local._area = 'local';
const session = makeArea();
session._area = 'session';

globalThis.chrome = {
  storage: {
    local,
    session,
    onChanged: { addListener: (fn) => listeners.push(fn) },
  },
  runtime: {
    id: 'integration-harness',
    lastError: undefined,
    getURL: (p) => `chrome-extension://integration/${p}`,
    sendMessage: async () => ({ ok: true }),
    onMessage: { addListener() {}, removeListener() {} },
    getContexts: async () => [],
  },
  tabs: {
    sendMessage: async () => ({ ok: true }),
    query: async () => [],
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
  },
  alarms: {
    create: async () => {}, clear: async () => true,
    get: async () => null, onAlarm: { addListener() {} },
  },
};

export { local, session };
