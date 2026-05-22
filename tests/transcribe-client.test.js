// Tests for ``api/client.js#startTranscribeSession`` — verifies the
// error-code mapping matches what the popup expects. The 4xx/5xx
// branches are dealbreakers for UX (concurrency cap vs auth expiry
// vs provider unavailable each need different popup affordances).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError, startTranscribeSession, toPublicWsUrl } from '../src/api/client.js';

function mockResponse({ status, body = '', ok }) {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    text: vi.fn(async () => body),
    json: vi.fn(async () => (typeof body === 'string' ? JSON.parse(body) : body)),
  };
}

const HAPPY_BODY = {
  session_id: 'sid-1',
  ws_url: 'wss://api/test/stream?sid=sid-1&token=abc',
  ws_token: 'abc',
  sample_rate: 16000,
  format: 'pcm_s16le_mono',
  provider: 'soniox',
};

afterEach(() => {
  vi.mocked(fetch).mockReset();
  vi.mocked(fetch).mockImplementation(async () => {
    throw new Error('fetch not mocked in this test');
  });
});

describe('startTranscribeSession', () => {
  it('parses success body + normalises ws_url onto the configured host', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 201, body: HAPPY_BODY }),
    );
    const result = await startTranscribeSession({
      mode: 'self',
      language: 'hi-IN',
      provider: 'soniox',
    });
    // setup.js pins mm_api_base_url='http://test.invalid' → ws scheme,
    // host swapped to the configured host; path + query preserved.
    expect(result).toEqual({
      ...HAPPY_BODY,
      ws_url: 'ws://test.invalid/test/stream?sid=sid-1&token=abc',
    });
  });

  it('D11 — forwards self_name from request body to the wire', async () => {
    // The SW reads mm_user_name from storage and passes it as
    // ``self_name`` in the body. startTranscribeSession is a thin
    // pass-through (JSON.stringify(body)) so the field must reach
    // the wire verbatim — the backend uses it to pre-bind the mic
    // substream's first numeric speaker to the user's display name.
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 201, body: HAPPY_BODY }),
    );
    await startTranscribeSession({
      mode: 'self',
      language: 'en',
      self_name: 'Shubham Pilivkar',
    });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({
      mode: 'self',
      language: 'en',
      self_name: 'Shubham Pilivkar',
    });
  });

  it('D11 — null self_name is forwarded (backend falls back to user.name server-side)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 201, body: HAPPY_BODY }),
    );
    await startTranscribeSession({
      mode: 'self', language: 'en', self_name: null,
    });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(init.body)).toHaveProperty('self_name', null);
  });

  it('rewrites an INTERNAL backend ws_url to the public API host', () => {
    expect(
      toPublicWsUrl(
        'ws://localhost:9000/api/v1/transcribe/stream?sid=s1&token=t1',
        'https://test-api.meetminutes.in',
      ),
    ).toBe(
      'wss://test-api.meetminutes.in/api/v1/transcribe/stream?sid=s1&token=t1',
    );
  });

  it('uses ws:// for an http base and keeps the port', () => {
    expect(
      toPublicWsUrl(
        'ws://localhost:9000/api/v1/transcribe/stream?sid=s1',
        'http://127.0.0.1:8000',
      ),
    ).toBe('ws://127.0.0.1:8000/api/v1/transcribe/stream?sid=s1');
  });

  it('resolves a relative ws_url against the configured host', () => {
    expect(
      toPublicWsUrl(
        '/api/v1/transcribe/stream?sid=s9&token=t9',
        'https://test-api.meetminutes.in',
      ),
    ).toBe(
      'wss://test-api.meetminutes.in/api/v1/transcribe/stream?sid=s9&token=t9',
    );
  });

  it('sends Bearer auth header from chrome.storage', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 201, body: HAPPY_BODY }),
    );
    await startTranscribeSession({
      mode: 'self',
      language: 'en',
      provider: 'soniox',
    });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body)).toMatchObject({
      mode: 'self',
      language: 'en',
      provider: 'soniox',
    });
  });

  it('throws AuthError on 401 so the SW transitions to NEEDS_REAUTH', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 401, body: 'unauthorized' }),
    );
    await expect(
      startTranscribeSession({
        mode: 'self',
        language: 'en',
        provider: 'soniox',
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('throws with code="invalid_request" on 422 (language guard)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 422, body: "language 'auto' isn't supported by provider 'deepgram'" }),
    );
    try {
      await startTranscribeSession({
        mode: 'self',
        language: 'auto',
        provider: 'deepgram',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err.code).toBe('invalid_request');
      expect(err.detail).toContain('auto');
    }
  });

  it('throws with code="concurrency_cap" on 429', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 429, body: '' }),
    );
    try {
      await startTranscribeSession({
        mode: 'self',
        language: 'en',
        provider: 'soniox',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err.code).toBe('concurrency_cap');
    }
  });

  it('throws with code="provider_unavailable" on 503', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 503, body: 'SONIOX_API_KEY not set' }),
    );
    try {
      await startTranscribeSession({
        mode: 'self',
        language: 'hi',
        provider: 'soniox',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err.code).toBe('provider_unavailable');
      expect(err.detail).toContain('SONIOX_API_KEY');
    }
  });

  it('throws with code="unknown" on unexpected 5xx', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 500, body: 'oops' }),
    );
    try {
      await startTranscribeSession({
        mode: 'self',
        language: 'en',
        provider: 'soniox',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err.code).toBe('unknown');
      expect(err.message).toContain('500');
    }
  });
});
