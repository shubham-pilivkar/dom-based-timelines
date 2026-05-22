// Tests for api/client.js#login / #register — the backend-mediated
// (BFF) email/password path. Verifies the extension talks to
// /security/login + /security/signup (NOT Firebase Identity Toolkit:
// no key shipped → Bug 1) and that register() hits the explicit
// signup endpoint (not a login-failure heuristic → Bug 2), plus the
// status→AuthApiError mapping the popup depends on.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { login, register, authenticate } from '../src/api/client.js';

function res({ status, body = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body)),
  };
}

const SESSION = {
  idToken: 'idtok', refreshToken: 'reftok',
  expiresIn: '3600', email: 'u@x.com',
};

afterEach(() => {
  vi.mocked(fetch).mockReset();
  vi.mocked(fetch).mockImplementation(async () => {
    throw new Error('fetch not mocked in this test');
  });
});

describe('login() — POST /security/login', () => {
  it('posts {email,password} (no Firebase key, no Bearer) and returns the session', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res({ status: 200, body: SESSION }));
    const out = await login({ email: 'U@X.com', password: 'pw123456' });
    expect(out).toEqual({ token: 'idtok', email: 'u@x.com' });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toMatch(/\/security\/login$/);
    expect(url).not.toMatch(/identitytoolkit|googleapis/); // Bug 1
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      email: 'u@x.com', password: 'pw123456',
    });
  });

  it('maps 401 → invalid_credentials', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res({ status: 401 }));
    await expect(login({ email: 'u@x.com', password: 'bad' }))
      .rejects.toMatchObject({ name: 'AuthApiError', code: 'invalid_credentials' });
  });

  it('maps 503 → network', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res({ status: 503 }));
    await expect(login({ email: 'u@x.com', password: 'pw' }))
      .rejects.toMatchObject({ code: 'network' });
  });

  it('2xx without a session → unknown', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res({ status: 200, body: { idToken: 'x' } }));
    await expect(login({ email: 'u@x.com', password: 'pw' }))
      .rejects.toMatchObject({ code: 'unknown' });
  });
});

describe('register() — POST /security/signup (explicit, Bug 2)', () => {
  it('hits /security/signup with displayName and returns the session', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res({ status: 200, body: SESSION }));
    const out = await register({
      email: 'New@X.com', password: 'pw123456', name: 'Jane Doe',
    });
    expect(out).toEqual({ token: 'idtok', email: 'u@x.com' });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toMatch(/\/security\/signup$/);
    expect(JSON.parse(init.body)).toEqual({
      email: 'new@x.com', password: 'pw123456', displayName: 'Jane Doe',
    });
  });

  it('blank name → displayName falls back to email (server requires min 1)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res({ status: 200, body: SESSION }));
    await register({ email: 'a@b.com', password: 'pw123456' });
    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(JSON.parse(init.body).displayName).toBe('a@b.com');
  });

  it('maps 409 → email_taken', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res({ status: 409 }));
    await expect(register({ email: 'u@x.com', password: 'pw' }))
      .rejects.toMatchObject({ code: 'email_taken' });
  });

  it('maps 422 → invalid_input', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res({ status: 422 }));
    await expect(register({ email: 'bad', password: 'x' }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('authenticate() back-compat', () => {
  it('name present → signup endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res({ status: 200, body: SESSION }));
    await authenticate({ email: 'a@b.com', password: 'pw', name: 'A' });
    expect(vi.mocked(fetch).mock.calls[0][0]).toMatch(/\/security\/signup$/);
  });

  it('no name → login endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(res({ status: 200, body: SESSION }));
    await authenticate({ email: 'a@b.com', password: 'pw' });
    expect(vi.mocked(fetch).mock.calls[0][0]).toMatch(/\/security\/login$/);
  });
});
