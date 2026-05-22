import {
  AUDIO_ONLY_MIME_TYPES,
  CHUNK_INTERVAL_MS,
  DEFAULT_AUDIO_BITRATE,
  DEFAULT_VIDEO_BITRATE,
  PREFERRED_MIME_TYPES,
} from '../constants.js';

/**
 * Pick the first MIME type the browser supports from `candidates`.
 * @param {string[]} candidates
 * @returns {string}
 */
function pickMimeType(candidates) {
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

/**
 * Owns a single MediaRecorder + the chunk-index counter. Each
 * `dataavailable` blob is forwarded to `onChunk` along with its
 * monotonically increasing index and an `isFinal` flag.
 *
 * `stop()` accepts a `final` option:
 *   - true  (default): the last chunk is marked is_final=true so the
 *     SW can call /finalize on the meeting.
 *   - false: the last chunk is NOT final — used by the AudioContext
 *     rotation path so the meeting stays open while a fresh recorder
 *     takes over with the next chunkIndex.
 *
 * `stop()` also awaits any in-flight `onChunk` handlers before
 * resolving, so that callers reading `nextIndex` immediately after
 * stop() observe a quiesced state (no race with persistence).
 */
export class Recorder {
  /**
   * @param {{
   *   stream: MediaStream,
   *   onChunk: (blob: Blob, index: number, isFinal: boolean, mimeType: string) => Promise<void>,
   *   onError?: (err: unknown) => void,
   *   startIndex?: number,
   *   videoBitsPerSecond?: number,
   *   audioBitsPerSecond?: number,
   *   audioOnly?: boolean,
   * }} args
   */
  constructor({
    stream,
    onChunk,
    onError,
    startIndex = 0,
    videoBitsPerSecond = DEFAULT_VIDEO_BITRATE,
    audioBitsPerSecond = DEFAULT_AUDIO_BITRATE,
    audioOnly = false,
  }) {
    this.stream = stream;
    this.onChunk = onChunk;
    this.onError = onError;
    this.chunkIndex = startIndex;
    this.audioOnly = audioOnly;
    // In audio-only mode the recording stream contains no video tracks, so
    // we pick an audio/* mime and skip the video bitrate option entirely
    // (passing it with no video track makes some Chromium builds warn).
    this.mimeType = pickMimeType(audioOnly ? AUDIO_ONLY_MIME_TYPES : PREFERRED_MIME_TYPES);
    /** @type {MediaRecorderOptions} */
    const opts = {
      mimeType: this.mimeType || undefined,
      audioBitsPerSecond,
    };
    if (!audioOnly) opts.videoBitsPerSecond = videoBitsPerSecond;
    this.recorder = new MediaRecorder(stream, opts);

    this.stopped = false;
    this._stopMarksFinal = true;
    this._stopResolve = null;
    /** @type {Set<Promise<void>>} */
    this._inFlight = new Set();

    this.recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      const isFinal =
        this.stopped &&
        this.recorder.state === 'inactive' &&
        this._stopMarksFinal;
      const index = this.chunkIndex++;
      const handler = (async () => {
        try {
          await this.onChunk(event.data, index, isFinal, this.mimeType);
        } catch (err) {
          // Persistence failure: surface, but don't kill the recorder —
          // the SW + IndexedDB layer will retry on reconnect.
          console.error('[recorder] onChunk handler failed', err);
        }
      })();
      this._inFlight.add(handler);
      handler.finally(() => this._inFlight.delete(handler));
    };

    this.recorder.onstop = () => {
      if (this._stopResolve) {
        const r = this._stopResolve;
        this._stopResolve = null;
        r();
      }
    };

    this.recorder.onerror = (event) => {
      console.error('[recorder] MediaRecorder error', event);
      // Surface the error so the offscreen doc can promote it to the SW
      // (and the SW to RecordingState.ERROR). Without this, a silent
      // MediaRecorder failure would just stop producing chunks while the
      // UI continues to show "recording" — worst-case data loss.
      const err = event && /** @type {any} */ (event).error
        ? /** @type {any} */ (event).error
        : new Error('MediaRecorder_error');
      try { this.onError?.(err); } catch { /* never throw out of an event */ }
    };
  }

  start() {
    this.recorder.start(CHUNK_INTERVAL_MS);
  }

  /** Pause recording — used by the back-pressure path. No-op if already paused/inactive. */
  pause() {
    if (this.recorder.state === 'recording') this.recorder.pause();
  }

  /** Resume from a back-pressure pause. No-op if not paused. */
  resume() {
    if (this.recorder.state === 'paused') this.recorder.resume();
  }

  get state() {
    return this.recorder.state;
  }

  /**
   * @param {{ final?: boolean }} [opts]
   *   final=true (default): last chunk is is_final=true.
   *   final=false: last chunk is NOT final (used by the rotate path).
   */
  async stop({ final = true } = {}) {
    if (this.recorder.state === 'inactive') {
      // Still drain any handlers queued before this call.
      await Promise.allSettled([...this._inFlight]);
      return;
    }
    this.stopped = true;
    this._stopMarksFinal = final;
    const stopped = new Promise((resolve) => {
      this._stopResolve = resolve;
    });
    this.recorder.requestData();
    this.recorder.stop();
    await stopped;
    // Wait for every async onChunk handler to settle so `nextIndex`
    // reflects fully-persisted state.
    await Promise.allSettled([...this._inFlight]);
  }

  get nextIndex() {
    return this.chunkIndex;
  }
}
