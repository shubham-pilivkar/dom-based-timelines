// Tests for ``api/client.js#pickAllowedContentType`` — the chunk
// upload must present a content-type the unified backend's base-type
// allowlist accepts, or the drain's poison-guard permanently drops
// the chunk (415). The critical case is E2EE: encryptChunk() returns
// an ``application/octet-stream`` blob, so without normalisation
// every encrypted recording silently loses all data.

import { describe, expect, it } from 'vitest';
import { pickAllowedContentType } from '../src/api/client.js';

describe('pickAllowedContentType', () => {
  it('strips a codecs= suffix down to the allowed base type', () => {
    expect(pickAllowedContentType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(pickAllowedContentType('video/webm;codecs=vp9,opus')).toBe('video/webm');
    expect(pickAllowedContentType('video/mp4;codecs=avc1.42E01E,mp4a.40.2'))
      .toBe('video/mp4');
  });

  it('passes through an already-allowed base type unchanged', () => {
    for (const t of [
      'video/webm', 'audio/webm', 'video/mp4', 'audio/mp4',
      'video/mp2t', 'audio/ogg', 'audio/opus',
    ]) {
      expect(pickAllowedContentType(t)).toBe(t);
    }
  });

  it('maps encrypted (application/octet-stream) bytes to an allowed '
    + 'container by the original media kind', () => {
    // The uploader passes the PRESERVED original recorder mime here,
    // not the ciphertext blob's octet-stream type — so an audio-only
    // encrypted recording is labelled audio/webm, video video/webm.
    expect(pickAllowedContentType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(pickAllowedContentType('video/mp4;codecs=avc1')).toBe('video/mp4');
    // Defence-in-depth: even if only octet-stream reaches the helper
    // it still yields an ALLOWED type (never a 415).
    expect(pickAllowedContentType('application/octet-stream')).toBe('video/webm');
  });

  it('falls back by media-kind prefix for unknown/missing types', () => {
    expect(pickAllowedContentType('audio/x-weird')).toBe('audio/webm');
    expect(pickAllowedContentType('video/x-matroska')).toBe('video/webm');
    expect(pickAllowedContentType('')).toBe('video/webm');
    expect(pickAllowedContentType(undefined)).toBe('video/webm');
    expect(pickAllowedContentType(null)).toBe('video/webm');
  });

  it('never returns a type outside the backend allowlist', () => {
    const allowed = new Set([
      'video/webm', 'audio/webm', 'video/mp4', 'audio/mp4',
      'video/mp2t', 'audio/ogg', 'audio/opus',
    ]);
    for (const input of [
      'application/octet-stream', 'audio/webm;codecs=opus',
      'video/mp4;codecs=avc1', 'text/plain', '', undefined, null,
      'AUDIO/WEBM', 'Video/WebM;codecs=vp9',
    ]) {
      expect(allowed.has(pickAllowedContentType(input))).toBe(true);
    }
  });
});
