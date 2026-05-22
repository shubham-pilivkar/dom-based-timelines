// Tests for the WebCodecs recorder's static probe + constructor
// guard. The full encoder + pump path needs a real WebCodecs runtime
// (or extensive stubs) — vitest's node-only environment doesn't have
// ``MediaStreamTrackProcessor`` and reasonably faking it would test
// the stub, not the recorder. We pin the support-detection and
// fallback contracts instead.

import { afterEach, describe, expect, it, vi } from 'vitest';


function installWebCodecsStubs() {
  const prev = {
    AudioEncoder: globalThis.AudioEncoder,
    AudioData: globalThis.AudioData,
    MediaStreamTrackProcessor: globalThis.MediaStreamTrackProcessor,
  };
  globalThis.AudioEncoder = class { configure() {} encode() {} async flush() {} close() {} };
  globalThis.AudioData = class {};
  globalThis.MediaStreamTrackProcessor = class {
    constructor() {
      this.readable = { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) };
    }
  };
  return () => {
    if (prev.AudioEncoder === undefined) delete globalThis.AudioEncoder;
    else globalThis.AudioEncoder = prev.AudioEncoder;
    if (prev.AudioData === undefined) delete globalThis.AudioData;
    else globalThis.AudioData = prev.AudioData;
    if (prev.MediaStreamTrackProcessor === undefined) delete globalThis.MediaStreamTrackProcessor;
    else globalThis.MediaStreamTrackProcessor = prev.MediaStreamTrackProcessor;
  };
}


afterEach(() => {
  vi.restoreAllMocks();
});


describe('isWebCodecsRecorderSupported', () => {
  it('returns false when AudioEncoder is missing', async () => {
    // Node default — none of the WebCodecs APIs exist.
    const { isWebCodecsRecorderSupported } = await import(
      '../src/lib/recorder-webcodecs.js'
    );
    expect(isWebCodecsRecorderSupported()).toBe(false);
  });

  it('returns true when AudioEncoder + AudioData + MediaStreamTrackProcessor all exist', async () => {
    const cleanup = installWebCodecsStubs();
    try {
      // Reimport in case the module cached the previous probe.
      // Vitest's module graph is per-test by default; re-importing
      // is safe.
      vi.resetModules();
      const { isWebCodecsRecorderSupported } = await import(
        '../src/lib/recorder-webcodecs.js'
      );
      expect(isWebCodecsRecorderSupported()).toBe(true);
    } finally {
      cleanup();
    }
  });
});


describe('WebCodecsRecorder constructor', () => {
  it('throws ``webcodecs_recorder_unsupported`` when the runtime lacks the APIs', async () => {
    // Stubs NOT installed — global APIs are missing.
    vi.resetModules();
    const { WebCodecsRecorder } = await import('../src/lib/recorder-webcodecs.js');
    expect(() => new WebCodecsRecorder({
      stream: { getAudioTracks: () => [{}] },
      onChunk: async () => {},
    })).toThrow(/unsupported/);
  });

  it('reports state "inactive" before start()', async () => {
    const cleanup = installWebCodecsStubs();
    try {
      vi.resetModules();
      const { WebCodecsRecorder } = await import('../src/lib/recorder-webcodecs.js');
      const rec = new WebCodecsRecorder({
        stream: { getAudioTracks: () => [{}] },
        onChunk: async () => {},
      });
      expect(rec.state).toBe('inactive');
    } finally {
      cleanup();
    }
  });

  it('exposes the same nextIndex semantics as the MediaRecorder Recorder', async () => {
    // Both recorders surface ``nextIndex`` so the rotation path can
    // hand off without missing a chunk. Pin this so a future
    // refactor doesn't drift the field name.
    const cleanup = installWebCodecsStubs();
    try {
      vi.resetModules();
      const { WebCodecsRecorder } = await import('../src/lib/recorder-webcodecs.js');
      const rec = new WebCodecsRecorder({
        stream: { getAudioTracks: () => [{}] },
        onChunk: async () => {},
        startIndex: 17,
      });
      expect(rec.nextIndex).toBe(17);
    } finally {
      cleanup();
    }
  });

  it('reports the audio/webm;codecs=opus mime type', async () => {
    const cleanup = installWebCodecsStubs();
    try {
      vi.resetModules();
      const { WebCodecsRecorder } = await import('../src/lib/recorder-webcodecs.js');
      const rec = new WebCodecsRecorder({
        stream: { getAudioTracks: () => [{}] },
        onChunk: async () => {},
      });
      expect(rec.mimeType).toBe('audio/webm;codecs=opus');
    } finally {
      cleanup();
    }
  });
});
