// Phase F v1 — client-side encryption (Option A: encryption at rest).
//
// Goals + non-goals:
//
//   IN scope for v1:
//     * Random per-user master key, stored as a non-extractable
//       ``CryptoKey`` in IndexedDB. Generated once on first use of
//       encryption; persisted across SW restarts via the standard
//       Web Crypto + IDB key persistence model.
//     * Random per-meeting key (AES-256-GCM), generated at recording
//       start and wrapped with the master key for upload to the
//       backend (so a future server-side decryption pipeline can
//       reconstruct it without ever seeing plaintext audio in
//       transit).
//     * Per-chunk AES-GCM with a fresh random 96-bit IV. The IV is
//       prepended to the ciphertext so each chunk is a self-contained
//       opaque blob the backend can store as-is.
//
//   OUT of scope for v1 (deferred to F v2):
//     * PBKDF2 from a user password (recovery + multi-device sync
//       hinge on this; doing it right needs the auth flow to change
//       so the user is prompted for a password on each fresh device).
//     * Backend transcription / playback of encrypted meetings —
//       requires the backend worker to fetch the wrapped key and
//       unwrap it. We mark encrypted meetings so the worker skips
//       them in v1; explicit limitation documented to users.
//     * Per-meeting toggle. v1 is a whole-account flag — the
//       ``mm_e2ee_enabled`` storage key controls all recordings.
//
// Why Web Crypto and not WASM Argon2 / libsodium:
//   Web Crypto's AES-GCM is hardware-accelerated on every Chrome
//   target we ship to and is the standard surface for non-extractable
//   keys. WASM adds bundle weight + a non-zero attack surface for the
//   crypto module itself.

const DB_NAME = 'meetminutes-keys';
const STORE = 'cryptokeys';
const MASTER_KEY_ID = 'master';

// AES-GCM IV: 96 bits (12 bytes) is the spec-recommended size; longer
// IVs trigger GHASH normalization which costs cycles and offers no
// security benefit when IVs are random.
const IV_BYTES = 12;
// AES-256 master + meeting keys. Overkill for the threat model but
// aligns with what most cloud-provider encryption-at-rest products
// advertise, so audit conversations go smoothly.
const KEY_BITS = 256;


/** @returns {Promise<IDBDatabase>} */
function openDbOnce() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
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


async function readKeyFromIdb(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result?.key ?? null);
    req.onerror = () => reject(req.error);
  });
}


async function writeKeyToIdb(id, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ id, key });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}


/**
 * Fetch the per-user master key, generating it on first call.
 *
 * The master key is created as **non-extractable** so even an
 * attacker with full extension code access can't read its raw bytes
 * out of the browser. IndexedDB stores ``CryptoKey`` objects directly
 * (per the Web Crypto spec); we lean on that instead of round-tripping
 * to / from raw bytes.
 *
 * @returns {Promise<CryptoKey>}
 */
export async function getOrCreateMasterKey() {
  const existing = await readKeyFromIdb(MASTER_KEY_ID);
  if (existing) return existing;
  const fresh = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: KEY_BITS },
    /* extractable */ false,
    // The master key is only ever used to wrap / unwrap meeting
    // keys, never for direct chunk encryption.
    ['wrapKey', 'unwrapKey'],
  );
  await writeKeyToIdb(MASTER_KEY_ID, fresh);
  return fresh;
}


/**
 * Generate a fresh per-meeting AES-256-GCM key.
 *
 * This one IS extractable — the SW needs to wrap it with the master
 * key for upload to the backend, which requires reading the raw bytes
 * via ``wrapKey``. The extracted bytes never leave the SW in plaintext;
 * the wrap step encrypts them before the upload.
 *
 * @returns {Promise<CryptoKey>}
 */
export async function generateMeetingKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: KEY_BITS },
    /* extractable */ true,
    ['encrypt', 'decrypt'],
  );
}


