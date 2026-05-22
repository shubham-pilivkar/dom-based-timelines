import { describe, expect, it, vi } from 'vitest';
import { AudioMixer } from '../src/lib/audio-mixer.js';

function fakeStream() {
  return { getAudioTracks: () => [{ id: 't' }] };
}

function fakeAudioEl({ playResolves = true } = {}) {
  const el = document.createElement('audio');
  // happy-dom rejects non-MediaStream srcObject values; shadow the
  // prototype setter so the mixer can assign our fake stream.
  Object.defineProperty(el, 'srcObject', {
    get() {
      return this._srcObject;
    },
    set(v) {
      this._srcObject = v;
    },
    configurable: true,
  });
  el.play = playResolves
    ? vi.fn().mockResolvedValue(undefined)
    : vi.fn().mockRejectedValue(new Error('autoplay_blocked'));
  return el;
}

// Wait for the fired-and-forgotten _attachMonitor() chain to settle.
async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('AudioMixer', () => {
  it('Phase 4 — pins AudioContext to 48 kHz so the destination matches the recording mic', () => {
    // The recording mic (lib/audio-constraints.js
    // micConstraintsForRecording) requests sampleRate:48000. The mixer
    // must construct its AudioContext at the same rate; otherwise the
    // browser inserts a resample stage between the source and the
    // destination, causing subtle pitch artifacts in the saved file.
    const calls = [];
    const Original = globalThis.AudioContext;
    globalThis.AudioContext = function PatchedAudioContext(opts) {
      calls.push(opts);
      return new Original(opts);
    };
    try {
      const mixer = new AudioMixer({
        tabAudioStream: fakeStream(),
        micStream: fakeStream(),
        micGain: 1,
        tabGain: 1,
        monitorEl: fakeAudioEl(),
      });
      void mixer;
      expect(calls.length).toBe(1);
      expect(calls[0]).toMatchObject({ sampleRate: 48000 });
    } finally {
      globalThis.AudioContext = Original;
    }
  });

  it('applies initial mic and tab gains and exposes a mixed audio track', () => {
    const mixer = new AudioMixer({
      tabAudioStream: fakeStream(),
      micStream: fakeStream(),
      micGain: 0.5,
      tabGain: 0.8,
      monitorEl: fakeAudioEl(),
    });

    expect(mixer.tabGainNode.gain.value).toBe(0.8);
    expect(mixer.micGainNode.gain.value).toBe(0.5);
    expect(mixer.audioTrack).toMatchObject({ id: 'mixed-audio' });
  });

  it('setMicGain / setTabGain mutate the live gain nodes', () => {
    const mixer = new AudioMixer({
      tabAudioStream: fakeStream(),
      micStream: fakeStream(),
      micGain: 1,
      tabGain: 1,
      monitorEl: fakeAudioEl(),
    });

    mixer.setMicGain(0.25);
    mixer.setTabGain(1.75);
    expect(mixer.micGainNode.gain.value).toBe(0.25);
    expect(mixer.tabGainNode.gain.value).toBe(1.75);
  });

  it('skips mic wiring entirely when micStream is null', () => {
    const mixer = new AudioMixer({
      tabAudioStream: fakeStream(),
      micStream: null,
      micGain: 1,
      tabGain: 1,
      monitorEl: fakeAudioEl(),
    });

    expect(mixer.micSource).toBeNull();
    expect(mixer.micGainNode).toBeNull();
    // setMicGain is a no-op rather than a throw.
    expect(() => mixer.setMicGain(0.5)).not.toThrow();
  });

  it('Bug 16.1 — VU meter analysers tap AFTER their gain nodes (not the source)', () => {
    // The recommended Web Audio chain is
    // ``Source → GainNode → AnalyserNode``, so muting via
    // ``setMicGain(0)`` (in-meeting mic mute) zeroes the meter too.
    // Tapping pre-gain meant a muted mic still showed bars in the
    // popup / control-window VU meters — confusing UX that suggested
    // audio was still being captured. Post-gain placement makes the
    // meter mirror what's actually going to the recorder/STT.
    const connectCalls = [];
    const origCreateGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function patchedCreateGain() {
      const g = origCreateGain.call(this);
      const _id = `gain-${connectCalls.length}`;
      g._tag = _id;
      const origConnect = g.connect.bind(g);
      g.connect = function trackedConnect(next) {
        connectCalls.push({ from: _id, to: next });
        return origConnect(next);
      };
      return g;
    };
    try {
      const mixer = new AudioMixer({
        tabAudioStream: fakeStream(),
        micStream: fakeStream(),
        micGain: 1,
        tabGain: 1,
        monitorEl: fakeAudioEl(),
      });
      // Both analysers must be reachable from the corresponding GAIN
      // node's outbound connections, not the source.
      const tabGainConnections = connectCalls.filter(
        (c) => c.from === mixer.tabGainNode._tag,
      ).map((c) => c.to);
      const micGainConnections = connectCalls.filter(
        (c) => c.from === mixer.micGainNode._tag,
      ).map((c) => c.to);
      expect(tabGainConnections).toContain(mixer.tabAnalyser);
      expect(micGainConnections).toContain(mixer.micAnalyser);
      // And each gain should still be feeding the destination too.
      expect(tabGainConnections).toContain(mixer.destination);
      expect(micGainConnections).toContain(mixer.destination);
    } finally {
      AudioContext.prototype.createGain = origCreateGain;
    }
  });

  it('marks monitorBlocked and fires onMonitorBlocked when play() rejects', async () => {
    const onMonitorBlocked = vi.fn();
    const mixer = new AudioMixer({
      tabAudioStream: fakeStream(),
      micStream: null,
      micGain: 1,
      tabGain: 1,
      monitorEl: fakeAudioEl({ playResolves: false }),
      onMonitorBlocked,
    });

    await flushMicrotasks();

    expect(mixer.monitorBlocked).toBe(true);
    expect(onMonitorBlocked).toHaveBeenCalledTimes(1);
  });

  it('attempts to load the noise-gate worklet from the extension root', async () => {
    // The gate inserts between tabGainNode and destination to kill the
    // constant low-level noise that chrome.tabCapture (which bypasses
    // getUserMedia's noiseSuppression constraint) lets through. Wire
    // contract: the mixer must (a) request the worklet from the
    // extension root via chrome.runtime.getURL, (b) construct an
    // AudioWorkletNode named 'mm-noise-gate', (c) leave a direct
    // passthrough wired until the gate is live so audio never gaps.
    const addModule = vi.fn(async () => {});
    const workletNodeCtor = vi.fn(function NoiseGateNode() {
      this.connect = vi.fn();
      this.disconnect = vi.fn();
    });
    const origAWN = globalThis.AudioWorkletNode;
    const origGetURL = chrome.runtime.getURL;
    chrome.runtime.getURL = vi.fn((p) => `chrome-extension://id/${p}`);
    globalThis.AudioWorkletNode = workletNodeCtor;
    // Patch the AudioContext to expose an audioWorklet shim.
    const origCreate = AudioContext.prototype.createMediaStreamDestination;
    AudioContext.prototype.createMediaStreamDestination = function patched() {
      const d = origCreate.call(this);
      if (!this.audioWorklet) this.audioWorklet = { addModule };
      return d;
    };
    try {
      const mixer = new AudioMixer({
        tabAudioStream: fakeStream(),
        micStream: null,
        micGain: 1,
        tabGain: 1,
        monitorEl: fakeAudioEl(),
      });
      // Direct passthrough is wired synchronously in the constructor.
      expect(mixer._tabGateDirectlyConnected).toBe(true);
      await mixer.ready();
      // After ready(): the worklet was loaded from the right path.
      expect(addModule).toHaveBeenCalledWith(
        'chrome-extension://id/noise-gate-worklet.js',
      );
      // …and an AudioWorkletNode of the right name was constructed.
      expect(workletNodeCtor).toHaveBeenCalledTimes(1);
      const [ctx, name] = workletNodeCtor.mock.calls[0];
      expect(name).toBe('mm-noise-gate');
      expect(ctx).toBe(mixer.context);
      // The gate is now the in-graph node.
      expect(mixer._tabNoiseGate).toBeTruthy();
      expect(mixer._tabGateDirectlyConnected).toBe(false);
    } finally {
      globalThis.AudioWorkletNode = origAWN;
      chrome.runtime.getURL = origGetURL;
      AudioContext.prototype.createMediaStreamDestination = origCreate;
    }
  });

  it('falls back to direct tab→destination passthrough when the worklet fails to load', async () => {
    // Recording correctness > gating. If the worklet 404s or the CSP
    // blocks the load, we MUST leave the pre-wired direct edge intact
    // and continue. This is the safety property that lets us add the
    // gate without risking the recording pipeline.
    const addModule = vi.fn(async () => {
      throw new Error('audio_worklet_load_failed');
    });
    const workletNodeCtor = vi.fn();
    const origAWN = globalThis.AudioWorkletNode;
    const origGetURL = chrome.runtime.getURL;
    chrome.runtime.getURL = vi.fn((p) => `chrome-extension://id/${p}`);
    globalThis.AudioWorkletNode = workletNodeCtor;
    const origCreate = AudioContext.prototype.createMediaStreamDestination;
    AudioContext.prototype.createMediaStreamDestination = function patched() {
      const d = origCreate.call(this);
      if (!this.audioWorklet) this.audioWorklet = { addModule };
      return d;
    };
    const origWarn = console.warn;
    console.warn = vi.fn();
    try {
      const mixer = new AudioMixer({
        tabAudioStream: fakeStream(),
        micStream: null,
        micGain: 1,
        tabGain: 1,
        monitorEl: fakeAudioEl(),
      });
      await mixer.ready();
      expect(mixer._tabNoiseGate).toBeNull();
      expect(mixer._tabGateDirectlyConnected).toBe(true);
      // No worklet node should have been constructed when addModule
      // rejected.
      expect(workletNodeCtor).not.toHaveBeenCalled();
    } finally {
      globalThis.AudioWorkletNode = origAWN;
      chrome.runtime.getURL = origGetURL;
      AudioContext.prototype.createMediaStreamDestination = origCreate;
      console.warn = origWarn;
    }
  });

  it('retryMonitor retries the noise gate when the initial attach failed', async () => {
    // Transient module-load failure (network blip, race with offscreen
    // teardown) must not leave the session permanently ungated. The
    // popup's "Restore" button is the user's recovery path for both
    // monitor playback AND audio quality — retry both there.
    let shouldFail = true;
    const addModule = vi.fn(async () => {
      if (shouldFail) throw new Error('transient_module_404');
    });
    const workletNodeCtor = vi.fn(function NoiseGateNode() {
      this.connect = vi.fn();
      this.disconnect = vi.fn();
    });
    const origAWN = globalThis.AudioWorkletNode;
    const origGetURL = chrome.runtime.getURL;
    chrome.runtime.getURL = vi.fn((p) => `chrome-extension://id/${p}`);
    globalThis.AudioWorkletNode = workletNodeCtor;
    const origCreate = AudioContext.prototype.createMediaStreamDestination;
    AudioContext.prototype.createMediaStreamDestination = function patched() {
      const d = origCreate.call(this);
      if (!this.audioWorklet) this.audioWorklet = { addModule };
      return d;
    };
    const origWarn = console.warn;
    console.warn = vi.fn();
    try {
      const mixer = new AudioMixer({
        tabAudioStream: fakeStream(),
        micStream: null,
        micGain: 1,
        tabGain: 1,
        monitorEl: fakeAudioEl(),
      });
      await mixer.ready();
      expect(mixer._tabNoiseGate).toBeNull();
      expect(workletNodeCtor).not.toHaveBeenCalled();
      // Network/Chrome recovered — next addModule succeeds.
      shouldFail = false;
      await mixer.retryMonitor();
      expect(workletNodeCtor).toHaveBeenCalledTimes(1);
      expect(mixer._tabNoiseGate).toBeTruthy();
      expect(mixer._tabGateDirectlyConnected).toBe(false);
    } finally {
      globalThis.AudioWorkletNode = origAWN;
      chrome.runtime.getURL = origGetURL;
      AudioContext.prototype.createMediaStreamDestination = origCreate;
      console.warn = origWarn;
    }
  });

  it('_attachTabNoiseGate bails out when the context is already closed (dispose race)', async () => {
    // dispose() can run while the worklet module is still loading;
    // a late attach to a closed context would either throw an
    // InvalidStateError (Chrome) or leak a half-wired AudioWorkletNode.
    // The pre-check guards against both.
    const addModule = vi.fn(async () => {});
    const workletNodeCtor = vi.fn();
    const origAWN = globalThis.AudioWorkletNode;
    const origGetURL = chrome.runtime.getURL;
    chrome.runtime.getURL = vi.fn((p) => `chrome-extension://id/${p}`);
    globalThis.AudioWorkletNode = workletNodeCtor;
    const origCreate = AudioContext.prototype.createMediaStreamDestination;
    AudioContext.prototype.createMediaStreamDestination = function patched() {
      const d = origCreate.call(this);
      if (!this.audioWorklet) this.audioWorklet = { addModule };
      return d;
    };
    try {
      const mixer = new AudioMixer({
        tabAudioStream: fakeStream(),
        micStream: null,
        micGain: 1,
        tabGain: 1,
        monitorEl: fakeAudioEl(),
      });
      // Close the context before the initial attach finishes —
      // simulates dispose() racing the worklet module load.
      await mixer.context.close();
      await mixer.ready();
      // Module load may have started OR been skipped depending on
      // timing. The invariant is: NO AudioWorkletNode is constructed
      // against the closed context.
      expect(workletNodeCtor).not.toHaveBeenCalled();
      expect(mixer._tabNoiseGate).toBeNull();
    } finally {
      globalThis.AudioWorkletNode = origAWN;
      chrome.runtime.getURL = origGetURL;
      AudioContext.prototype.createMediaStreamDestination = origCreate;
    }
  });

  it('skips the worklet entirely when chrome.runtime.getURL is unavailable (test env)', async () => {
    // Non-extension contexts (vitest's normal environment without the
    // chrome.runtime stub, e2e harnesses, etc.) should not throw — the
    // mixer must detect "no extension" and stay on the direct edge.
    const origGetURL = chrome.runtime.getURL;
    delete chrome.runtime.getURL;
    try {
      const mixer = new AudioMixer({
        tabAudioStream: fakeStream(),
        micStream: null,
        micGain: 1,
        tabGain: 1,
        monitorEl: fakeAudioEl(),
      });
      await mixer.ready();
      expect(mixer._tabNoiseGate).toBeNull();
      expect(mixer._tabGateDirectlyConnected).toBe(true);
    } finally {
      chrome.runtime.getURL = origGetURL;
    }
  });

  it('retryMonitor flips monitorBlocked back to false when play() resolves', async () => {
    let shouldReject = true;
    const onRestored = vi.fn();
    const audioEl = document.createElement('audio');
    Object.defineProperty(audioEl, 'srcObject', {
      get() {
        return this._srcObject;
      },
      set(v) {
        this._srcObject = v;
      },
      configurable: true,
    });
    audioEl.play = vi.fn(async () => {
      if (shouldReject) throw new Error('blocked');
    });

    const mixer = new AudioMixer({
      tabAudioStream: fakeStream(),
      micStream: null,
      micGain: 1,
      tabGain: 1,
      monitorEl: audioEl,
      onMonitorRestored: onRestored,
    });

    await flushMicrotasks();
    expect(mixer.monitorBlocked).toBe(true);

    shouldReject = false;
    const ok = await mixer.retryMonitor();
    expect(ok).toBe(true);
    expect(mixer.monitorBlocked).toBe(false);
    expect(onRestored).toHaveBeenCalledTimes(1);
  });
});
