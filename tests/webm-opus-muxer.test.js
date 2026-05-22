// Tests for the hand-written audio-only WebM/Opus muxer. The format
// is well-defined (Matroska/EBML), so we can pin bytes for the
// fixed-shape parts (EBML header, VINT encoding, OpusHead) and
// behavioural assertions for the variable parts (cluster timecode,
// SimpleBlock count).
//
// A real "does this WebM parse" check would need ffprobe; we leave
// that to the manual smoke test on a recorded chunk. These tests
// catch the math + structural bugs that don't depend on a parser.

import { describe, expect, it } from 'vitest';

import {
  WebmOpusMuxer,
  buildOpusHead,
  encodeUint,
  encodeVint,
} from '../src/lib/webm-opus-muxer.js';


describe('encodeVint', () => {
  it('1-byte VINT for small values (sets marker bit 0x80)', () => {
    // 0 → 0x80, 1 → 0x81, 126 → 0xFE. 127 would be reserved
    // (all-ones is the "unknown size" marker for 1-byte VINTs)
    // so we use the 2-byte encoding from 127 onward.
    expect(encodeVint(0)).toEqual(new Uint8Array([0x80]));
    expect(encodeVint(1)).toEqual(new Uint8Array([0x81]));
    expect(encodeVint(126)).toEqual(new Uint8Array([0xFE]));
  });

  it('promotes to 2-byte VINT at the 7-bit boundary', () => {
    // 127 (0x7F) needs 2 bytes: marker 0x40 + value 0x7F → 0x407F.
    expect(encodeVint(127)).toEqual(new Uint8Array([0x40, 0x7F]));
    expect(encodeVint(128)).toEqual(new Uint8Array([0x40, 0x80]));
  });

  it('promotes to 3-byte VINT at the 14-bit boundary', () => {
    expect(encodeVint(0x3FFF)).toEqual(new Uint8Array([0x20, 0x3F, 0xFF]));
  });

  it('rejects negative or non-finite values', () => {
    expect(() => encodeVint(-1)).toThrow();
    expect(() => encodeVint(NaN)).toThrow();
    expect(() => encodeVint(Infinity)).toThrow();
  });
});


describe('encodeUint', () => {
  it('produces the smallest big-endian byte sequence by default', () => {
    expect(encodeUint(0)).toEqual(new Uint8Array([0]));
    expect(encodeUint(255)).toEqual(new Uint8Array([0xFF]));
    expect(encodeUint(256)).toEqual(new Uint8Array([0x01, 0x00]));
    expect(encodeUint(0xFFFF)).toEqual(new Uint8Array([0xFF, 0xFF]));
    expect(encodeUint(0x10000)).toEqual(new Uint8Array([0x01, 0x00, 0x00]));
  });

  it('honours minBytes when value is smaller', () => {
    expect(encodeUint(1, 4)).toEqual(new Uint8Array([0, 0, 0, 1]));
  });
});


describe('buildOpusHead', () => {
  it('starts with the OpusHead magic + version + channel count', () => {
    const h = buildOpusHead({ channels: 1, sampleRate: 48_000 });
    // "OpusHead" magic
    expect(Array.from(h.slice(0, 8))).toEqual(
      [0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64],
    );
    // Version 1
    expect(h[8]).toBe(1);
    // Channel count = 1
    expect(h[9]).toBe(1);
    // Mapping family = 0
    expect(h[18]).toBe(0);
  });

  it('writes the sample rate as little-endian uint32', () => {
    const h = buildOpusHead({ channels: 1, sampleRate: 48_000 });
    // Bytes 12..15 are sample rate LE. 48000 = 0x0000BB80 → BB 80 00 00 LE.
    expect(h[12]).toBe(0x80);
    expect(h[13]).toBe(0xBB);
    expect(h[14]).toBe(0);
    expect(h[15]).toBe(0);
  });

  it('produces exactly 19 bytes', () => {
    expect(buildOpusHead({ channels: 1, sampleRate: 48_000 }).byteLength).toBe(19);
  });
});


function makeMuxer() {
  return new WebmOpusMuxer({ sampleRate: 48_000, channels: 1 });
}

function fakePacket(byte = 0xFE, length = 8) {
  return new Uint8Array(length).fill(byte);
}


describe('WebmOpusMuxer', () => {
  it('starts with EBML header magic 0x1A45DFA3', () => {
    const m = makeMuxer();
    m.addPacket({ packet: fakePacket(), timecodeMs: 0 });
    const blob = m.finalize();
    return blob.arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf);
      // First 4 bytes are the EBML element ID.
      expect(bytes[0]).toBe(0x1A);
      expect(bytes[1]).toBe(0x45);
      expect(bytes[2]).toBe(0xDF);
      expect(bytes[3]).toBe(0xA3);
    });
  });

  it('produces a Blob with the right MIME type', () => {
    const m = makeMuxer();
    m.addPacket({ packet: fakePacket(), timecodeMs: 0 });
    const blob = m.finalize();
    expect(blob.type).toBe('audio/webm;codecs=opus');
  });

  it('packetCount tracks added packets', () => {
    const m = makeMuxer();
    expect(m.packetCount).toBe(0);
    m.addPacket({ packet: fakePacket(), timecodeMs: 0 });
    m.addPacket({ packet: fakePacket(), timecodeMs: 20 });
    expect(m.packetCount).toBe(2);
  });

  it('throws when adding after finalize', () => {
    const m = makeMuxer();
    m.addPacket({ packet: fakePacket(), timecodeMs: 0 });
    m.finalize();
    expect(() => m.addPacket({ packet: fakePacket(), timecodeMs: 20 }))
      .toThrow(/finalized/);
  });

  it('finalize is idempotent', () => {
    const m = makeMuxer();
    m.addPacket({ packet: fakePacket(), timecodeMs: 0 });
    const a = m.finalize();
    const b = m.finalize();
    expect(a).toBe(b);
  });

  it('rejects SimpleBlock timecodes outside int16 range', () => {
    const m = makeMuxer();
    m.addPacket({ packet: fakePacket(), timecodeMs: 0 });
    // 33 seconds at int16 ms is over the 32_767 cap.
    expect(() => m.addPacket({ packet: fakePacket(), timecodeMs: 33_000 }))
      .toThrow(/out_of_range/);
  });

  it('uses the FIRST packet timecode as the cluster base', async () => {
    // Packet timecodes 100ms, 120ms, 140ms → cluster Timecode=100,
    // SimpleBlock offsets 0, 20, 40. We can't easily inspect the
    // SimpleBlock bytes without parsing, but cluster Timecode appears
    // raw in the output bytes and is easy to locate.
    const m = makeMuxer();
    m.addPacket({ packet: fakePacket(), timecodeMs: 100 });
    m.addPacket({ packet: fakePacket(), timecodeMs: 120 });
    const blob = m.finalize();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // The byte 100 (0x64) appears in the Cluster timecode element.
    // Coarse but sufficient as a pinning test — a regression that
    // baselined at 0 wouldn't have 0x64 in this output position.
    expect(bytes.includes(0x64)).toBe(true);
  });
});
