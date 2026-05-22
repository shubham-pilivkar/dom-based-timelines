// P1 backend-alignment: W4 idempotent create, W2 finalize-409
// recovery, W3 recording-status polling.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  startMeeting,
  finalizeMeeting,
  FinalizeConflictError,
  getRecordingStatus,
} from '../src/api/client.js';

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.mocked(fetch).mockReset();
});

describe('W4 — idempotent create', () => {
  it('sends a client-minted recording_id in the create body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonRes(201, { recording_id: 'srv', status: 'recording', upload_url: '/u' }),
    );
    await startMeeting({ name: 'M' });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(typeof body.recording_id).toBe('string');
    expect(body.recording_id.length).toBeGreaterThan(8);
    expect(body.client_started_at).toBeTruthy();
  });

  it('reuses the SAME recording_id across an internal 5xx retry', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonRes(500, {}))
      .mockResolvedValueOnce(
        jsonRes(200, { recording_id: 'x', status: 'recording', upload_url: '/u' }),
      );
    await startMeeting({ name: 'M' });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBe(2);
    const id1 = JSON.parse(calls[0][1].body).recording_id;
    const id2 = JSON.parse(calls[1][1].body).recording_id;
    expect(id1).toBe(id2); // same recording → server dedupes, no duplicate
  }, 10_000);

  it('honours an explicit recordingId (cross-restart idempotency)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonRes(200, { recording_id: 'pre', status: 'recording', upload_url: '/u' }),
    );
    await startMeeting({ name: 'M', recordingId: 'pre-minted-id' });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.recording_id).toBe('pre-minted-id');
  });
});

describe('W2 — finalize 409/422 classification', () => {
  it('202 accepted resolves', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonRes(202, { status: 'finalizing' }));
    await expect(finalizeMeeting('m')).resolves.toBeUndefined();
  });

  it('409 with missing[] → recoverable FinalizeConflictError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonRes(409, { detail: 'missing chunks', missing: [3, 7] }),
    );
    const err = await finalizeMeeting('m').catch((e) => e);
    expect(err).toBeInstanceOf(FinalizeConflictError);
    expect(err.terminal).toBe(false);
    expect(err.missing).toEqual([3, 7]);
  });

  it('409 no-chunks (no missing[]) → terminal', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonRes(409, { detail: 'no chunks uploaded' }),
    );
    const err = await finalizeMeeting('m').catch((e) => e);
    expect(err).toBeInstanceOf(FinalizeConflictError);
    expect(err.terminal).toBe(true);
  });

  it('422 count-disagreement → terminal', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonRes(422, { detail: 'declared count disagrees' }),
    );
    const err = await finalizeMeeting('m').catch((e) => e);
    expect(err).toBeInstanceOf(FinalizeConflictError);
    expect(err.terminal).toBe(true);
  });

  it('5xx → generic retryable error (not a conflict)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonRes(503, {}));
    const err = await finalizeMeeting('m').catch((e) => e);
    expect(err).not.toBeInstanceOf(FinalizeConflictError);
    expect(String(err.message)).toContain('finalize_failed_503');
  });
});

describe('W3 — recording status', () => {
  it('GETs /status and returns the parsed envelope', async () => {
    const env = {
      status: 'failed', uploaded_chunks: 2, expected_chunks: 3,
      final_url: null, playlist_url: null,
      error: 'stitch failed', error_code: 'STITCH_TIMEOUT',
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonRes(200, env));
    const got = await getRecordingStatus('mid');
    expect(got).toEqual(env);
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain(
      '/api/v1/recordings/mid/status',
    );
  });

  it('non-ok status throws', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonRes(404, {}));
    await expect(getRecordingStatus('x')).rejects.toThrow('status_failed_404');
  });
});
