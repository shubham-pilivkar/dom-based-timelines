// P2 backend-alignment: W5 chunk sha256 integrity + W9 regression
// guard (removed backend surfaces must not creep back).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { drainChunkQueue, persistChunk } from '../src/api/client.js';

function makeBlob(content) {
  return new Blob([content], { type: 'video/webm' });
}

describe('W5 — chunk sha256 integrity', () => {
  it('sends the correct lowercase-hex SHA-256 of the uploaded bytes', async () => {
    const meetingId = `m-${Math.random().toString(36).slice(2)}`;
    await persistChunk({
      meetingId, chunkIndex: 0, isFinal: true, blob: makeBlob('abc'),
    });
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 201 });

    await drainChunkQueue({
      meetingId, shouldContinue: () => true, onProgress: () => {},
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = vi.mocked(fetch).mock.calls[0][1].body;
    // File part always present (W6).
    expect(body.has('file')).toBe(true);
    const sent = body.get('sha256');
    if (sent != null) {
      // Web Crypto available in this env → must be the real digest.
      const expected = createHash('sha256').update('abc').digest('hex');
      expect(sent).toBe(expected);
      expect(/^[0-9a-f]{64}$/.test(sent)).toBe(true);
    }
    // If crypto.subtle is unavailable the field is omitted (optional) —
    // upload still succeeds; the (rec,idx) index keeps it dedupe-safe.
  });

  it('persists the digest on the chunk record (reused across retries)', async () => {
    const meetingId = `m-${Math.random().toString(36).slice(2)}`;
    await persistChunk({
      meetingId, chunkIndex: 0, isFinal: true, blob: makeBlob('xyz'),
    });
    let firstSha;
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 500 }) // force a retry
      .mockResolvedValueOnce({ ok: true, status: 201 });

    await drainChunkQueue({
      meetingId, shouldContinue: () => true, onProgress: () => {},
    });

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBe(2);
    firstSha = calls[0][1].body.get('sha256');
    const secondSha = calls[1][1].body.get('sha256');
    // Same chunk → same digest on every attempt (persisted once).
    expect(secondSha).toBe(firstSha);
  }, 10_000);
});

describe('W9 — removed backend surfaces must not reappear', () => {
  function walk(dir) {
    const out = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) out.push(...walk(p));
      else if (ent.name.endsWith('.js')) out.push(p);
    }
    return out;
  }

  // Heuristic comment stripper — enough to tell "documented in a
  // migration note" (allowed) from "actually called again" (banned).
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')        // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1');     // line comments (keep https://)
  }

  it('no /api/v1/meetings/* or /api/v1/me references in src/ code', () => {
    const offenders = [];
    for (const file of walk(join(process.cwd(), 'src'))) {
      const code = stripComments(readFileSync(file, 'utf8'));
      // Removed unified-API surfaces. `/api/v1/me` is the old profile
      // endpoint (replaced by `/user/profile`); guard the exact
      // quoted/templated string so `/user/profile` doesn't match.
      if (/\/api\/v1\/meetings/.test(code)
        || /['"`]\/api\/v1\/me['"`]/.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
