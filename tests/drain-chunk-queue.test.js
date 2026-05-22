import { describe, expect, it, vi } from 'vitest';
import { drainChunkQueue, persistChunk } from '../src/api/client.js';

// IndexedDB is provided by fake-indexeddb (loaded in setup.js).

function makeBlob(content) {
  return new Blob([content], { type: 'video/webm' });
}

describe('drainChunkQueue', () => {
  it('uploads chunks in order and drains the queue', async () => {
    const meetingId = `m-${Math.random().toString(36).slice(2)}`;
    await persistChunk({ meetingId, chunkIndex: 0, isFinal: false, blob: makeBlob('a') });
    await persistChunk({ meetingId, chunkIndex: 1, isFinal: true, blob: makeBlob('b') });

    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 });

    await drainChunkQueue({
      meetingId,
      shouldContinue: () => true,
      onProgress: () => {},
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const seen = vi.mocked(fetch).mock.calls.map((c) => c[0]);
    // Unified API (backend REFACTOR-2): chunk index is a path segment
    // under /api/v1/recordings/{id}/chunks/{idx} (was
    // /api/v1/meetings/{id}/chunks with chunk_index in the form body).
    expect(seen[0]).toContain(`/recordings/${meetingId}/chunks/0`);
    expect(seen[1]).toContain(`/recordings/${meetingId}/chunks/1`);
    expect(seen[0]).not.toContain('/meetings/');
  });

  it(
    'retries on transient failures with exponential backoff (1s, 2s)',
    async () => {
      // Fake timers + fake-indexeddb don't compose — IDB's internal
      // microtasks freeze. Use real timers; the cumulative sleep here
      // is ~3s which fits comfortably inside the bumped timeout.
      const meetingId = `m-${Math.random().toString(36).slice(2)}`;
      await persistChunk({ meetingId, chunkIndex: 0, isFinal: true, blob: makeBlob('x') });

      vi.mocked(fetch)
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const start = Date.now();
      await drainChunkQueue({
        meetingId,
        shouldContinue: () => true,
        onProgress: () => {},
      });
      const elapsed = Date.now() - start;

      const chunkCalls = vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).includes('/chunks'));
      expect(chunkCalls.length).toBe(3);
      // 1s backoff + 2s backoff = ~3s; allow generous bounds for IDB jitter.
      expect(elapsed).toBeGreaterThanOrEqual(2_500);
      expect(elapsed).toBeLessThan(8_000);
    },
    15_000,
  );

  it('hands control to onAuthLost on 401 and stops draining', async () => {
    const meetingId = `m-${Math.random().toString(36).slice(2)}`;
    await persistChunk({ meetingId, chunkIndex: 0, isFinal: true, blob: makeBlob('x') });

    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 });

    const onAuthLost = vi.fn();
    await drainChunkQueue({
      meetingId,
      shouldContinue: () => true,
      onProgress: () => {},
      onAuthLost,
    });

    expect(onAuthLost).toHaveBeenCalledTimes(1);
    // Only the first chunk attempt — drain bails immediately. Filter
    // out the fire-and-forget /events telemetry call that auth_lost
    // emits.
    const chunkCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).includes('/chunks'));
    expect(chunkCalls.length).toBe(1);
  });
});
