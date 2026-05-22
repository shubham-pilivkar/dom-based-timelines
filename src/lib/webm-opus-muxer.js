// Minimal WebM/Matroska muxer for audio-only Opus tracks.
//
// Wraps a sequence of Opus packets emitted by WebCodecs ``AudioEncoder``
// into a playable WebM file. One ``Muxer`` instance produces one
// self-contained WebM bytestream — the recorder builds a fresh muxer
// per 20s chunk so each upload is a standalone file the backend's
// existing chunk pipeline can concatenate or play back independently.
//
// Why hand-written instead of vendoring webm-muxer (~30 KB minified):
//   * Audio-only WebM is genuinely small — the Matroska elements we
//     need fit in ~250 LOC of well-commented code. Vendoring a
//     general-purpose A+V muxer for an audio-only use case is more
//     code than necessary.
//   * Self-contained means no third-party update cadence to track.
//   * Diff-reviewable. A 30 KB minified blob isn't.
//
// What this does NOT handle: video tracks, multi-track audio,
// SeekHead, Cues, Tags. The audio-only chunk pipeline doesn't need
// any of them — each chunk is a streaming-playable single-cluster
// WebM and the backend concatenates / re-muxes if it wants a
// random-access file.
//
// References:
//   * https://www.matroska.org/technical/elements.html
//   * https://www.webmproject.org/docs/container/
//   * RFC 7845 — Ogg encapsulation of Opus (CodecPrivate layout is
//     shared between Ogg/Opus and WebM/Opus)

/* eslint-disable no-bitwise */


// EBML element IDs we emit. These are the raw 4-byte (or shorter)
// element IDs from the Matroska spec; muxer below writes them
// verbatim. Listed in the order they appear in the output so a
// reader following along can match elements one-by-one.
const EL = Object.freeze({
  EBML: 0x1A45DFA3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42F7,
  EBMLMaxIDLength: 0x42F2,
  EBMLMaxSizeLength: 0x42F3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,

  Segment: 0x18538067,

  Info: 0x1549A966,
  TimecodeScale: 0x2AD7B1,
  MuxingApp: 0x4D80,
  WritingApp: 0x5741,

  Tracks: 0x1654AE6B,
  TrackEntry: 0xAE,
  TrackNumber: 0xD7,
  TrackUID: 0x73C5,
  TrackType: 0x83,
  FlagEnabled: 0xB9,
  FlagDefault: 0x88,
  FlagLacing: 0x9C,
  CodecID: 0x86,
  CodecPrivate: 0x63A2,
  Audio: 0xE1,
  SamplingFrequency: 0xB5,
  Channels: 0x9F,
  BitDepth: 0x6264,

  Cluster: 0x1F43B675,
  Timecode: 0xE7,
  SimpleBlock: 0xA3,
});

// "Unknown size" marker for the top-level Segment + Cluster elements.
// VINT with all data bits set: 0xFF for length 1, 0x01FF...FF for
// longer. Using 0x01FFFFFFFFFFFFFF (8 bytes) so a single-cluster
// WebM larger than 2^56 bytes is not a worry (we cap at 20s of
// 96 kbps Opus ≈ 240 KB per chunk, miles below the limit).
const UNKNOWN_SIZE_8 = new Uint8Array([
  0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
]);


/**
 * Encode an unsigned integer as a VINT (variable-length integer).
 * VINT length is signalled by the leading-zero count of the first
 * byte: 0x80 = 1 byte, 0x40 = 2 bytes, etc. The value bits follow
 * the marker.
 *
 * @param {number} value
 * @returns {Uint8Array}
 */
export function encodeVint(value) {
  if (value < 0 || !Number.isFinite(value)) {
    throw new RangeError(`vint value out of range: ${value}`);
  }
  // Pick the smallest length whose data-bit capacity holds ``value``.
  // 1-byte VINT holds 7 bits, 2-byte holds 14, ... up to 8 bytes.
  let length = 1;
  while (length <= 8 && value >= 2 ** (7 * length) - 1) {
    length += 1;
  }
  if (length > 8) {
    throw new RangeError(`vint value too large: ${value}`);
  }
  const out = new Uint8Array(length);
  // Marker bit on the first byte.
  out[0] = 1 << (8 - length);
  // Fill from the LSB end backwards. ``value | out[0]`` puts the
  // marker into the top of byte 0.
  let v = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] |= v & 0xFF;
    v = Math.floor(v / 256);
  }
  return out;
}


/**
 * Encode a non-negative integer as a big-endian byte sequence using
 * the smallest number of bytes (or ``minBytes`` if it's larger).
 * Used for Matroska "unsigned integer" element values where the
 * Size header is independent of the value's natural length.
 *
 * @param {number} value
 * @param {number} [minBytes]
 * @returns {Uint8Array}
 */