/**
 * Wrap a meeting key with the master key. Returns an opaque blob the
 * caller ships to the backend.
 *
 * Layout: ``[12-byte IV][wrapped key bytes (incl. AES-GCM auth tag)]``.
 * The IV is random per wrap so the same meeting key wrapped twice
 * still produces distinct ciphertexts (defence in depth — IDB and
 * the backend should never share a ciphertext between sessions, but
 * we don't rely on that).
 *
 * @param {CryptoKey} meetingKey
 * @param {CryptoKey} masterKey
 * @returns {Promise<Uint8Array>}
 */
export async function wrapMeetingKey(meetingKey, masterKey) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = await crypto.subtle.wrapKey(
    'raw',
    meetingKey,
    masterKey,
    { name: 'AES-GCM', iv },
  );
  const out = new Uint8Array(iv.byteLength + wrapped.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(wrapped), iv.byteLength);
  return out;
}


/**
 * Unwrap a wrapped meeting key. Symmetric to ``wrapMeetingKey``.
 * Used by playback / decryption flows; not on the recording hot path.
 *
 * @param {Uint8Array} wrappedBytes
 * @param {CryptoKey} masterKey
 * @returns {Promise<CryptoKey>}
 */
export async function unwrapMeetingKey(wrappedBytes, masterKey) {
  if (wrappedBytes.byteLength <= IV_BYTES) {
    throw new Error('wrapped_key_too_short');
  }
  const iv = wrappedBytes.subarray(0, IV_BYTES);
  const ciphertext = wrappedBytes.subarray(IV_BYTES);
  return crypto.subtle.unwrapKey(
    'raw',
    ciphertext,
    masterKey,
    { name: 'AES-GCM', iv },
    { name: 'AES-GCM', length: KEY_BITS },
    /* extractable */ true,
    ['encrypt', 'decrypt'],
  );
}


/**
 * Encrypt a single chunk blob. Returns a new Blob whose bytes are
 * ``[12-byte IV][ciphertext (incl. 16-byte auth tag)]``. The caller
 * uploads it to the backend as-is; the backend never decrypts.
 *
 * Each call gets a fresh random IV — required for AES-GCM security
 * (reusing an IV with the same key fatally breaks confidentiality).
 *
 * @param {Blob} blob
 * @param {CryptoKey} meetingKey
 * @returns {Promise<Blob>}
 */
export async function encryptChunk(blob, meetingKey) {
  const plaintext = new Uint8Array(await blob.arrayBuffer());
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    meetingKey,
    plaintext,
  );
  const out = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), iv.byteLength);
  // ``application/octet-stream`` is the honest type — the backend
  // doesn't know what's inside. The original mime is still carried
  // in the form field for post-decryption playback.
  return new Blob([out], { type: 'application/octet-stream' });
}


/**
 * Decrypt a chunk produced by ``encryptChunk``. Strips the IV prefix
 * and runs AES-GCM. Returns a plain Blob. Used by playback / future
 * server-side decryption tools.
 *
 * @param {Blob | ArrayBuffer | Uint8Array} input
 * @param {CryptoKey} meetingKey
 * @param {string} [mimeType] — original mime to set on the decrypted blob
 * @returns {Promise<Blob>}
 */
export async function decryptChunk(input, meetingKey, mimeType = 'application/octet-stream') {
  let bytes;
  if (input instanceof Blob) {
    bytes = new Uint8Array(await input.arrayBuffer());
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    bytes = new Uint8Array(input);
  }
  if (bytes.byteLength <= IV_BYTES) {
    throw new Error('encrypted_chunk_too_short');
  }
  const iv = bytes.subarray(0, IV_BYTES);
  const ciphertext = bytes.subarray(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    meetingKey,
    ciphertext,
  );
  return new Blob([plaintext], { type: mimeType });
}


// Public constants exported for tests.
export const E2EE_IV_BYTES = IV_BYTES;
export const E2EE_KEY_BITS = KEY_BITS;
