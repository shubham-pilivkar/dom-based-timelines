// Phase E — audio-only recorder built on WebCodecs + a hand-written
// minimal WebM/Opus muxer. Drop-in replacement for the
// MediaRecorder-based ``Recorder`` (same constructor shape, same
// ``onChunk(blob, index, isFinal, mimeType)`` contract) but with
// chunk boundaries that land EXACTLY at the configured
// ``CHUNK_INTERVAL_MS`` instead of "the next WebM cluster after the
// interval elapsed".
//
// Why audio-only:
//   The recording pipeline serves two consumers — transcripts
//   (audio-only is enough) and playback (currently video-only meets
//   the bar). For Phase E v1 we cover the audio-only branch end-to-
//   end and keep video recordings on MediaRecorder. Once we have a
//   month of comparison telemetry in production we'll either land
//   a parallel ``VideoEncoder`` + a full A+V muxer, or stay on
//   MediaRecorder for the video path because the boundary alignment
//   doesn't matter for VOD playback.
//
// Why not just keep MediaRecorder for everything:
//   * MediaRecorder cuts at WebM cluster boundaries — irregular,
//     several seconds of slop on either side of the 20s target.
//     That defeats the HLS-style chunking the upload pipeline
//     leans on.
//   * MediaRecorder gives us no control over keyframe placement or
//     per-frame audio energy (Phase C VAD lives in the worklet, but
//     a future video VAD couldn't be wired without WebCodecs).
//   * WebCodecs is per-frame, so chunk boundaries are exact.
//
// Failure model: if any WebCodecs API throws or rejects, the caller
// can fall back to MediaRecorder. ``isSupported()`` is a static
// probe; constructor + start() can still throw if a Chrome build
// advertises support but rejects ``configure()`` (rare but seen on
// Linux with older drivers).

import { CHUNK_INTERVAL_MS, DEFAULT_AUDIO_BITRATE } from '../constants.js';
import { WebmOpusMuxer } from './webm-opus-muxer.js';


// WebCodecs requires the source to be a ``MediaStreamTrack`` we can
// hand to ``MediaStreamTrackProcessor``. We expect the recording
// stream to carry exactly one audio track.
const OPUS_SAMPLE_RATE = 48_000;
const OPUS_CHANNELS = 1;
const CHUNK_MIME_TYPE = 'audio/webm;codecs=opus';


/**
 * Probe whether the browser exposes the APIs we need. Synchronous —
 * does not actually configure an encoder. Callers can use this to
 * decide whether to construct the WebCodecsRecorder or fall through
 * to MediaRecorder.
 */
export function isWebCodecsRecorderSupported() {
  return typeof globalThis !== 'undefined'
    && typeof globalThis.AudioEncoder === 'function'
    && typeof globalThis.AudioData === 'function'
    && typeof globalThis.MediaStreamTrackProcessor === 'function';
}


/**
 * Same interface as ``Recorder`` so the offscreen doc can swap them
 * via a feature flag. See ``Recorder`` for the field-by-field
 * contract.
 */
export class WebCodecsRecorder {
  /**
   * @param {{
   *   stream: MediaStream,
   *   onChunk: (blob: Blob, index: number, isFinal: boolean, mimeType: string) => Promise<void>,
   *   onError?: (err: unknown) => void,
   *   startIndex?: number,
   *   audioBitsPerSecond?: number,
   * }} args
   */
  constructor({
    stream,
    onChunk,
    onError,
    startIndex = 0,
    audioBitsPerSecond = DEFAULT_AUDIO_BITRATE,
  }) {
    if (!isWebCodecsRecorderSupported()) {
      // Caller should check ``isWebCodecsRecorderSupported`` before
      // constructing. Throwing here protects us against accidental
      // creation in a Firefox-on-Linux build that lacks the APIs.
      throw new Error('webcodecs_recorder_unsupported');
    }
    this.stream = stream;
    this.onChunk = onChunk;
    this.onError = onError;
    this.chunkIndex = startIndex;
    this.audioBitsPerSecond = audioBitsPerSecond;
    this.mimeType = CHUNK_MIME_TYPE;

    this.stopped = false;
    this._stopMarksFinal = true;
    this._paused = false;
    /** @type {Set<Promise<void>>} */
    this._inFlight = new Set();

    // Muxer for the current chunk. Replaced on each boundary tick.
    /** @type {WebmOpusMuxer} */
    this._muxer = new WebmOpusMuxer({
      sampleRate: OPUS_SAMPLE_RATE,
      channels: OPUS_CHANNELS,
    });
    // Timestamp (in ms) of the first packet of the current chunk.
    // Used to make the muxer's timecodes start at 0 within each
    // chunk — each chunk is a standalone WebM file.
    /** @type {number | null} */
    this._chunkBaseTimestampMs = null;

    // setInterval handle for the chunk-boundary timer. The timer
    // fires every CHUNK_INTERVAL_MS and rotates the muxer.
    this._chunkTimer = null;

    // WebCodecs plumbing.
    /** @type {AudioEncoder | null} */
    this._encoder = null;
    /** @type {ReadableStreamDefaultReader<AudioData> | null} */
    this._reader = null;
    // Set true once the audio-pump loop has been started so multiple
    // start() calls are idempotent.
    this._pumpStarted = false;
  }

