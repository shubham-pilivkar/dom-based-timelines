// AudioWorklet processor — downsamples 48kHz Float32 audio frames to
// 16kHz Int16 PCM and posts each chunk to the main thread via the
// MessageChannel. The main thread forwards the ArrayBuffer over the
// WebSocket to the backend transcription relay.
//
// Why not MediaRecorder? MediaRecorder emits a WebM/EBML container
// (Opus inside). The cluster boundaries the recorder picks don't
// align with packet boundaries the STT providers expect — and every
// provider in our rotation (Soniox, Deepgram, Sarvam, AssemblyAI)
// accepts 16kHz Int16 PCM natively. PCM is the lowest common
// denominator and gives the cleanest provider integration.
//
// Why this specific worklet (not a ScriptProcessorNode)?
// ScriptProcessorNode is deprecated and runs on the main thread (UI
// jank under load). AudioWorklet runs in a dedicated render thread
// and is the modern API. Browser support is universal in the targets
// we care about.
//
// Sample-rate handling: AudioContext is created with
// ``{sampleRate: 48000}`` in the offscreen doc. That sets the global
// ``sampleRate`` constant inside the worklet. We hard-code an output
// of 16kHz because that's the universal STT input rate. If we ever
// move to a non-standard input rate (e.g. some browsers pin to
// 44100 even when 48000 is requested), the ratio adjusts automatically
// — but the output rate is fixed.
//
// Phase C — ACCURACY. Two correctness fixes over the old naive path:
//
//   1. ANTI-ALIAS. Decimating 48k→16k by picking every 3rd sample
//      folds all energy above 8 kHz back into the speech band as
//      alias noise — it sounds metallic/garbled and measurably hurts
//      WER. We now run a 2nd-order Butterworth low-pass (≈7 kHz, just
//      under the 8 kHz output Nyquist) over the input BEFORE
//      decimating, and decimate with linear interpolation instead of
//      nearest-sample. Cheap (O(1)/sample IIR) and stateful across
//      render quanta.
//
//   2. ONSET PRE-ROLL. The VAD gate drops silent blocks to save
//      bandwidth, but a word's onset ramps up through the threshold
//      over a few blocks — those sub-threshold leading blocks used to
//      be dropped, clipping "hello" → "ello". We keep a short ring of
//      the most recent RAW blocks and, on the silence→speech edge,
//      flush them first so the onset survives.
//
// VAD — Phase C. Energy-based RMS gate runs INSIDE the worklet so
// silence frames never cross the worklet→main-thread boundary. This
// cuts WS bandwidth + provider compute by 30-50% on typical meetings
// where one person is on mute for long stretches. The gate is
// intentionally simple (RMS threshold + hangover + pre-roll, no
// spectral features). Reports periodic stats via ``vad_stats``.

const TARGET_SAMPLE_RATE = 16000;
const VAD_REPORT_INTERVAL_MS = 60_000;

// Anti-alias low-pass cutoff. The decimated output Nyquist is
// 8000 Hz; 7000 Hz leaves a guard band for the filter's finite
// roll-off while preserving all speech intelligibility energy
// (telephony is band-limited to 3.4 kHz; 7 kHz is generous).
const ANTIALIAS_CUTOFF_HZ = 7000;

// Phase L2 — batch PCM chunks before crossing the worklet → main
// thread boundary. The render quantum is 128 input samples at the
// AudioContext rate (~2.67ms at 48kHz), which means without batching
// we ship ~375 messages/second/session — well below every cloud
// provider's recommended chunk window (AssemblyAI 100-250ms,
// Deepgram 20-100ms, Soniox 100-200ms). The per-message overhead
// dominates: WS framing, provider-side queueing, postMessage
// serialisation. 120ms = 1920 samples of 16kHz Int16 = 3840 bytes —
// sits comfortably inside everyone's sweet spot.
const BATCH_TARGET_MS = 120;
const BATCH_TARGET_SAMPLES = Math.round(
  TARGET_SAMPLE_RATE * BATCH_TARGET_MS / 1000,
); // 1920 samples

