// Per-frame Opus encoder backed by the WebCodecs ``AudioEncoder`` API.
// Used by the live-transcribe pipeline when the backend tells the
// client to send Opus (``audio_format: "opus"``). Encoded packets are
// ~10-20× smaller on the wire than the raw 16 kHz Int16 PCM we
// otherwise send, which meaningfully reduces battery + bandwidth on
// mobile-tethered users.
//
// Streaming-friendly contract:
//   * ``encodeInt16Frame(int16, sampleRate)`` accepts the worklet's
//     downsampled PCM, hands an ``AudioData`` to the encoder, and
//     resolves once the encoder's ``output`` callback emits the
//     resulting ``EncodedAudioChunk``.
//   * One Int16 input frame can yield zero, one, or several Opus
//     packets depending on whether the encoder's internal frame
//     boundary (20 ms at 16 kHz = 320 samples) aligns with the
//     worklet's emit size (typically 128 samples). The encoder
//     handles the buffering internally — we just hand off frames.
//
// Why not OGG/Opus container framing here:
//   * Soniox accepts raw Opus packets directly via
//     ``audio_format: "opus"``.
//   * Deepgram + Chirp want OGG/WebM framing, which adds a muxer
//     dependency. We keep them on PCM for now (see each adapter's
//     ``wire_audio_format``); when we add a muxer we'll wire it
//     through here too.
//
// Browser support: WebCodecs ``AudioEncoder`` is GA in Chrome 94+.
// The extension targets Chromium-only deployments so we can lean on
// it directly. A ``isOpusEncodingSupported()`` probe lets callers
// degrade to PCM if the browser is unexpectedly missing the API.

/**
 * Return true when the browser exposes WebCodecs ``AudioEncoder`` and
 * advertises Opus support. Synchronous best-effort — the actual
 * codec-config call is async, so callers that need a guarantee
 * should also handle a ``configure()`` throw.
 *
 * @returns {boolean}
 */
export function isOpusEncodingSupported() {
  return typeof globalThis !== 'undefined'
    && typeof globalThis.AudioEncoder === 'function'
    && typeof globalThis.AudioData === 'function';
}


/**
 * Build a streaming Opus encoder. Returns an object with:
 *   - ``encodeInt16Frame(int16, sampleRate)``: encode one PCM frame.
 *     Async; resolves when the corresponding Opus packets (if any)
 *     have been emitted via ``onEncoded``.
 *   - ``close()``: flush + dispose the encoder.
 *
 * @param {{
 *   bitrate?: number,
 *   onEncoded: (packet: Uint8Array) => void,
 *   onError?: (err: unknown) => void,
 * }} opts
 * @returns {Promise<{
 *   encodeInt16Frame: (int16: Int16Array, sampleRate: number) => void,
 *   close: () => Promise<void>,
 * }>}
 */
export async function createOpusEncoder(opts) {
  if (!isOpusEncodingSupported()) {
    throw new Error('webcodecs_opus_unavailable');
  }
  const bitrate = opts.bitrate ?? 24_000; // 24 kbps — voice-grade

  // The encoder buffers samples until it has a full 20 ms frame
  // (320 samples at 16 kHz). Each ``encode()`` call may emit zero or
  // more ``output`` callbacks depending on how many full frames are
  // ready. We expose only the emit callback to the caller, not the
  // raw EncodedAudioChunk, so consumers don't accidentally hold a
  // reference to a detached buffer.
  /** @type {AudioEncoder} */
  // eslint-disable-next-line no-undef
  const encoder = new AudioEncoder({
    output: (chunk) => {
      try {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        opts.onEncoded(buf);
      } catch (err) {
        opts.onError?.(err);
      }
    },
    error: (err) => {
      opts.onError?.(err);
    },
  });

  // 16 kHz mono with default Opus settings tuned for voice. The codec
  // string ``opus`` is what AudioEncoder accepts — not the MIME
  // ``audio/opus``. Most providers we target are happy with raw
  // packets; OGG framing comes in a later phase.
  encoder.configure({
    codec: 'opus',
    sampleRate: 16_000,
    numberOfChannels: 1,
    bitrate,
  });

  // Walltime/timestamp accumulator. WebCodecs requires a monotonic
  // ``timestamp`` per AudioData in microseconds; we synthesize it
  // from the running sample count rather than reading wall-clock so
  // a paused tab doesn't introduce gaps the encoder would interpret
  // as discontinuities.
  let totalSamples = 0;

  return {
    encodeInt16Frame(int16, sampleRate) {
      if (!int16 || int16.length === 0) return;
      // ``AudioData`` wants Float32, planar. Convert in place; this
      // is the hot path during recording so we avoid intermediate
      // wrapper objects beyond the unavoidable Float32Array.
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i += 1) {
        float32[i] = int16[i] / 32768;
      }
      const timestampUs = Math.round((totalSamples / sampleRate) * 1_000_000);
      totalSamples += int16.length;
      // eslint-disable-next-line no-undef
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: int16.length,
        numberOfChannels: 1,
        timestamp: timestampUs,
        data: float32,
      });
      try {
        encoder.encode(data);
      } finally {
        // AudioData holds a reference to ``float32``; ``close()`` is
        // recommended to release it deterministically per the spec.
        data.close();
      }
    },
    async close() {
      try {
        await encoder.flush();
      } catch {
        /* flush failures are best-effort */
      }
      try {
        encoder.close();
      } catch {
        /* idempotent */
      }
    },
  };
}
