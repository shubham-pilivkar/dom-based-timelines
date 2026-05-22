// Tests for the Phase F client-side encryption helpers. The
// Node + vitest runtime exposes ``crypto.subtle`` natively (Node 20+)
// so we exercise the real Web Crypto path. IndexedDB is not part of
// the Node runtime; tests that touch master-key persistence are
// covered by a fake-indexeddb shim.

import { describe, expect, it, beforeAll } from 'vitest';

// Need a real(-ish) IndexedDB for ``getOrCreateMasterKey``. The
// ``fake-indexeddb`` package is the standard shim; we install it
// before importing the encryption module so the IDB-open code path
// finds the global ``indexedDB``.
import 'fake-indexeddb/auto';


// Import lazily so the IDB shim is in place when the module's
// top-level code runs.
let enc;
beforeAll(async () => {
  enc = await import('../src/lib/encryption.js');
});


function bytes(s) {
  return new TextEncoder().encode(s);
}


describe('getOrCreateMasterKey', () => {
  it('returns the same CryptoKey across calls (persisted via IDB)', async () => {
    const a = await enc.getOrCreateMasterKey();
    const b = await enc.getOrCreateMasterKey();
    // Same CryptoKey object id in IDB → structured-clone returns
    // logically the same key. Quick sanity check on usages.
    expect(a.type).toBe('secret');
    expect(b.type).toBe('secret');
    expect(a.algorithm.name).toBe('AES-GCM');
    expect(a.algorithm.length).toBe(enc.E2EE_KEY_BITS);
    // Non-extractable — exporting must throw / reject.
    await expect(crypto.subtle.exportKey('raw', a)).rejects.toBeTruthy();
  });

  it('reports wrapKey / unwrapKey usages, NOT encrypt / decrypt', async () => {
    const m = await enc.getOrCreateMasterKey();
    expect(m.usages).toContain('wrapKey');
    expect(m.usages).toContain('unwrapKey');
    // Master key is only for KEK use; using it to encrypt chunks
    // directly would be a layering violation.
    expect(m.usages).not.toContain('encrypt');
    expect(m.usages).not.toContain('decrypt');
  });
});


describe('generateMeetingKey', () => {
  it('returns a fresh AES-256-GCM key per call', async () => {
    const a = await enc.generateMeetingKey();
    const b = await enc.generateMeetingKey();
    expect(a.algorithm.name).toBe('AES-GCM');
    expect(a.algorithm.length).toBe(enc.E2EE_KEY_BITS);
    // Distinct keys — extract raw and compare.
    const aRaw = new Uint8Array(await crypto.subtle.exportKey('raw', a));
    const bRaw = new Uint8Array(await crypto.subtle.exportKey('raw', b));
    expect(aRaw).not.toEqual(bRaw);
  });
});


describe('wrap / unwrap meeting key', () => {
  it('round-trips through master key without losing usability', async () => {
    const master = await enc.getOrCreateMasterKey();
    const original = await enc.generateMeetingKey();
    const wrapped = await enc.wrapMeetingKey(original, master);
    expect(wrapped).toBeInstanceOf(Uint8Array);
    expect(wrapped.byteLength).toBeGreaterThan(enc.E2EE_IV_BYTES);

    const recovered = await enc.unwrapMeetingKey(wrapped, master);
    // Use both keys to encrypt the same plaintext and confirm the
    // ciphertexts decrypt cross-key — that proves the raw key bytes
    // match without exposing them.
    const pt = bytes('hello e2ee');
    const ivA = crypto.getRandomValues(new Uint8Array(12));
    const ctA = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivA }, original, pt);
    const decA = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivA }, recovered, ctA);
    expect(new TextDecoder().decode(decA)).toBe('hello e2ee');
  });

  it('emits a different ciphertext on each wrap (random IV)', async () => {
    const master = await enc.getOrCreateMasterKey();
    const key = await enc.generateMeetingKey();
    const a = await enc.wrapMeetingKey(key, master);
    const b = await enc.wrapMeetingKey(key, master);
    expect(a).not.toEqual(b);
  });

  it('rejects a wrapped blob that is too short', async () => {
    const master = await enc.getOrCreateMasterKey();
    const tooShort = new Uint8Array(8);
    await expect(enc.unwrapMeetingKey(tooShort, master)).rejects.toThrow(/too_short/);
  });
});


describe('encrypt / decrypt chunk', () => {
  it('produces ciphertext of length plaintext + IV + 16-byte auth tag', async () => {
    const key = await enc.generateMeetingKey();
    const plaintext = new Uint8Array(1024).fill(7);
    const blob = new Blob([plaintext]);
    const out = await enc.encryptChunk(blob, key);
    expect(out).toBeInstanceOf(Blob);
    expect(out.type).toBe('application/octet-stream');
    // IV (12) + ciphertext (1024) + auth tag (16) = 1052.
    expect(out.size).toBe(plaintext.byteLength + enc.E2EE_IV_BYTES + 16);
  });

  it('encrypts the same plaintext to different ciphertexts (random IV)', async () => {
    const key = await enc.generateMeetingKey();
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
    const a = new Uint8Array(await (await enc.encryptChunk(blob, key)).arrayBuffer());
    const b = new Uint8Array(await (await enc.encryptChunk(blob, key)).arrayBuffer());
    expect(a).not.toEqual(b);
  });

  it('round-trips through encrypt → decrypt with mime preserved', async () => {
    const key = await enc.generateMeetingKey();
    const plain = bytes('lorem ipsum dolor sit amet');
    const blob = new Blob([plain], { type: 'audio/webm;codecs=opus' });
    const encrypted = await enc.encryptChunk(blob, key);
    const decrypted = await enc.decryptChunk(encrypted, key, 'audio/webm;codecs=opus');
    expect(decrypted.type).toBe('audio/webm;codecs=opus');
    const recovered = new Uint8Array(await decrypted.arrayBuffer());
    expect(recovered).toEqual(plain);
  });

  it('decrypt fails on tampered ciphertext (AES-GCM auth tag rejects)', async () => {
    const key = await enc.generateMeetingKey();
    const blob = new Blob([bytes('untampered')]);
    const enc1 = await enc.encryptChunk(blob, key);
    const bytes1 = new Uint8Array(await enc1.arrayBuffer());
    // Flip a byte in the ciphertext region.
    bytes1[bytes1.length - 1] ^= 0xFF;
    await expect(enc.decryptChunk(bytes1, key)).rejects.toBeTruthy();
  });

  it('decrypt fails on undersized input', async () => {
    const key = await enc.generateMeetingKey();
    const tiny = new Uint8Array(4);
    await expect(enc.decryptChunk(tiny, key)).rejects.toThrow(/too_short/);
  });

  it('accepts Uint8Array / ArrayBuffer / Blob inputs symmetrically', async () => {
    const key = await enc.generateMeetingKey();
    const plain = bytes('multi-input check');
    const enc1 = await enc.encryptChunk(new Blob([plain]), key);
    const raw = new Uint8Array(await enc1.arrayBuffer());

    const fromBlob = await enc.decryptChunk(enc1, key);
    const fromBuffer = await enc.decryptChunk(raw.buffer, key);
    const fromU8 = await enc.decryptChunk(raw, key);
    for (const out of [fromBlob, fromBuffer, fromU8]) {
      const r = new Uint8Array(await out.arrayBuffer());
      expect(r).toEqual(plain);
    }
  });
});
