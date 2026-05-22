// Phase A tests for the telemetry-event allowlist + audio-constraint
// helper. These are pure-unit; the WS heartbeat is integration-tested
// against the backend relay in the backend test suite.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TELEMETRY_EVENT_NAMES } from '../src/constants.js';
import { emitEvent } from '../src/api/client.js';
import { micConstraints } from '../src/lib/audio-constraints.js';


describe('TELEMETRY_EVENT_NAMES', () => {
  it('values are unique strings (no typo collisions)', () => {
    const values = Object.values(TELEMETRY_EVENT_NAMES);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it('exposes the Phase A additions for live-transcribe + SW', () => {
    expect(TELEMETRY_EVENT_NAMES.WS_RECONNECT_ATTEMPTED).toBe('ws_reconnect_attempted');
    expect(TELEMETRY_EVENT_NAMES.WS_RECONNECT_SUCCEEDED).toBe('ws_reconnect_succeeded');
    expect(TELEMETRY_EVENT_NAMES.WS_RECONNECT_EXHAUSTED).toBe('ws_reconnect_exhausted');
    expect(TELEMETRY_EVENT_NAMES.WS_HEARTBEAT_TIMEOUT).toBe('ws_heartbeat_timeout');
    expect(TELEMETRY_EVENT_NAMES.SW_RESTART_UNEXPECTED).toBe('sw_restart_unexpected');
    expect(TELEMETRY_EVENT_NAMES.OFFSCREEN_DOC_ORPHANED).toBe('offscreen_doc_orphaned');
    expect(TELEMETRY_EVENT_NAMES.SW_STATE_REHYDRATED).toBe('sw_state_rehydrated');
    expect(TELEMETRY_EVENT_NAMES.HEAP_HIGH_WATER_MARK).toBe('heap_high_water_mark');
    expect(TELEMETRY_EVENT_NAMES.CHUNK_UPLOAD_LATENCY).toBe('chunk_upload_latency');
  });

  it('exposes the Phase B + C additions (session-replay dump, VAD stats)', () => {
    expect(TELEMETRY_EVENT_NAMES.SESSION_REPLAY_DUMP).toBe('session_replay_dump');
    expect(TELEMETRY_EVENT_NAMES.VAD_STATS).toBe('vad_stats');
  });
});


describe('emitEvent allowlist enforcement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops events whose name is not in the allowlist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    emitEvent('totally_made_up_event', { x: 1 });
    expect(warn).toHaveBeenCalled();
    const msg = String(warn.mock.calls[0][1]);
    expect(msg).toContain('totally_made_up_event');
  });

  it('accepts events from the allowlist without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    emitEvent(TELEMETRY_EVENT_NAMES.WS_RECONNECT_ATTEMPTED, { attempt: 1 });
    // No unknown-event warning. Other warnings (buffer-failed) may
    // fire because the test env doesn't have a real IDB store, but
    // they wouldn't reference the event name.
    const unknownWarn = warn.mock.calls.find(([_, name]) =>
      typeof name === 'string' && name === 'ws_reconnect_attempted',
    );
    expect(unknownWarn).toBeUndefined();
  });
});


describe('micConstraints', () => {
  it('always sets echo/noise/AGC flags so Chrome defaults are predictable', () => {
    const c = micConstraints();
    expect(c.audio.echoCancellation).toBe(true);
    expect(c.audio.noiseSuppression).toBe(true);
    expect(c.audio.autoGainControl).toBe(true);
  });

  it('asks the platform for 16kHz mono to skip an extra resample pass', () => {
    const c = micConstraints();
    expect(c.audio.sampleRate).toBe(16000);
    expect(c.audio.channelCount).toBe(1);
  });

  it('honours an explicit deviceId when supplied', () => {
    const c = micConstraints({ deviceId: 'abc-123' });
    expect(c.audio.deviceId).toEqual({ exact: 'abc-123' });
  });

  it('omits deviceId when null/undefined so the system default is used', () => {
    expect(micConstraints({ deviceId: null }).audio.deviceId).toBeUndefined();
    expect(micConstraints({}).audio.deviceId).toBeUndefined();
    expect(micConstraints().audio.deviceId).toBeUndefined();
  });
});
