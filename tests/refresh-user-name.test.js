// Test for api/client.js#refreshUserName — fetches /user/profile and
// persists the backend display name to chrome.storage.local under
// StorageKey.USER_NAME so popup / control / overlay can render the
// real name instead of an email-derived fallback.
//
// Endpoint correction: the standalone backend's /api/v1/me was never
// ported (account_routes.py documents the decision); the canonical
// profile lives on the monolith's /user/profile, which is what the
// extension must call. A stale /api/v1/me would 404 silently and
// leave mm_user_name empty, sending every UI surface down the
// email-derived fallback path ("Shubhampilivkar" without the space
// in "Shubham Pilivkar"). This test pins the URL.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshUserName } from '../src/api/client.js';
import { StorageKey } from '../src/constants.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body)),
  };
}

beforeEach(() => {
  vi.mocked(chrome.storage.local.set).mockReset();
  vi.mocked(chrome.storage.local.set).mockImplementation(async () => {});
});

afterEach(() => {
  vi.mocked(fetch).mockReset();
});

describe('refreshUserName()', () => {
  it('GETs /user/profile with the Bearer token and persists name', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, { id: 'u1', email: 'shubhampilivkar@gmail.com', name: 'Shubham Pilivkar' }),
    );

    const out = await refreshUserName();

    expect(out).toBe('Shubham Pilivkar');
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toMatch(/\/user\/profile$/);
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [StorageKey.USER_NAME]: 'Shubham Pilivkar',
    });
  });

  it('preserves internal spaces in the name (no munging of "Shubham Pilivkar")', async () => {
    // Regression test for the name-collapse bug — the live-transcribe
    // overlay was rendering "Shubhampilivkar" (email-local titlecased)
    // because refreshUserName was hitting the wrong endpoint and the
    // overlay's loadDisplayName fell back to deriveNameFromEmail.
    // Pin that the full backend name reaches storage verbatim.
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, { name: 'Shubham Pilivkar' }),
    );
    await refreshUserName();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [StorageKey.USER_NAME]: 'Shubham Pilivkar',
    });
  });

  it('trims whitespace from name before persisting', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, { id: 'u1', email: 'u@x.com', name: '  Rishi Patel  ' }),
    );

    await refreshUserName();

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [StorageKey.USER_NAME]: 'Rishi Patel',
    });
  });

  it('null / missing / blank name does NOT clobber existing storage', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, { id: 'u1', email: 'u@x.com', name: null }),
    );

    const out = await refreshUserName();

    expect(out).toBeNull();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('network failure returns null (best-effort, never throws)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('econnreset'));

    const out = await refreshUserName();

    expect(out).toBeNull();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('non-2xx response returns null (does not surface as error)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(500, {}));

    const out = await refreshUserName();

    expect(out).toBeNull();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});