export function encodeUint(value, minBytes = 1) {
  let length = 1;
  let v = value;
  while (v >= 256) { length += 1; v = Math.floor(v / 256); }
  if (length < minBytes) length = minBytes;
  const out = new Uint8Array(length);
  let cur = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = cur & 0xFF;
    cur = Math.floor(cur / 256);
  }
  return out;
}


/**
 * Encode the EBML element ID (1-4 bytes) as a raw byte sequence.
 * Element IDs already include their VINT marker so we just need to
 * pack the integer into the right byte count.
 *
 * @param {number} id
 * @returns {Uint8Array}
 */
function encodeId(id) {
  let length = 1;
  if (id > 0xFFFFFF) length = 4;
  else if (id > 0xFFFF) length = 3;
  else if (id > 0xFF) length = 2;
  const out = new Uint8Array(length);
  let v = id;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = v & 0xFF;
    v = Math.floor(v / 256);
  }
  return out;
}


// Concatenate multiple Uint8Arrays into one.
function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}


/**
 * Build an EBML element: ID + Size (VINT) + payload bytes.
 *
 * @param {number} id
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function el(id, payload) {
  return concatBytes([encodeId(id), encodeVint(payload.byteLength), payload]);
}


// Build an EBML element whose size is the "unknown" marker. Used
// for streaming containers (Segment, Cluster) where the length
// isn't known up front.
function elUnknownSize(id, payload) {
  return concatBytes([encodeId(id), UNKNOWN_SIZE_8, payload]);
}


// 32-bit float, big-endian — for SamplingFrequency.
function encodeFloat32(value) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, false);
  return new Uint8Array(buf);
}


// UTF-8 string bytes.
function encodeString(s) {
  return new TextEncoder().encode(s);
}


/**
 * Build the OpusHead block used as ``CodecPrivate`` for WebM/Opus.
 * Layout per RFC 7845 §5.1:
 *   Magic "OpusHead"             8 bytes
 *   Version (1)                  1 byte
 *   Channel count                1 byte
 *   Pre-skip (0)                 2 bytes (LE)
 *   Input sample rate            4 bytes (LE)  — informational
 *   Output gain (0)              2 bytes (LE)
 *   Channel mapping family (0)   1 byte
 *
 * @param {{channels: number, sampleRate: number}} opts
 * @returns {Uint8Array}
 */
export function buildOpusHead({ channels, sampleRate }) {
  const buf = new ArrayBuffer(19);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  u8[8] = 1;                                  // version
  u8[9] = channels;                           // channel count
  v.setUint16(10, 0, true);                   // pre-skip
  v.setUint32(12, sampleRate, true);          // input sample rate
  v.setInt16(16, 0, true);                    // output gain
  u8[18] = 0;                                 // mapping family
  return u8;
}


/**
 * Build the EBML header — fixed bytes, same on every chunk. Could be
 * cached but it's cheap to rebuild.
 */
function buildEbmlHeader() {
  return el(EL.EBML, concatBytes([
    el(EL.EBMLVersion,        encodeUint(1)),
    el(EL.EBMLReadVersion,    encodeUint(1)),
    el(EL.EBMLMaxIDLength,    encodeUint(4)),
    el(EL.EBMLMaxSizeLength,  encodeUint(8)),
    el(EL.DocType,            encodeString('webm')),
    el(EL.DocTypeVersion,     encodeUint(4)),
    el(EL.DocTypeReadVersion, encodeUint(2)),
  ]));
}


/**
 * Build the Tracks block describing one Opus audio track.
 */
function buildTracks({ sampleRate, channels, codecPrivate }) {
  const audio = el(EL.Audio, concatBytes([
    el(EL.SamplingFrequency, encodeFloat32(sampleRate)),
    el(EL.Channels,          encodeUint(channels)),
  ]));
  const trackEntry = el(EL.TrackEntry, concatBytes([
    el(EL.TrackNumber,   encodeUint(1)),
    el(EL.TrackUID,      encodeUint(1)),
    el(EL.TrackType,     encodeUint(2)),    // 2 = audio
    el(EL.FlagEnabled,   encodeUint(1)),
    el(EL.FlagDefault,   encodeUint(1)),
    el(EL.FlagLacing,    encodeUint(0)),
    el(EL.CodecID,       encodeString('A_OPUS')),
    el(EL.CodecPrivate,  codecPrivate),
    audio,
  ]));
  return el(EL.Tracks, trackEntry);
}


/**
 * Build the Info block. ``TimecodeScale`` is in nanoseconds per
 * timecode unit — 1,000,000 means each timecode tick is 1 ms, which
 * matches the millisecond cadence the encoder reports.
 */
