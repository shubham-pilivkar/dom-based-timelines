// P3 / W8 — per-recording lifecycle event log
// (POST /api/v1/recordings/{rid}/events, doc §2.13). Observability
// only: must never throw, never block, swallow every failure.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { postRecordingEvent } from '../src/api/client.js';

beforeEach(() => {
  vi.mocked(fetch).mockReset();
});

describe('W8 — postRecordingEvent', () => {
  it('POSTs to the per-recording events path with the right body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 201 });
    const ok = await postRecordingEvent('rid-1', 'START_RECORDING');
    expect(ok).toBe(true);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/api/v1/recordings/rid-1/events');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.event_type).toBe('START_RECORDING');
    expect(typeof body.event_ts).toBe('string');
    expect(Number.isNaN(Date.parse(body.event_ts))).toBe(false);
    expect('event_id' in body).toBe(false);
  });

  it('includes + caps event_id and caps event_type length', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 201 });
    await postRecordingEvent('rid', 'X'.repeat(100), {
      eventId: 'y'.repeat(400),
      eventTs: '2026-05-19T14:00:01Z',
    });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.event_type.length).toBe(64);
    expect(body.event_id.length).toBe(256);
    expect(body.event_ts).toBe('2026-05-19T14:00:01Z');
  });

  it('returns false (no throw) on a 404 unknown recording', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(postRecordingEvent('gone', 'STOP_RECORDING'))
      .resolves.toBe(false);
  });

  it('swallows a network/auth throw — never rejects', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
    await expect(postRecordingEvent('rid', 'STOP_RECORDING'))
      .resolves.toBe(false);
  });

  it('no-ops (no fetch) when meetingId or eventType is missing', async () => {
    expect(await postRecordingEvent('', 'START_RECORDING')).toBe(false);
    expect(await postRecordingEvent('rid', '')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
