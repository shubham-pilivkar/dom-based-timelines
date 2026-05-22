import { TIMELINE_BUFFER_MAX, TIMELINE_FLUSH_MS } from '../constants.js';
import { AuthError, postTimeline } from './client.js';

// Speaker timeline events accumulate in IndexedDB and are flushed every
// TIMELINE_FLUSH_MS, plus once on meeting finalize. The /timeline endpoint
// does not exist on the backend yet — 404/501 responses must NOT raise an
// error to the user; we just keep buffering and replay later.

const DB_NAME = 'meetminutes-timeline';
const STORE = 'events';

/** @returns {Promise<IDBDatabase>} */
function openDbOnce() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('byMeeting', 'meetingId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// See client.js for the cache rationale.
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
 * @param {string} meetingId
 * @param {{ speaker_name: string, start_time: number, end_time: number }} event
 */
export async function bufferEvent(meetingId, event) {
  const db = await openDb();
  // Bound the store: if at capacity, FIFO-evict the oldest event before
  // writing. A long meeting against a backend that 404s /timeline would
  // otherwise grow this every speaker turn for hours. autoIncrement
  // keys are monotonic, so the first cursor entry is the oldest. Mirror
  // of bufferTelemetry's trim. (Eviction only matters in the degraded
  // endpoint-missing path; normal flushes keep the store near-empty.)
  const count = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (count >= TIMELINE_BUFFER_MAX) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const cursorReq = tx.objectStore(STORE).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) cursor.delete(); // oldest by insertion order
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add({ meetingId, ...event, createdAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** @param {string} meetingId */
async function listEvents(meetingId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('byMeeting');
    const req = idx.getAll(meetingId);
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

/** @param {number[]} ids */
async function deleteEvents(ids) {
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
 * Try to push every buffered event for a meeting. Treats endpoint-missing
 * (404/501) as "keep buffering" and returns silently. Auth failure is
 * propagated so the SW can transition to NEEDS_REAUTH.
 *
 * @param {string} meetingId
 */
export async function flushTimeline(meetingId) {
  const events = await listEvents(meetingId);
  if (events.length === 0) return { flushed: 0, buffered: 0 };
  try {
    const payload = events.map(({ speaker_name, start_time, end_time }) => ({
      speaker_name,
      start_time,
      end_time,
    }));
    await postTimeline(meetingId, payload);
    await deleteEvents(events.map((e) => e.id));
    return { flushed: events.length, buffered: 0 };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('timeline_unimplemented_')) {
      // Backend hasn't shipped the timeline endpoint yet — keep
      // events buffered locally; the next periodic flush retries.
      // No console output: 404/501 are an expected state on older
      // backends, not an error worth surfacing in the devtools log
      // for end users.
      return { flushed: 0, buffered: events.length };
    }
    console.warn('[timeline] flush failed; will retry', err);
    return { flushed: 0, buffered: events.length };
  }
}

/**
 * Start a periodic flusher. Returns a stop function.
 * @param {() => string | null} getActiveMeetingId
 * @param {(err: unknown) => void} onAuthLost
 */
export function startTimelineFlusher(getActiveMeetingId, onAuthLost) {
  const tick = async () => {
    const id = getActiveMeetingId();
    if (!id) return;
    try {
      await flushTimeline(id);
    } catch (err) {
      onAuthLost(err);
    }
  };
  const handle = setInterval(tick, TIMELINE_FLUSH_MS);
  return () => clearInterval(handle);
}