class PcmDownsampler extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [];
  }

  constructor(opts) {
    super();
    // Ratio of input frames consumed per output sample. At 48kHz
    // input this is 3; at 44.1kHz it's ~2.756. The fractional case
    // is handled by the accumulator below.
    this._ratio = sampleRate / TARGET_SAMPLE_RATE;
    // Residual fractional index — carries between process() calls so
    // we don't lose alignment across buffer boundaries.
    this._frac = 0.0;

    // --- Anti-alias low-pass (RBJ cookbook 2nd-order Butterworth) ---
    // Computed once from the actual input ``sampleRate``. Transposed
    // Direct Form II state (z1/z2) carries across render quanta so a
    // continuous voiced run is filtered as one stream.
    this._lpInit(ANTIALIAS_CUTOFF_HZ, sampleRate);
    // Reusable filtered-block scratch — grown on demand, never shrinks.
    this._filt = new Float32Array(256);

    // VAD state.
    const vadOpts = (opts && opts.processorOptions && opts.processorOptions.vad) || {};
    // Enable by default. Caller passes ``vad: { enabled: false }`` to
    // ship every frame (e.g. for debugging accuracy regressions).
    this._vadEnabled = vadOpts.enabled !== false;
    // RMS threshold on Float32 [-1, 1]. 0.0035 ≈ -49 dBFS — lowered
    // from 0.005 so quiet/soft-spoken talkers and far-mic speech are
    // not gated out (the onset pre-roll below makes a lower threshold
    // safe: a borderline block that opens the gate also drags its
    // predecessors in). Still well above laptop room tone.
    this._vadThreshold = typeof vadOpts.threshold === 'number'
      ? vadOpts.threshold : 0.0035;
    // Hangover frames — after the last voiced block, keep emitting
    // for this many input blocks so we don't clip the trailing
    // syllable of an utterance. At ~3ms per block (128 samples @
    // 48kHz), 200 blocks ≈ 600ms hangover.
    this._vadHangoverBlocks = typeof vadOpts.hangoverBlocks === 'number'
      ? vadOpts.hangoverBlocks : 200;
    this._vadHangoverRemaining = 0;
    // Onset pre-roll — how many of the most-recent RAW blocks to
    // retain so the silence→speech edge can replay them and keep the
    // word onset. ~56 blocks ≈ 150ms at 128 samples / 48kHz.
    this._vadPrerollBlocks = typeof vadOpts.prerollBlocks === 'number'
      ? vadOpts.prerollBlocks : 56;
    this._preroll = [];
    // Previous-block voiced state, for rising-edge detection.
    this._wasVoiced = false;

    // Stats counters. Reset after each periodic report.
    this._vadStatsTotal = 0;
    this._vadStatsDropped = 0;
    this._vadStatsLastReportTime = currentTime;

    // Phase L2 — batching buffer. Accumulates downsampled Int16
    // samples until BATCH_TARGET_SAMPLES, then ships in one
    // postMessage. Sized once at constructor time; ``_batchFill``
    // tracks the write head.
    this._batch = new Int16Array(BATCH_TARGET_SAMPLES);
    this._batchFill = 0;

    // Whether we've reported the input sample rate to the host. The
    // offscreen JS uses this to size its byte counters.
    this.port.postMessage({
      type: 'init',
      input_sample_rate: sampleRate,
      vad_enabled: this._vadEnabled,
    });

    // Listen for runtime config updates (e.g. user changed VAD
    // sensitivity via options).
    this.port.onmessage = (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'config') {
        if (typeof e.data.vadEnabled === 'boolean') {
          this._vadEnabled = e.data.vadEnabled;
        }
        if (typeof e.data.vadThreshold === 'number') {
          this._vadThreshold = e.data.vadThreshold;
        }
        if (typeof e.data.vadHangoverBlocks === 'number') {
          this._vadHangoverBlocks = e.data.vadHangoverBlocks;
        }
        if (typeof e.data.vadPrerollBlocks === 'number') {
          this._vadPrerollBlocks = e.data.vadPrerollBlocks;
        }
      }
    };
  }

  // RBJ cookbook low-pass biquad, Butterworth Q = 1/√2. Coefficients
  // are normalised by a0 so the per-sample filter is a flat add/mul.
  _lpInit(fc, fs) {
    const w0 = 2 * Math.PI * (fc / fs);
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * (1 / Math.SQRT2));
    const b0 = (1 - cosw0) / 2;
    const b1 = 1 - cosw0;
    const b2 = (1 - cosw0) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosw0;
    const a2 = 1 - alpha;
    this._b0 = b0 / a0;
    this._b1 = b1 / a0;
    this._b2 = b2 / a0;
    this._a1 = a1 / a0;
    this._a2 = a2 / a0;
    this._z1 = 0;
    this._z2 = 0;
  }

  // One filtered sample, Transposed Direct Form II. State carried in
  // _z1/_z2 across calls so a continuous run filters correctly.
  _lp(x) {
    const y = this._b0 * x + this._z1;
    this._z1 = this._b1 * x - this._a1 * y + this._z2;
    this._z2 = this._b2 * x - this._a2 * y;
    return y;
  }

  // Computes RMS amplitude of a Float32 buffer. Cheap (single pass,
  // no allocations). Returned value is in the same unit as the input
  // (~0.0 to ~1.0 for normal audio).
  _rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const s = buf[i];
      sum += s * s;
    }
    return Math.sqrt(sum / buf.length);
  }

  // Decide whether the current input block is voiced. Updates the
  // hangover counter so we keep emitting through brief silences
  // between phonemes.
  _isVoicedBlock(buf) {
    if (!this._vadEnabled) return true;
    const rms = this._rms(buf);
    if (rms >= this._vadThreshold) {
      this._vadHangoverRemaining = this._vadHangoverBlocks;
      return true;
    }
    if (this._vadHangoverRemaining > 0) {
      this._vadHangoverRemaining -= 1;
      return true;
    }
    return false;
  }

  // Keep the most-recent RAW blocks so the silence→speech edge can
  // replay them (onset recovery). Copies because the engine reuses
  // the input buffer each render quantum.
  _pushPreroll(channel) {
    if (this._vadPrerollBlocks <= 0) return;
    this._preroll.push(channel.slice());
    while (this._preroll.length > this._vadPrerollBlocks) {
      this._preroll.shift();
    }
  }

  _maybeReportVadStats() {
    if (currentTime - this._vadStatsLastReportTime < VAD_REPORT_INTERVAL_MS / 1000) {
      return;
    }
    const total = this._vadStatsTotal;
    const dropped = this._vadStatsDropped;
    this._vadStatsTotal = 0;
    this._vadStatsDropped = 0;
    this._vadStatsLastReportTime = currentTime;
    if (total === 0) return;
    this.port.postMessage({
      type: 'vad_stats',
      totalBlocks: total,
      droppedBlocks: dropped,
      droppedPct: Math.round((dropped / total) * 1000) / 10,
    });
  }

  // Anti-alias filter + linear-interpolation decimate one contiguous
  // input block, appending the resulting 16k Int16 samples to the
  // batch and flushing a postMessage when the batch is full. Pulled
  // out of process() so the onset pre-roll can run it over each
  // buffered block in order with the SAME filter + fractional-index
  // state (the pre-roll blocks are contiguous in time with the
  // current one).
  _downsampleAndBatch(channel) {
    // Filter in place into the reusable scratch (grow if a host ever
    // hands us a larger quantum than 128).
    if (this._filt.length < channel.length) {
      this._filt = new Float32Array(channel.length);
    }
    const filt = this._filt;
    for (let n = 0; n < channel.length; n += 1) {
      filt[n] = this._lp(channel[n]);
    }

    // Pre-size the output: ceil(inputFrames / ratio) is the worst
    // case; we'll trim below. Allocating once per call is fine — the
    // worklet runs every ~3ms and a few-KB Int16Array allocation is
    // well below render-quantum cost.
    const out = new Int16Array(Math.ceil(channel.length / this._ratio));
    let outIdx = 0;

    // Linear-interpolation decimation with fractional accumulator.
    // Reading the band-limited ``filt`` (not the raw input) is what
    // makes this alias-free; linear interpolation between the two
    // straddling filtered samples removes the nearest-sample jitter
    // the old path had.
    let i = this._frac;
    while (i < channel.length) {
      const i0 = i | 0;
      const frac = i - i0;
      const s0 = filt[i0] || 0;
      const s1 = (i0 + 1 < channel.length) ? filt[i0 + 1] : s0;
      // Float32 [-1, 1] → Int16 [-32768, 32767]. Clamp because some
      // sources (e.g. tabCapture with a hot tab) can briefly exceed
      // ±1 and would wrap to garbage if multiplied without bounds.
      let v = (s0 + (s1 - s0) * frac) * 32767;
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      out[outIdx++] = v;
      i += this._ratio;
    }
    // Carry the fractional remainder into the next call.
    this._frac = i - channel.length;

    // Phase L2 — append the downsampled samples to the batch buffer.
    // When the buffer fills (1920 samples = ~120ms), ship one
    // postMessage and reset.
    let srcIdx = 0;
    while (srcIdx < outIdx) {
      const remaining = BATCH_TARGET_SAMPLES - this._batchFill;
      const toCopy = Math.min(remaining, outIdx - srcIdx);
      // Use ``set`` for the bulk copy — single-call typed-array copy
      // is significantly cheaper than a per-element loop here.
      this._batch.set(out.subarray(srcIdx, srcIdx + toCopy), this._batchFill);
      this._batchFill += toCopy;
      srcIdx += toCopy;
      if (this._batchFill >= BATCH_TARGET_SAMPLES) {
        // Slice into a new ArrayBuffer for transfer — gives the
        // main thread an exclusive copy without a second alloc.
        const out16 = this._batch;
        const transferable = out16.buffer.slice(
          out16.byteOffset,
          out16.byteOffset + this._batchFill * 2,
        );
        this.port.postMessage(
          { type: 'pcm', buffer: transferable }, [transferable],
        );
        this._batchFill = 0;
      }
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    // VAD gate runs BEFORE downsampling so we skip both the
    // downsample work + the post message when the block is silent.
    this._vadStatsTotal += 1;
    const voiced = this._isVoicedBlock(channel);
    if (!voiced) {
      this._vadStatsDropped += 1;
      // Retain the raw block so a following onset can reclaim it.
      this._pushPreroll(channel);
      this._wasVoiced = false;
      this._maybeReportVadStats();
      // Returning true keeps the worklet alive even though we
      // skipped the emit.
      return true;
    }
    this._maybeReportVadStats();

    // Rising edge silence→speech: replay the buffered pre-roll blocks
    // (in time order) BEFORE the current block so the word onset that
    // ramped up through the threshold isn't clipped. They are
    // contiguous with ``channel`` so the filter + _frac state stays
    // correct across the replay.
    if (!this._wasVoiced && this._preroll.length > 0) {
      const buffered = this._preroll;
      this._preroll = [];
      for (let k = 0; k < buffered.length; k += 1) {
        this._downsampleAndBatch(buffered[k]);
      }
    } else if (this._preroll.length > 0) {
      // Still voiced — pre-roll already consumed; keep it empty.
      this._preroll.length = 0;
    }
    this._wasVoiced = true;

    this._downsampleAndBatch(channel);
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
