// Mixes the captured tab audio track and the (optional) microphone track
// down to a single MediaStream. Each input runs through its own GainNode
// so the user can re-balance from the options page without touching the
// recorder.
//
// The class also owns a hidden <audio> element wired to the raw tab audio
// stream — chrome.tabCapture mutes the original tab while it's being
// captured, so without this the user hears silence in the meeting. If
// Chrome's autoplay policy rejects the play() call, we surface that via
// the `onMonitorBlocked` callback so the popup can offer a manual
// "Restore" affordance bound to a real user gesture.

export class AudioMixer {
  /**
   * @param {{
   *   tabAudioStream: MediaStream,
   *   micStream: MediaStream | null,
   *   micGain: number,
   *   tabGain: number,
   *   monitorEl: HTMLAudioElement,
   *   onMonitorBlocked?: (err: unknown) => void,
   *   onMonitorRestored?: () => void,
   *   monitorEnabled?: boolean,
   * }} args
   */
  constructor({
    tabAudioStream,
    micStream,
    micGain,
    tabGain,
    monitorEl,
    onMonitorBlocked,
    onMonitorRestored,
    // The monitor exists ONLY because chrome.tabCapture mutes the
    // source tab — playing the captured audio back is what lets the
    // user still hear the meeting. desktopCapture/system audio is NOT
    // muted at the source, so monitoring it would create a speaker→
    // capture echo loop. Callers on the screen path pass false.
    // Default true preserves the tab-capture behaviour exactly.
    monitorEnabled = true,
  }) {
    this.tabAudioStream = tabAudioStream;
    this.micStream = micStream;
    this.monitorEl = monitorEl;
    this.onMonitorBlocked = onMonitorBlocked;
    this.onMonitorRestored = onMonitorRestored;
    this.monitorEnabled = monitorEnabled;
    this.monitorBlocked = false;

    // Pin the context to 48 kHz so the destination matches the
    // recording mic's requested rate (lib/audio-constraints.js
    // ``micConstraintsForRecording`` asks for 48 kHz). Without an
    // explicit rate, Chrome picks the system default — usually
    // 44.1 kHz on macOS or 48 kHz on Linux/Windows; matching the
    // mic eliminates one resample pass and avoids subtle pitch
    // artefacts on the saved file. ``latencyHint: 'playback'`` tells
    // Chrome we're not building a synth — it can use a larger render
    // buffer (lower CPU) since A/V sync is what we care about, not
    // tap-to-sound latency.
    this.context = new AudioContext({
      sampleRate: 48000,
      latencyHint: 'playback',
    });
    this.destination = this.context.createMediaStreamDestination();

    this.tabSource = this.context.createMediaStreamSource(tabAudioStream);
    this.tabGainNode = this.context.createGain();
    this.tabGainNode.gain.value = tabGain;
    // The noise-gate worklet is OPTIONAL — it's inserted between
    // ``tabGainNode`` and ``destination`` once the worklet module has
    // loaded (see _attachTabNoiseGate). Until then we pre-wire a
    // direct passthrough so audio flows immediately and the recorder
    // never sees a gap. _attachTabNoiseGate swaps the connection
    // atomically: disconnect(direct) + connect(gate) + gate→destination.
    //
    // Why a gate ONLY on the tab branch (not the mic):
    //   * chrome.tabCapture bypasses every standard MediaTrackConstraint
    //     including noiseSuppression — verified against the WebRTC
    //     APM docs + W3C mediacapture-main #457. So the tab leg is the
    //     ONE path that has no noise reduction at all today; that's
    //     where the "constant low-level audio throughout the recording"
    //     symptom originates (the meeting platform's comfort noise +
    //     remote participants' unsuppressed mic ambience).
    //   * The mic leg already gets Chrome's NS3 via
    //     micConstraintsForRecording. Stacking a second suppressor on
    //     top would risk the "robotic" double-NS artifacts documented
    //     in arXiv 2111.11606 + Deepgram's noise-reduction-paradox
    //     post — not worth it.
    this.tabGainNode.connect(this.destination);
    this._tabNoiseGate = null;
    this._tabGateDirectlyConnected = true;

    // Parallel tap for the VU meter. AnalyserNode is passive — it
    // observes the signal but doesn't alter the audio path that reaches
    // the destination. fftSize=256 gives 128 time-domain samples, which
    // is plenty for an RMS calculation.
    //
    // Tap AFTER the gain node (NOT after the source). The recommended
    // Web Audio chain is ``Source → GainNode → AnalyserNode → out`` so
    // the meter reflects what's actually going to the recorder/STT.
    // Tapping pre-gain meant ``setMicGain(0)`` (in-meeting mute → see
    // OFFSCREEN_MIC_MUTE handler) silenced the recording but the VU
    // meter still moved — confusing UX that suggested the recording
    // was still picking up audio. Post-gain placement makes mute
    // zero the meter immediately, matching reality.
    this.tabAnalyser = this.context.createAnalyser();
    this.tabAnalyser.fftSize = 256;
    this.tabGainNode.connect(this.tabAnalyser);

    if (micStream) {
      this.micSource = this.context.createMediaStreamSource(micStream);
      this.micGainNode = this.context.createGain();
      this.micGainNode.gain.value = micGain;
      this.micSource.connect(this.micGainNode).connect(this.destination);
      this.micAnalyser = this.context.createAnalyser();
      this.micAnalyser.fftSize = 256;
      this.micGainNode.connect(this.micAnalyser);
    } else {
      this.micSource = null;
      this.micGainNode = null;
      this.micAnalyser = null;
    }

    // Reusable buffer — avoids allocating a Uint8Array on every tick.
    this._levelBuf = new Uint8Array(this.tabAnalyser.frequencyBinCount);

    // An AudioContext constructed in the offscreen document starts
    // SUSPENDED (no user activation). While suspended it doesn't pull
    // from the MediaStream sources, so (a) the AnalyserNodes read flat
    // silence → the popup VU meters never move, and (b) the
    // MediaStreamDestination feeding the recorder is silent. Resume it
    // (offscreen docs created with the USER_MEDIA reason are permitted
    // to run audio). Best-effort + re-checked on retryMonitor.
    // Kick the resume in the constructor, but callers MUST await
    // ``ready()`` before starting the MediaRecorder — see below.
    //
    // Run the worklet load IN PARALLEL with the resume. ``Promise.all``
    // here is intentional: the resume gates audio flowing through the
    // graph, the worklet load gates whether that audio is gated. If
    // the worklet fails (404, CSP, OOM), recording proceeds with the
    // direct passthrough — gating is a quality knob, not a safety
    // requirement.
    this._readyPromise = Promise.all([
      this._resumeContext(),
      this._attachTabNoiseGate(),
    ]);
    void this._attachMonitor();
  }

