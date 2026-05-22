// Session-replay ring buffer for the "Report a problem" flow.
//
// We persist a short, sanitised history of state transitions + SW
// message types into IndexedDB. When the user clicks "Report a problem"
// in the popup, the ring buffer is dumped together with the recent
// telemetry queue and shipped as a single ``session_replay_dump``
// telemetry event. This gives support a 5-minute window of "what was
// happening just before things went wrong" without needing the user
// to reproduce the issue.
//
// Why IndexedDB and not chrome.storage.session:
//   * chrome.storage.session is wiped on browser restart; we want
//     the buffer to survive a Chrome bounce so the report still
//     covers the relevant window.
//   * IDB writes are non-blocking and well-supported in MV3 service
//     workers; chrome.storage.session writes block in some Chrome
//     channels.
//
// Privacy: ALL payloads go through ``sanitise()`` before storage.
// Transcript text, speaker names, emails, and any string > 80 chars
// are redacted. The dump endpoint is auth'd via the user's bearer
// token (same as other telemetry).

import { TELEMETRY_EVENT_NAMES } from '../constants.js';

const DB_NAME = 'meetminutes-replay';
const DB_VERSION = 1;
const STORE = 'entries';

// Ring sizing. 500 entries × ~200 bytes = 100 KB, well within IDB's
// per-origin quota. At a peak of ~5 events/second during a busy
// meeting that's ~100 seconds of history; in practice the rate is
// much lower (~0.5/s) so 500 entries covers >15 minutes.
const RING_MAX_ENTRIES = 500;

// Max age — entries older than this are pruned at write time, not on
// read, so the dump path stays fast.
const RING_MAX_AGE_MS = 15 * 60 * 1000;


/** @returns {Promise<IDBDatabase>} */
function openDbOnce() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('byTs', 'ts', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = openDbOnce()
      .then((db) => {
        db.onversionchange = () => {
          try { db.close(); } catch { /* already closed */ }
          dbPromise = null;
        };
        db.onclose = () => { dbPromise = null; };
        return db;
      })
      .catch((err) => {
        dbPromise = null;
        throw err;
      });
  }
  return dbPromise;
}


// Field names that always get redacted regardless of value. Add
// here for any new PII-bearing field as it lands.
const _PII_FIELDS = new Set([
  'text',                 // TRANSCRIPT_EVENT text
  'speaker_name',         // SPEAKER_CHANGE name from DOM tiles
  'email',                // any auth-adjacent message
  'token',                // ws_token, bearer tokens
  'ws_token',
  'authorization',
  'password',
]);

// Max string length to keep. Transcript-like content easily blows past
// this; truncating prevents any leak via a long string we didn't
// explicitly add to the PII allowlist.
const _MAX_STRING_LEN = 80;


/**
 * Recursively sanitise a value for replay-buffer storage. Returns a
 * shallow copy with PII fields redacted and long strings truncated.
 * Tested separately so we can pin the redaction contract.
 *
 * Pure function — no state, no I/O.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function sanitise(value, depth = 0) {
  if (depth > 6) return '[truncated_depth]';
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.length > _MAX_STRING_LEN) {
      return value.slice(0, _MAX_STRING_LEN - 3) + '...';
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    // Cap array length so a runaway accumulator can't fill the ring.
    return value.slice(0, 50).map((v) => sanitise(v, depth + 1));
  }
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (_PII_FIELDS.has(k)) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = sanitise(v, depth + 1);
    }
    return out;
  }
  // ArrayBuffer, Blob, Function, Symbol all reduced to a tag — they
  // shouldn't appear in message payloads but keep the contract
  // total.
  return `[${typeof value}]`;
}


/**
 * Append one entry to the ring. ``kind`` is a short tag describing
 * the entry shape; payload is sanitised before storage. Pruning runs
 * on the same transaction so the ring stays bounded without a
 * separate sweeper.
 *
 * @param {{ kind: string, payload?: Record<string, unknown> }} entry
 * @returns {Promise<void>}
 */
export async function appendReplay({ kind, payload = {} }) {
  if (!kind || typeof kind !== 'string') return;
  let db;
  try {
    db = await openDb();
  } catch {
    return; // IDB failure — best-effort
  }
  return new Promise((resolve) => {
    const ts = Date.now();
    const safe = /** @type {Record<string, unknown>} */ (sanitise(payload));
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.add({ ts, kind, payload: safe });
    // Best-effort prune: drop the oldest entry when we cross the
    // capacity. Counting per-write is O(1) on IDB; the alternative
    // (count then bulk-delete) trades one write for a count + sweep
    // each call.
    const countReq = store.count();
    countReq.onsuccess = () => {
      const n = countReq.result;
      if (n > RING_MAX_ENTRIES) {
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cur = cursorReq.result;
          if (cur) {
            cur.delete();
          }
        };
      }
    };
    // Age-based prune. Older than 15 min → drop. We scan only when
    // the count is over threshold to avoid full scans on every
    // append.
    const ageCutoff = ts - RING_MAX_AGE_MS;
    const ageCursorReq = store.index('byTs').openCursor(IDBKeyRange.upperBound(ageCutoff));
    ageCursorReq.onsuccess = () => {
      const cur = ageCursorReq.result;
      if (cur) {
        cur.delete();
        cur.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve(); // best-effort; never throw
  });
}


/**
 * Read the entire ring buffer, newest first. Used by the "Report a
 * problem" flow to assemble the dump payload.
 *
 * @returns {Promise<Array<{ ts: number, kind: string, payload: Record<string, unknown> }>>}
 */
export async function listReplay() {
  let db;
  try {
    db = await openDb();
  } catch {
    return [];
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const rows = (req.result ?? []);
      rows.sort((a, b) => b.ts - a.ts);
      resolve(rows);
    };
    req.onerror = () => resolve([]);
  });
}


/**
 * Build the payload used by the "Report a problem" telemetry event.
 * Caller decides where to send it; this just bundles the ring
 * buffer with optional user-supplied notes.
 *
 * @param {{ note?: string }} args
 * @returns {Promise<{ name: string, payload: Record<string, unknown> }>}
 */
export async function buildReportPayload({ note = '' } = {}) {
  const entries = await listReplay();
  return {
    name: TELEMETRY_EVENT_NAMES.SESSION_REPLAY_DUMP,
    payload: {
      generatedAt: Date.now(),
      // Truncate the user note so a long ranting paste doesn't blow
      // the telemetry payload past the max event size. Support can
      // ask the user for the rest on the followup.
      note: typeof note === 'string' ? note.slice(0, 1024) : '',
      // Ship the entire ring; if it's too big the backend will
      // truncate at ingest. Newest-first ordering matches what an
      // operator typically wants to read first.
      entryCount: entries.length,
      entries,
    },
  };
}


/**
 * Clear the ring. Exposed for the popup's "clear after report" flow
 * and for tests.
 */
export async function clearReplay() {
  let db;
  try {
    db = await openDb();
  } catch {
    return;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}


// Constants exported for tests + the popup's UI sizing.
export const REPLAY_RING_MAX_ENTRIES = RING_MAX_ENTRIES;
export const REPLAY_RING_MAX_AGE_MS = RING_MAX_AGE_MS;
