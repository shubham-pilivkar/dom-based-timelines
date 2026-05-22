// Smoke tests for the reconnect wiring. Mirrors the pattern in
// transcribe-pause-constants.test.js — catches typo-class refactor
// bugs that would otherwise surface as silent "no handler" message
// drops at runtime.

import { describe, expect, it } from 'vitest';
import {
  MessageType,
  TRANSCRIBE_RECONNECT_BACKOFFS_MS,
  TRANSCRIBE_RECONNECT_MAX_ATTEMPTS,
  TranscribeState,
} from '../src/constants.js';

describe('reconnect constants', () => {
  it('adds RECONNECTING to TranscribeState without removing the existing ones', () => {
    expect(TranscribeState.RECONNECTING).toBe('RECONNECTING');
    expect(TranscribeState.IDLE).toBe('IDLE');
    expect(TranscribeState.STARTING).toBe('STARTING');
    expect(TranscribeState.ACTIVE).toBe('ACTIVE');
    expect(TranscribeState.PAUSED).toBe('PAUSED');
    expect(TranscribeState.STOPPING).toBe('STOPPING');
    expect(TranscribeState.ERROR).toBe('ERROR');
  });

  it('exposes the two reconnect-specific message types', () => {
    expect(MessageType.OFFSCREEN_TRANSCRIBE_GET_RECONNECT_URL).toBe(
      'OFFSCREEN_TRANSCRIBE_GET_RECONNECT_URL',
    );
    expect(MessageType.TRANSCRIBE_RECONNECT_PROGRESS).toBe(
      'TRANSCRIBE_RECONNECT_PROGRESS',
    );
  });

  it('backoff schedule is monotonically non-decreasing', () => {
    // A schedule like [1000, 500, 2000] would be a bug — the user
    // would see the popup re-tighten in the middle of a long outage.
    for (let i = 1; i < TRANSCRIBE_RECONNECT_BACKOFFS_MS.length; i += 1) {
      expect(TRANSCRIBE_RECONNECT_BACKOFFS_MS[i]).toBeGreaterThanOrEqual(
        TRANSCRIBE_RECONNECT_BACKOFFS_MS[i - 1],
      );
    }
  });

  it('max attempts matches the backoff schedule length', () => {
    expect(TRANSCRIBE_RECONNECT_MAX_ATTEMPTS).toBe(
      TRANSCRIBE_RECONNECT_BACKOFFS_MS.length,
    );
  });

  it('total reconnect budget is at least 15 seconds', () => {
    // Wi-Fi hops and short backend deploys both take ~10s. The total
    // budget needs comfortable headroom or we'll surface ERROR on
    // recoverable hiccups.
    const total = TRANSCRIBE_RECONNECT_BACKOFFS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(15_000);
  });

  it('all message types are unique strings (no typo collisions)', () => {
    const values = Object.values(MessageType);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});
