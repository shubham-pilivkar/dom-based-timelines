// AudioWorklet noise gate — sits between the tab GainNode and the
// MediaStreamDestination in the recording AudioMixer. Closes when the
// signal drops below a (auto-calibrated) noise-floor threshold, opens
// when speech crosses back above it. Designed to kill the constant
// "comfort noise" floor that chrome.tabCapture audio carries —
// Chrome's getUserMedia noiseSuppression constraint does NOT apply
// to tab capture (it uses the mandatory chromeMediaSource:'tab'
// shape, which bypasses WebRTC's audio processing module entirely),
// so this is the ONE pass of noise reduction the tab leg of the
// recording ever sees.
//
// Why a gate rather than another RNNoise pass:
//   * No WASM, no model file, no extra extension bundle bytes —
//     ~80 lines of DSP that fits inside the worklet itself
//   * Speech-safe by design: we don't touch the signal above the
//     threshold; we only multiply samples below it by the
//     attenuation gain. No spectral subtraction, no risk of
//     RNNoise-style "robotic" artifacts when stacked under another
//     suppressor.
//   * The recording leg already has Chrome's NS3 on the mic
//     constraint (see lib/audio-constraints.js
//     micConstraintsForRecording). Adding the gate ONLY on the tab
//     leg leaves the mic untouched and avoids the "double NS" failure
//     mode documented in arXiv 2111.11606 / Deepgram's blog.
//
// Design (per the research summary):
//   * Peak detector (not RMS) for fast transient response — RMS
//     window adds latency that fights the 5 ms lookahead.
//   * Hysteresis: open at ``thresholdDb``, close at
//     ``thresholdDb - 5 dB``. Prevents "chatter" when the signal
//     wobbles around the threshold.
//   * Attack ≈ 10 ms (fast open), release ≈ 150 ms (slow close) so
//     word offsets fade rather than gate-snap.
//   * 5 ms lookahead ring buffer so we know a transient is coming
//     before the delayed output emits its first sample of it (avoids
//     clipping word onsets).
//   * Auto-calibration: during the first 1500 ms after the first
//     audio quantum reaches process(), track the rolling 100 ms peak
//     minimum. After calibration: ``threshold = floor + 6 dB``
//     headroom. This handles the variation between a quiet home
//     office and a busy cafe — the gate adapts instead of using a
//     one-size-fits-all threshold.
//   * Attenuation is configurable: -40 dB (default) is more natural
//     than hard -∞ (gives a slight ambient bed without the
//     distracting hiss).
//
// All math runs in the audio render thread so MediaRecorder's encode
// thread is unaffected. CPU cost measured at ~0.04 ms per 128-sample
// quantum on modern hardware (Casey Primozic, cprimozic.net/blog/
// webaudio-audioworklet-optimization/), negligible for our load.

const LOOKAHEAD_SAMPLES = Math.round(0.005 * sampleRate); // 5 ms
const CALIBRATION_MS = 1500;
const CALIBRATION_SAMPLES = Math.round(CALIBRATION_MS / 1000 * sampleRate);
const FLOOR_HEADROOM_DB = 6;
const HYSTERESIS_DB = 5;
const DEFAULT_ATTACK_MS = 10;
const DEFAULT_RELEASE_MS = 150;
const DEFAULT_ATTENUATION_DB = -40;
// Floor we fall back to when the calibration period saw nothing but
// digital zero (signal never started inside the window). Picking
// -50 dBFS matches the empirical floor of typical tab-capture comfort
// noise observed in the bug-report recording (post-12s segments
// landed at -30 to -50 dBFS with a -34 dBFS quietest 100 ms window).
const FALLBACK_THRESHOLD_DB = -50;

function dbToLin(db) {
  return Math.pow(10, db / 20);
}
function linToDb(lin) {
  return lin > 0 ? 20 * Math.log10(lin) : -200;
}

