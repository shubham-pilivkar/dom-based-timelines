import { describe, expect, it, vi } from 'vitest';
import { bufferTelemetry, flushTelemetry } from '../src/api/telemetry-buffer.js';

describe('flushTelemetry', () => {
  it('treats 404 as endpoint-not-deployed and retains all buffered events', async () => {
    await bufferTelemetry('selectors_broken', { source: 'google_meet' }, Date.now());
    await bufferTelemetry('monitor_blocked', { reason: 'autoplay' }, Date.now());

    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 });
    const result = await flushTelemetry();
    expect(result.flushed).toBe(0);
    expect(result.buffered).toBeGreaterThanOrEqual(2);

    // Once endpoint goes live, the next flush sweeps the backlog.
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 202 });
    const result2 = await flushTelemetry();
    expect(result2.flushed).toBeGreaterThanOrEqual(2);
  });

  it('treats 501 the same as 404', async () => {
    await bufferTelemetry('orphan_recovered', {}, Date.now());
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 501 });
    const result = await flushTelemetry();
    expect(result.flushed).toBe(0);
    expect(result.buffered).toBeGreaterThanOrEqual(1);
  });

  it('bails on a transient 5xx and leaves remaining events queued', async () => {
    await bufferTelemetry('chunk_retry_max_backoff', { meetingId: 'm-1' }, Date.now());
    await bufferTelemetry('chunk_retry_max_backoff', { meetingId: 'm-2' }, Date.now());
    // First call succeeds, second fails 502 — flush should bail after success.
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 202 })
      .mockResolvedValue({ ok: false, status: 502 });
    const result = await flushTelemetry();
    expect(result.flushed).toBe(1);
    expect(result.buffered).toBeGreaterThanOrEqual(1);
  });
});
