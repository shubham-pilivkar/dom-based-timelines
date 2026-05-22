// Tests for ``api/client.js#dispatchBot`` — verifies the error-code
// mapping matches what the popup expects on each status. The 4xx /
// 5xx branches each surface a different message to the user, so the
// mapping is contract not cosmetic.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchBot } from '../src/api/client.js';

function mockResponse({ status, body = '', ok }) {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    text: vi.fn(async () => body),
    json: vi.fn(async () =>
      typeof body === 'string' ? JSON.parse(body) : body,
    ),
  };
}

const HAPPY_BODY = { bot_id: 'bot-abc', status: 'dispatched' };
const VALID_REQUEST = {
  name: 'Q3 planning sync',
  meeting_url: 'https://meet.google.com/abc-defg-hij',
  platform: 'google_meet',
};

afterEach(() => {
  vi.mocked(fetch).mockReset();
  vi.mocked(fetch).mockImplementation(async () => {
    throw new Error('fetch not mocked in this test');
  });
});

describe('dispatchBot', () => {
  it('parses + returns the body on 202', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 202, body: HAPPY_BODY }),
    );
    const result = await dispatchBot(VALID_REQUEST);
    expect(result).toEqual(HAPPY_BODY);
  });

  it('sends Bearer auth header + JSON body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 202, body: HAPPY_BODY }),
    );
    await dispatchBot(VALID_REQUEST);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body)).toEqual(VALID_REQUEST);
  });

  it('targets the unified /api/v1/bot endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 202, body: HAPPY_BODY }),
    );
    await dispatchBot(VALID_REQUEST);
    const [url] = vi.mocked(fetch).mock.calls[0];
    // Backend REFACTOR-2 moved this off /api/v1/meetings/bot.
    expect(url).toContain('/api/v1/bot');
    expect(url).not.toContain('/meetings/');
  });

  it('maps 422 to err.code="invalid_request" with detail', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 422, body: '{"detail":"bad url"}' }),
    );
    await expect(dispatchBot(VALID_REQUEST)).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'bot_dispatch_invalid_request',
    });
  });

  it('maps 429 to err.code="rate_limited"', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 429, body: '' }),
    );
    await expect(dispatchBot(VALID_REQUEST)).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'bot_dispatch_rate_limited',
    });
  });

  it('maps 503 to err.code="unavailable" with detail', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({
        status: 503,
        body: '{"detail":"bot service down"}',
      }),
    );
    await expect(dispatchBot(VALID_REQUEST)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'bot_dispatch_unavailable',
    });
  });

  it('maps unknown status codes to err.code="unknown"', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 500, body: '' }),
    );
    await expect(dispatchBot(VALID_REQUEST)).rejects.toMatchObject({
      code: 'unknown',
      message: 'bot_dispatch_failed_500',
    });
  });

  it('accepts ms_teams as the platform value', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 202, body: HAPPY_BODY }),
    );
    await dispatchBot({
      ...VALID_REQUEST,
      meeting_url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x',
      platform: 'ms_teams',
    });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(init.body).platform).toBe('ms_teams');
  });

  it('accepts zoom as the platform value', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ status: 202, body: HAPPY_BODY }),
    );
    await dispatchBot({
      ...VALID_REQUEST,
      meeting_url: 'https://us02web.zoom.us/j/1234567890',
      platform: 'zoom',
    });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(init.body).platform).toBe('zoom');
  });
});