function buildInfo() {
  return el(EL.Info, concatBytes([
    el(EL.TimecodeScale, encodeUint(1_000_000)),
    el(EL.MuxingApp,     encodeString('MeetMinutes-WebCodecs')),
    el(EL.WritingApp,    encodeString('MeetMinutes-WebCodecs')),
  ]));
}


/**
 * A SimpleBlock wrapping one Opus packet. SimpleBlock layout:
 *   TrackNumber (VINT)
 *   Timecode    (int16, ms relative to Cluster.Timecode)
 *   Flags       (1 byte: 0x80 = keyframe)
 *   Payload     (raw codec data)
 *
 * Every Opus packet is independently decodable so keyframe=1 always.
 *
 * @param {{trackNumber: number, relativeTimecodeMs: number, packet: Uint8Array}} args
 * @returns {Uint8Array}
 */
function buildSimpleBlock({ trackNumber, relativeTimecodeMs, packet }) {
  const tn = encodeVint(trackNumber);
  // Int16 BE for timecode offset.
  const tc = new Uint8Array(2);
  new DataView(tc.buffer).setInt16(0, relativeTimecodeMs, false);
  const flags = new Uint8Array([0x80]);  // keyframe
  return el(EL.SimpleBlock, concatBytes([tn, tc, flags, packet]));
}


/**
 * Public Muxer API.
 *
 * Usage:
 *   const m = new WebmOpusMuxer({ sampleRate: 48000, channels: 1 });
 *   m.addPacket({ packet, timecodeMs });
 *   // ...
 *   const blob = m.finalize();   // returns a Blob ready for upload
 *
 * Each instance produces ONE WebM file. To stream multiple chunks,
 * create a fresh Muxer per chunk and reset the encoder's timecode
 * accumulator (or pass relative timecodes here directly).
 *
 * Memory model: all packets are buffered in memory until ``finalize``.
 * For 20s of 96 kbps Opus that's ~240 KB, well within the offscreen
 * doc's heap budget.
 */
export class WebmOpusMuxer {
  /**
   * @param {{sampleRate: number, channels: number}} opts
   */
  constructor({ sampleRate = 48000, channels = 1 } = {}) {
    this._sampleRate = sampleRate;
    this._channels = channels;
    /** @type {Uint8Array[]} */
    this._blocks = [];
    this._clusterTimecodeMs = 0;
    this._firstPacketRecorded = false;
    this._finalized = false;
  }

  /**
   * Add one Opus packet. ``timecodeMs`` is the timestamp at which
   * this packet plays back, in milliseconds since the start of the
   * containing chunk.
   *
   * @param {{packet: Uint8Array, timecodeMs: number}} args
   */
  addPacket({ packet, timecodeMs }) {
    if (this._finalized) {
      throw new Error('webm_muxer_finalized');
    }
    if (!this._firstPacketRecorded) {
      // The cluster's base timecode is the timestamp of the first
      // packet — sets relative timecodes for everything else to 0+.
      this._clusterTimecodeMs = Math.max(0, Math.floor(timecodeMs));
      this._firstPacketRecorded = true;
    }
    const rel = Math.floor(timecodeMs) - this._clusterTimecodeMs;
    // Matroska's SimpleBlock timecode offset is a signed int16, so
    // a single cluster can span ±32 seconds. Our 20s chunks fit
    // comfortably; long-running chunks would need multiple clusters.
    if (rel < -32_768 || rel > 32_767) {
      throw new RangeError(
        `simple_block_timecode_out_of_range: ${rel}`,
      );
    }
    this._blocks.push(buildSimpleBlock({
      trackNumber: 1,
      relativeTimecodeMs: rel,
      packet,
    }));
  }

  /**
   * Emit the assembled WebM bytes. Idempotent — calling twice
   * returns the same Blob.
   *
   * @returns {Blob}
   */
  finalize() {
    if (this._finalized && this._cachedBlob) {
      return this._cachedBlob;
    }
    this._finalized = true;

    const cluster = elUnknownSize(EL.Cluster, concatBytes([
      el(EL.Timecode, encodeUint(this._clusterTimecodeMs)),
      ...this._blocks,
    ]));

    const tracks = buildTracks({
      sampleRate: this._sampleRate,
      channels: this._channels,
      codecPrivate: buildOpusHead({
        channels: this._channels,
        sampleRate: this._sampleRate,
      }),
    });

    const segment = elUnknownSize(EL.Segment, concatBytes([
      buildInfo(),
      tracks,
      cluster,
    ]));

    const bytes = concatBytes([buildEbmlHeader(), segment]);
    this._cachedBlob = new Blob([bytes], { type: 'audio/webm;codecs=opus' });
    return this._cachedBlob;
  }

  /**
   * Number of packets currently buffered. Useful for tests + debug
   * — the recorder uses it to decide whether to skip an empty chunk.
   */
  get packetCount() {
    return this._blocks.length;
  }
}
