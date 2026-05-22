// P5 — extension-side duration-cap plumbing.
//
// Two surfaces under test:
//   * parseDurationCap — tolerant of missing/garbage fields so the
//     popup UX defaults to "no cap" instead of crashing.
//   * drainChunkQueue — recognises the backend's 403 structured body
//     and routes through ``onCapExceeded`` (not the generic poison-
//     chunk drop / retry-backoff path). The private ``uploadChunkOnce``
//     isn't exported; the drain is the user-visible boundary anyway.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  RecordingDurationExceededError,
  drainChunkQueue,
  listPendingChunks,
  parseDurationCap,
  persistChunk,
} from '../src/api/client.js';

async function seedChunk(meetingId, chunkIndex) {
  await persistChunk({
    meetingId,
    chunkIndex,
    blob: new Blob(['x'], { type: 'video/webm' }),
    isFinal: false,
    idempotencyKey: `idem-${meetingId}-${chunkIndex}`,
    mimeType: 'video/webm',
  });
}

async function clearChunks(meetingId) {
  // Use the same code path the drain does so the test doesn't have
  // to know the underlying IDB schema. Drain-on-empty is a no-op so
  // this works even when there's nothing to delete.
  const pending = await listPendingChunks(meetingId);
  // No public delete API, but the drain's poison-drop path will clear
  // a row when it 4xx's. For test cleanup, re-open the DB.
  if (pending.length === 0) return;
  const req = indexedDB.open('meetminutes-chunks', 3);
  const db = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    const idx = tx.objectStore('pending').index('byMeeting');
    const cursorReq = idx.openCursor(IDBKeyRange.only(meetingId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function capRejectResponse({ status = 403, body }) {
  // `Response.clone().json()` is what the parser uses; emulate by
  // returning fresh `.json` thunks on each clone() so neither the
  // 403 sniff nor the generic 4xx path runs out of a consumed body.
  const json = async () => body;
  const text = async () => JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json,
    text,
    clone() {
      return { json, text };
    },
  };
}

beforeEach(() => {
  vi.mocked(fetch).mockReset();
});

afterEach(async () => {
  await clearChunks('rid-cap');
  await clearChunks('rid-other');
});


// ----------------------------------------------------- parseDurationCap
describe('parseDurationCap', () => {
  it('parses a full response shape', () => {
    expect(parseDurationCap({
      max_duration_seconds: 10800,
      consumed_seconds: 7200,
      warning_at_seconds_remaining: 300,
    })).toEqual({
      maxDurationSeconds: 10800,
      consumedSeconds: 7200,
      warningAtSecondsRemaining: 300,
    });
  });

  it('falls back to 0/0/0 when cap fields are absent', () => {
    expect(parseDurationCap({
      recording_id: 'abc',
    })).toEqual({
      maxDurationSeconds: 0,
      consumedSeconds: 0,
      warningAtSecondsRemaining: 0,
    });
  });

  it('clamps negatives + tolerates bad types', () => {
    expect(parseDurationCap({
      max_duration_seconds: -100,
      consumed_seconds: 'a-string',
      warning_at_seconds_remaining: null,
    })).toEqual({
      maxDurationSeconds: 0,
      consumedSeconds: 0,
      warningAtSecondsRemaining: 0,
    });
  });

  it('handles non-object body', () => {
    expect(parseDurationCap(null)).toEqual({
      maxDurationSeconds: 0,
      consumedSeconds: 0,
      warningAtSecondsRemaining: 0,
    });
    expect(parseDurationCap('lots')).toEqual({
      maxDurationSeconds: 0,
      consumedSeconds: 0,
      warningAtSecondsRemaining: 0,
    });
  });
});


// --------------------------------------------------- drain routing
describe('drainChunkQueue — onCapExceeded routing', () => {
  it('invokes onCapExceeded with the cap details and stops the drain', async () => {
    await seedChunk('rid-cap', 0);
    vi.mocked(fetch).mockResolvedValueOnce(capRejectResponse({
      status: 403,
      body: {
        error_code: 'recording_duration_exceeded',
        cap_seconds: 60,
        consumed_seconds: 60,
        grace_seconds: 5,
      },
    }));

    const onCapExceeded = vi.fn().mockResolvedValue(undefined);
    const onAuthLost = vi.fn();
    await drainChunkQueue({
      meetingId: 'rid-cap',
      shouldContinue: () => true,
      onCapExceeded,
      onAuthLost,
    });

    expect(onCapExceeded).toHaveBeenCalledTimes(1);
    expect(onCapExceeded).toHaveBeenCalledWith({
      capSeconds: 60,
      consumedSeconds: 60,
    });
    expect(onAuthLost).not.toHaveBeenCalled();
    // Drain must have exited (not retried) — only the single 403
    // fetch in the queue.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT invoke onCapExceeded on a non-cap 403', async () => {
    // A 403 from another cause (permission_denied) must NOT be coerced
    // into the cap path. The drain treats it as a transient (not in
    // the poison-status set {400,413,415,422}) and would retry — we
    // gate it with a one-shot ``shouldContinue`` to prevent retries
    // from spinning forever inside the test.
    await seedChunk('rid-other', 0);
    vi.mocked(fetch).mockResolvedValue(capRejectResponse({
      status: 403,
      body: { error_code: 'permission_denied', message: 'nope' },
    }));

    let calls = 0;
    const onCapExceeded = vi.fn();
    await drainChunkQueue({
      meetingId: 'rid-other',
      shouldContinue: () => (calls += 1) <= 1,
      onCapExceeded,
    });

    expect(onCapExceeded).not.toHaveBeenCalled();
  });
});


// ------------------------------------- RecordingDurationExceededError shape
describe('RecordingDurationExceededError', () => {
  it('carries cap fields as plain numbers', () => {
    const err = new RecordingDurationExceededError({
      capSeconds: 10800,
      consumedSeconds: 10800,
      graceSeconds: 30,
      message: 'over',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RecordingDurationExceededError');
    expect(err.capSeconds).toBe(10800);
    expect(err.consumedSeconds).toBe(10800);
    expect(err.graceSeconds).toBe(30);
    expect(err.message).toBe('over');
  });
});