class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // All thresholds in dB. Defaults are placeholders — actual
      // values come from processorOptions / postMessage; AudioParams
      // are here only for runtime tuning at the boundary (the
      // calibration result overrides them on completion).
      { name: 'threshold', defaultValue: -50, minValue: -100, maxValue: 0 },
      { name: 'attenuation', defaultValue: DEFAULT_ATTENUATION_DB, minValue: -100, maxValue: 0 },
    ];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this._attackCoef = Math.exp(-1 / ((o.attackMs ?? DEFAULT_ATTACK_MS) / 1000 * sampleRate));
    this._releaseCoef = Math.exp(-1 / ((o.releaseMs ?? DEFAULT_RELEASE_MS) / 1000 * sampleRate));
    // Envelope state — peak follower output (linear amplitude).
    this._env = 0;
    // Current gate gain (linear, 0..1). Smoothed via attack/release
    // toward either 1 (open) or attenuationLin (closed).
    this._gateGain = 1;
    // Hysteresis state — once open, requires a deeper drop before
    // closing again to suppress chatter.
    this._gateOpen = false;
    // Lookahead ring buffer (mono per channel; we hold one ring per
    // channel that comes in).
    /** @type {Float32Array[]} */
    this._delayBuffers = [];
    this._writeIdx = 0;
    // Auto-calibration: track the rolling floor over the first
    // ``CALIBRATION_SAMPLES`` samples. We use the running peak
    // minimum of 100 ms windows.
    this._calibSamplesSeen = 0;
    this._calibFloorDb = -200; // logically: "no observation yet"
    this._calibWindowPeak = 0;
    this._calibWindowSamples = 0;
    this._calibWindowLen = Math.round(0.1 * sampleRate);
    this._calibrated = false;
    // Initial threshold + attenuation in linear. AudioParam reads
    // override these per-quantum; we keep a per-quantum cache so the
    // calibration result can update them without a postMessage round
    // trip back.
    this._thresholdLin = dbToLin(o.thresholdDb ?? FALLBACK_THRESHOLD_DB);
    this._attenuationLin = dbToLin(o.attenuationDb ?? DEFAULT_ATTENUATION_DB);
    // Allow the main thread to override the calibration result OR
    // disable the gate entirely (passthrough) for test harnesses.
    this._passthrough = !!o.passthrough;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'setThreshold' && Number.isFinite(m.db)) {
        this._thresholdLin = dbToLin(m.db);
      } else if (m.type === 'setAttenuation' && Number.isFinite(m.db)) {
        this._attenuationLin = dbToLin(m.db);
      } else if (m.type === 'setPassthrough') {
        this._passthrough = !!m.value;
      }
    };
  }

  _ensureDelayBuffers(channelCount) {
    while (this._delayBuffers.length < channelCount) {
      this._delayBuffers.push(new Float32Array(LOOKAHEAD_SAMPLES));
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    // Disconnected upstream — emit silence and stay alive.
    if (!input || input.length === 0) return true;

    const channels = input.length;
    const frames = input[0].length;
    this._ensureDelayBuffers(channels);

    // Compute mono envelope from channel 0 (cheap; voice content is
    // typically near-identical across channels for tab-capture).
    const env0 = input[0];

    if (this._passthrough) {
      for (let c = 0; c < channels; c++) {
        output[c].set(input[c] || env0);
      }
      return true;
    }

    const threshLin = this._thresholdLin;
    const closeLin = threshLin * dbToLin(-HYSTERESIS_DB);
    const attenLin = this._attenuationLin;
    const attCoef = this._attackCoef;
    const relCoef = this._releaseCoef;

    for (let i = 0; i < frames; i++) {
      const x = Math.abs(env0[i]);
      // Peak follower — exponential one-pole. Fast attack to track
      // transients up, slow release to track decays down.
      const coef = x > this._env ? attCoef : relCoef;
      this._env = x + coef * (this._env - x);

      // Calibration — track the floor over the first 1.5 s.
      if (!this._calibrated) {
        if (x > this._calibWindowPeak) this._calibWindowPeak = x;
        this._calibWindowSamples++;
        if (this._calibWindowSamples >= this._calibWindowLen) {
          // End of a 100 ms window — fold its peak into the running
          // minimum. Skip pure-zero windows (silence padding before
          // the upstream started flowing) so they don't pin the
          // floor at -infinity.
          if (this._calibWindowPeak > 1e-7) {
            const winDb = linToDb(this._calibWindowPeak);
            if (this._calibFloorDb === -200 || winDb < this._calibFloorDb) {
              this._calibFloorDb = winDb;
            }
          }
          this._calibWindowPeak = 0;
          this._calibWindowSamples = 0;
        }
        this._calibSamplesSeen++;
        if (this._calibSamplesSeen >= CALIBRATION_SAMPLES) {
          this._calibrated = true;
          const floor = this._calibFloorDb === -200
            ? FALLBACK_THRESHOLD_DB
            : this._calibFloorDb + FLOOR_HEADROOM_DB;
          this._thresholdLin = dbToLin(floor);
          this.port.postMessage({ type: 'calibrated', thresholdDb: floor });
        }
      }

      // Hysteresis: open at threshold, close only after the envelope
      // drops below threshold - 5 dB.
      if (this._gateOpen) {
        if (this._env < closeLin) this._gateOpen = false;
      } else if (this._env > threshLin) {
        this._gateOpen = true;
      }
      const targetGain = this._gateOpen ? 1 : attenLin;
      // Smooth the gain change with the same one-pole shape so a
      // gate transition fades rather than snaps.
      const gainCoef = targetGain > this._gateGain ? attCoef : relCoef;
      this._gateGain = targetGain + gainCoef * (this._gateGain - targetGain);

      // Lookahead — for each channel, write the incoming sample to
      // the ring and read out the sample that was written
      // LOOKAHEAD_SAMPLES samples ago. The gain we just computed is
      // applied to the DELAYED sample, so the gate "knows" a
      // transient is coming before that sample reaches output.
      const readIdx = this._writeIdx; // ring is power-of-implicit:
      // the cell we're about to overwrite is the OLDEST cell, i.e.
      // LOOKAHEAD_SAMPLES old.
      for (let c = 0; c < channels; c++) {
        const inSample = (input[c] || env0)[i];
        const delayed = this._delayBuffers[c][readIdx];
        this._delayBuffers[c][readIdx] = inSample;
        output[c][i] = delayed * this._gateGain;
      }
      this._writeIdx = (this._writeIdx + 1) % LOOKAHEAD_SAMPLES;
    }

    return true;
  }
}

registerProcessor('mm-noise-gate', NoiseGateProcessor);
