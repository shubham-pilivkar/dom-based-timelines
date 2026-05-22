import { TELEMETRY_BUFFER_MAX, TELEMETRY_FLUSH_MS } from '../constants.js';
import { AuthError, postEvent } from './client.js';

// Persisted telemetry buffer. Events land here from emitEvent() and a
// periodic flusher attempts to ship them. The /api/v1/extension/events
// endpoint may not exist yet (404/501) — those responses are tolerated
// silently and the events stay buffered for replay once the endpoint
// goes live. Same shape as timeline-buffer.js, separate DB so a
// telemetry storm can't impact the chunk drain or vice versa.

const DB_NAME = 'meetminutes-telemetry';
const STORE = 'events';

/** @returns {Promise<IDBDatabase>} */
function openDbOnce() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
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
        db.onclose = () => {
          dbPromise = null;
        };
        return db;
      })
      .catch((err) => {
        dbPromise = null;
        throw err;
      });
  }
  return dbPromise;
}

/**
 * Append an event to the buffer. If the buffer is at capacity, drops
 * the oldest event before writing — telemetry is the lowest-priority
 * traffic in the system and unbounded growth is worse than a few
 * dropped events.
 *
 * @param {string} name
 * @param {Record<string, unknown>} payload
 * @param {number} ts
 */
export async function bufferTelemetry(name, payload, ts) {
  const db = await openDb();
  // First check count and trim if needed.
  const count = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (count >= TELEMETRY_BUFFER_MAX) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          // First entry by insertion order (autoIncrement keys are monotonic).
          cursor.delete();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add({ name, payload, ts });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function listAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteIds(ids) {
  if (ids.length === 0) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Best-effort flush. Sends events one at a time so a single bad payload
 * doesn't lose the rest. On 404/501 (endpoint not deployed) returns
 * silently and leaves events buffered. On AuthError, propagates so the
 * SW can transition to NEEDS_REAUTH.
 */
export async function flushTelemetry() {
  const events = await listAll();
  if (events.length === 0) return { flushed: 0, buffered: 0 };
  const sentIds = [];
  for (const e of events) {
    try {
      await postEvent({ name: e.name, payload: e.payload, ts: e.ts });
      sentIds.push(e.id);
    } catch (err) {
      if (err instanceof AuthError) {
        await deleteIds(sentIds);
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('events_unimplemented_')) {
        // Endpoint not deployed yet — keep buffering all events.
        await deleteIds(sentIds);
        return { flushed: sentIds.length, buffered: events.length - sentIds.length };
      }
      // Other transient failure — bail and try again next interval.
      break;
    }
  }
  await deleteIds(sentIds);
  return { flushed: sentIds.length, buffered: events.length - sentIds.length };
}

/**
 * Start a periodic flusher. Returns a stop function. Runs independently
 * of recording state — buffered events from a previous session can ship
 * any time, even before the user starts a new recording.
 *
 * @param {(err: unknown) => void} onAuthLost
 */
export function startTelemetryFlusher(onAuthLost) {
  const tick = async () => {
    try {
      await flushTelemetry();
    } catch (err) {
      onAuthLost(err);
    }
  };
  // Kick once immediately so a hot SW restart drains any backlog.
  void tick();
  const handle = setInterval(tick, TELEMETRY_FLUSH_MS);
  return () => clearInterval(handle);
}
