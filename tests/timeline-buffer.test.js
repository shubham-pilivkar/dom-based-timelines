import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { bufferEvent, flushTimeline } from '../src/api/timeline-buffer.js';
import { TIMELINE_BUFFER_MAX } from '../src/constants.js';

describe('flushTimeline', () => {
  it('treats 404 as "endpoint not deployed yet" and retains buffered events', async () => {
    const meetingId = `m-${Math.random().toString(36).slice(2)}`;
    await bufferEvent(meetingId, { speaker_name: 'A', start_time: 0, end_time: 1 });
    await bufferEvent(meetingId, { speaker_name: 'B', start_time: 1, end_time: 2 });

    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 });

    const result = await flushTimeline(meetingId);
    expect(result).toEqual({ flushed: 0, buffered: 2 });

    // Events stay in the store — proven by a successful flush that ships them all.
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 });
    const result2 = await flushTimeline(meetingId);
    expect(result2).toEqual({ flushed: 2, buffered: 0 });

    // After a successful flush the store is empty.
    const result3 = await flushTimeline(meetingId);
    expect(result3).toEqual({ flushed: 0, buffered: 0 });
  });

  it('treats 501 the same as 404 (endpoint missing)', async () => {
    const meetingId = `m-${Math.random().toString(36).slice(2)}`;
    await bufferEvent(meetingId, { speaker_name: 'A', start_time: 0, end_time: 1 });

    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 501 });

    const result = await flushTimeline(meetingId);
    expect(result).toEqual({ flushed: 0, buffered: 1 });
  });

  it('retains events on transient (5xx) failures', async () => {
    const meetingId = `m-${Math.random().toString(36).slice(2)}`;
    await bufferEvent(meetingId, { speaker_name: 'A', start_time: 0, end_time: 1 });

    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 502 });
    const result = await flushTimeline(meetingId);
    expect(result).toEqual({ flushed: 0, buffered: 1 });
  });
});

// Fix 4 — the buffer must be bounded so a long meeting against a
// backend that 404s /timeline can't grow IDB without limit. The FIFO
// eviction is byte-identical to the well-tested telemetry buffer
// (count → openCursor → delete oldest), so — like telemetry's own
// suite — we pin the wiring by source contract rather than doing
// thousands of slow IDB inserts to cross the cap.
describe('Fix 4 — bounded timeline buffer', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    resolve(here, '../src/api/timeline-buffer.js'),
    'utf8',
  );

  it('exports a sane cap (large enough for a long meeting, small on disk)', () => {
    expect(TIMELINE_BUFFER_MAX).toBeGreaterThanOrEqual(1000);
    expect(TIMELINE_BUFFER_MAX).toBeLessThanOrEqual(50_000);
  });

  it('bufferEvent counts then FIFO-evicts the oldest when at capacity', () => {
    const fnIdx = src.indexOf('export async function bufferEvent(');
    const fn = src.slice(fnIdx, src.indexOf('async function listEvents('));
    expect(fn).toMatch(/\.count\(\)/);
    expect(fn).toMatch(/if \(count >= TIMELINE_BUFFER_MAX\)/);
    expect(fn).toMatch(/openCursor\(\)/);
    expect(fn).toMatch(/cursor\.delete\(\)/);
    // …and still performs the add after trimming.
    expect(fn).toMatch(/\.add\(\{ meetingId/);
  });
});