  start() {
    if (this._pumpStarted) return;
    this._pumpStarted = true;
    const track = this.stream.getAudioTracks()[0];
    if (!track) {
      throw new Error('webcodecs_recorder_no_audio_track');
    }
    // eslint-disable-next-line no-undef
    const proc = new MediaStreamTrackProcessor({ track });
    this._reader = proc.readable.getReader();

    // eslint-disable-next-line no-undef
    this._encoder = new AudioEncoder({
      output: (chunk) => this._handleEncodedChunk(chunk),
      error: (err) => {
        console.error('[recorder-wc] encoder error', err);
        try { this.onError?.(err); } catch { /* never throw */ }
      },
    });
    this._encoder.configure({
      codec: 'opus',
      sampleRate: OPUS_SAMPLE_RATE,
      numberOfChannels: OPUS_CHANNELS,
      bitrate: this.audioBitsPerSecond,
    });

    // Chunk boundary timer.
    this._chunkTimer = setInterval(
      () => this._rotateMuxerSafe(),
      CHUNK_INTERVAL_MS,
    );

    // Kick off the audio-frame pump.
    void this._pump();
  }

  pause() {
    this._paused = true;
  }

  resume() {
    this._paused = false;
  }

  get state() {
    if (!this._pumpStarted) return 'inactive';
    if (this.stopped) return 'inactive';
    return this._paused ? 'paused' : 'recording';
  }

  get nextIndex() {
    return this.chunkIndex;
  }

  /**
   * @param {{ final?: boolean }} [opts]
   */
  async stop({ final = true } = {}) {
    if (this.stopped) {
      await Promise.allSettled([...this._inFlight]);
      return;
    }
    this.stopped = true;
    this._stopMarksFinal = final;

    if (this._chunkTimer) {
      clearInterval(this._chunkTimer);
      this._chunkTimer = null;
    }
    // Cancel the reader first so the pump loop exits cleanly. The
    // ``reader.read()`` await in the pump resolves with
    // ``{done: true}`` once the reader's stream is cancelled.
    if (this._reader) {
      try { await this._reader.cancel(); } catch { /* already cancelled */ }
    }
    // Drain any in-flight encoded chunks before the encoder closes.
    if (this._encoder) {
      try { await this._encoder.flush(); } catch { /* tolerate */ }
      try { this._encoder.close(); } catch { /* idempotent */ }
      this._encoder = null;
    }
    // Emit the final chunk synchronously inline so callers awaiting
    // ``stop()`` see ``isFinal`` land on the right blob.
    await this._emitCurrentChunk({ isFinal: true });
    await Promise.allSettled([...this._inFlight]);
  }

  // ---- internals -------------------------------------------------------

  async _pump() {
    if (!this._reader || !this._encoder) return;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await this._reader.read();
        if (done) break;
        try {
          if (this._paused || this.stopped) {
            // Pause / stop both mean "don't feed the encoder";
            // closing the frame is required to release the GPU/CPU
            // backing buffer.
            value.close();
            continue;
          }
          this._encoder.encode(value);
        } finally {
          // ``AudioData.close()`` releases the underlying memory.
          // Per the WebCodecs spec the encoder doesn't hold a
          // reference once ``encode()`` returns.
          try { value.close(); } catch { /* already closed */ }
        }
      }
    } catch (err) {
      if (!this.stopped) {
        console.error('[recorder-wc] pump error', err);
        try { this.onError?.(err); } catch { /* never throw */ }
      }
    }
  }

  _handleEncodedChunk(chunk) {
    if (this._muxer === null) return;
    // ``chunk.timestamp`` is in microseconds per spec; convert to
    // milliseconds (matches Matroska's TimecodeScale we set).
    const timestampMs = chunk.timestamp / 1000;
    if (this._chunkBaseTimestampMs === null) {
      this._chunkBaseTimestampMs = timestampMs;
    }
    const relative = timestampMs - this._chunkBaseTimestampMs;
    // Copy the encoded payload out — ``EncodedAudioChunk.copyTo``
    // is the spec-blessed accessor; using ``.data`` directly is
    // deprecated and not available on stable Chrome.
    const payload = new Uint8Array(chunk.byteLength);
    chunk.copyTo(payload);
    try {
      this._muxer.addPacket({ packet: payload, timecodeMs: relative });
    } catch (err) {
      console.warn('[recorder-wc] muxer addPacket failed', err);
    }
  }

  _rotateMuxerSafe() {
    this._emitCurrentChunk({ isFinal: false }).catch((err) => {
      console.error('[recorder-wc] rotateMuxer failed', err);
    });
  }

  async _emitCurrentChunk({ isFinal }) {
    if (this._muxer === null || this._muxer.packetCount === 0) {
      // Nothing to emit — either we haven't received any frames
      // yet, or the previous flush already drained the muxer.
      if (!isFinal) {
        // Start a fresh muxer for the next interval so the next
        // tick has a clean slate. ``timecodeBase`` resets too.
        this._muxer = new WebmOpusMuxer({
          sampleRate: OPUS_SAMPLE_RATE,
          channels: OPUS_CHANNELS,
        });
        this._chunkBaseTimestampMs = null;
      }
      return;
    }
    const blob = this._muxer.finalize();
    const index = this.chunkIndex++;
    const handler = (async () => {
      try {
        await this.onChunk(blob, index, isFinal, this.mimeType);
      } catch (err) {
        console.error('[recorder-wc] onChunk failed', err);
      }
    })();
    this._inFlight.add(handler);
    handler.finally(() => this._inFlight.delete(handler));

    if (!isFinal) {
      // Open a fresh muxer for the next chunk. Reset the chunk
      // base timestamp so the new muxer's timecodes start at 0.
      this._muxer = new WebmOpusMuxer({
        sampleRate: OPUS_SAMPLE_RATE,
        channels: OPUS_CHANNELS,
      });
      this._chunkBaseTimestampMs = null;
    } else {
      this._muxer = null;
    }
  }
}