  async _resumeContext() {
    try {
      if (this.context.state === 'suspended') {
        await this.context.resume();
      }
    } catch {
      /* resume can reject without activation; meters/monitor retry */
    }
  }

  /**
   * Insert the noise-gate AudioWorkletNode between ``tabGainNode``
   * and ``destination``. Best-effort — a failure here leaves the
   * direct passthrough wired (audio still flows, just without the
   * gate). Idempotent: calling twice no-ops once the gate is live.
   *
   * Worklet ships in /public/noise-gate-worklet.js → emitted verbatim
   * to ``noise-gate-worklet.js`` at the extension root (matches the
   * existing transcribe-worklet.js convention; crxjs/Vite can't
   * statically see the chrome.runtime.getURL string, so the asset
   * MUST live in /public/).
   */
  async _attachTabNoiseGate() {
    if (this._tabNoiseGate) return;
    // Closed-context guard — if dispose() ran before the worklet
    // module finished loading, the late attach below would construct
    // an AudioWorkletNode against a torn-down context (Chrome throws
    // InvalidStateError; we'd swallow it in the catch but leak a node
    // handle). Bail early so dispose() is the cheap path.
    if (this.context.state === 'closed') return;
    let getURL = null;
    try {
      getURL = (typeof chrome !== 'undefined'
        && chrome.runtime && typeof chrome.runtime.getURL === 'function')
        ? chrome.runtime.getURL.bind(chrome.runtime)
        : null;
    } catch { /* test environments */ }
    if (!getURL) return; // not in an extension context — leave passthrough
    try {
      await this.context.audioWorklet.addModule(getURL('noise-gate-worklet.js'));
      // Re-check after the async addModule resolves — dispose() may
      // have closed the context while the module was loading.
      if (this.context.state === 'closed') return;
      const gate = new AudioWorkletNode(this.context, 'mm-noise-gate', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      // Re-wire: disconnect the direct tabGain→destination edge we
      // pre-wired in the constructor, then route tabGain → gate →
      // destination. AnalyserNode tap stays on tabGainNode (pre-gate)
      // — VU meters reflect the GAIN-staged level, not the gated
      // output, so the user still sees that the source is alive even
      // when the gate is closed during silence.
      //
      // The disconnect→connect→connect window is one audio quantum or
      // two (a couple of ms at 48 kHz). Not strictly atomic, but
      // imperceptible in practice — the recorder fills the gap with
      // silence which then ends up encoded as comfort noise inside
      // Opus. Recording correctness is preserved.
      try { this.tabGainNode.disconnect(this.destination); }
      catch { /* already disconnected */ }
      this.tabGainNode.connect(gate);
      gate.connect(this.destination);
      this._tabNoiseGate = gate;
      this._tabGateDirectlyConnected = false;
    } catch (err) {
      // Module load / node construct failed. Leave the direct
      // passthrough in place — recording remains correct, just
      // ungated. Surface for diagnostics without throwing.
      console.warn('[audio-mixer] noise gate unavailable; falling back to passthrough', err);
    }
  }

  /**
   * Resolve once the AudioContext is actually RUNNING (or we've waited
   * long enough). This is A/V-sync-critical: ``audioTrack`` comes from
   * a MediaStreamDestination fed by this context. While the context is
   * suspended it emits SILENCE, so if the MediaRecorder starts before
   * the context is running, the final file has video from frame 0 but
   * audio that only begins once the context resumes — i.e. audio lags
   * video for the whole recording, and the speaker timeline (anchored
   * at recorder start) is offset by the same gap. Awaiting this before
   * recorder.start() removes that start offset at the source.
   *
   * Bounded so a context that can't resume (no activation) never hangs
   * the start path — we proceed after the cap rather than block; the
   * monitor/meter retry path still recovers it.
   */
  async ready({ timeoutMs = 1500 } = {}) {
    try { await this._readyPromise; } catch { /* fall through to poll */ }
    const deadline = Date.now() + timeoutMs;
    while (this.context.state !== 'running' && Date.now() < deadline) {
      // A second resume() attempt is cheap and often what finally
      // flips an offscreen context to running.
      this._resumeContext();
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.context.state === 'running';
  }

  /**
   * Compute current RMS levels (0..1) for the tab and mic sources.
   * Returns null for mic when no microphone is connected.
   *
   * @returns {{ tab: number, mic: number | null }}
   */
  getLevels() {
    return {
      tab: this._readLevel(this.tabAnalyser),
      mic: this.micAnalyser ? this._readLevel(this.micAnalyser) : null,
    };
  }

  _readLevel(analyser) {
    analyser.getByteTimeDomainData(this._levelBuf);
    let sum = 0;
    for (let i = 0; i < this._levelBuf.length; i++) {
      // Center on 128 (silence) and normalise to [-1, 1].
      const v = (this._levelBuf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this._levelBuf.length);
    // Scale up — typical conversational speech RMS is ~0.05–0.15. The
    // Math.min cap keeps loud peaks pegged at 1 instead of overshooting.
    return Math.min(1, rms * 3);
  }

  async _attachMonitor() {
    if (!this.monitorEnabled) {
      // Screen/system-audio path: deliberately no playback (would
      // echo). Treat as "not blocked" so the popup never shows a
      // spurious "audio monitor blocked" affordance.
      this.monitorBlocked = false;
      return;
    }
    this.monitorEl.srcObject = this.tabAudioStream;
    try {
      await this.monitorEl.play();
      if (this.monitorBlocked) {
        this.monitorBlocked = false;
        this.onMonitorRestored?.();
      }
    } catch (err) {
      this.monitorBlocked = true;
      this.onMonitorBlocked?.(err);
    }
  }

  /**
   * Re-attempt monitor playback. Call this from a context that carries
   * a fresh user activation (e.g. a popup button click relayed through
   * the SW). Returns true on success.
   */
  async retryMonitor() {
    // This call carries a fresh user activation (popup button →
    // SW → offscreen), which is exactly what an autoplay-suspended
    // AudioContext needs to actually resume — so retry that too.
    await this._resumeContext();
    await this._attachMonitor();
    // Also re-attempt the noise-gate attach if the initial load
    // failed (e.g. transient module fetch error). Without this, a
    // single startup blip would leave the session permanently on the
    // direct passthrough — defeating the entire reason the user hit
    // Retry. _attachTabNoiseGate is idempotent: if the gate is
    // already in place it no-ops, so this is safe to call every
    // time.
    if (!this._tabNoiseGate) await this._attachTabNoiseGate();
    return !this.monitorBlocked;
  }

  /** @returns {MediaStreamTrack} */
  get audioTrack() {
    return this.destination.stream.getAudioTracks()[0];
  }

  /** @param {number} value */
  setMicGain(value) {
    if (this.micGainNode) this.micGainNode.gain.value = value;
  }

  /** @param {number} value */
  setTabGain(value) {
    this.tabGainNode.gain.value = value;
  }

  async dispose() {
    try {
      this.monitorEl.pause();
      this.monitorEl.srcObject = null;
    } catch {
      /* monitor element may already be detached */
    }
    try {
      this.tabSource.disconnect();
      this.tabGainNode.disconnect();
      this.tabAnalyser.disconnect();
      if (this._tabNoiseGate) this._tabNoiseGate.disconnect();
      if (this.micSource) this.micSource.disconnect();
      if (this.micGainNode) this.micGainNode.disconnect();
      if (this.micAnalyser) this.micAnalyser.disconnect();
    } catch {
      /* already disconnected */
    }
    if (this.context.state !== 'closed') {
      await this.context.close();
    }
  }
}
