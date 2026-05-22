// Smoke tests for the pause/resume wiring. Verifies the message
// types and state enums exist with the expected values — a runtime
// typo here would otherwise surface as a silent "no handler" message
// drop. Cheap to maintain, catches the worst class of refactor bugs.

import { describe, expect, it } from 'vitest';
import { MessageType, TranscribeState } from '../src/constants.js';

describe('pause/resume constants', () => {
  it('exposes the four new message types', () => {
    expect(MessageType.PAUSE_TRANSCRIBE).toBe('PAUSE_TRANSCRIBE');
    expect(MessageType.RESUME_TRANSCRIBE).toBe('RESUME_TRANSCRIBE');
    expect(MessageType.OFFSCREEN_TRANSCRIBE_PAUSE).toBe('OFFSCREEN_TRANSCRIBE_PAUSE');
    expect(MessageType.OFFSCREEN_TRANSCRIBE_RESUME).toBe('OFFSCREEN_TRANSCRIBE_RESUME');
  });

  it('adds PAUSED to TranscribeState without breaking the existing states', () => {
    expect(TranscribeState.PAUSED).toBe('PAUSED');
    // Sanity: the existing states must still be present so popup
    // code that branches on them doesn't break.
    expect(TranscribeState.IDLE).toBe('IDLE');
    expect(TranscribeState.STARTING).toBe('STARTING');
    expect(TranscribeState.ACTIVE).toBe('ACTIVE');
    expect(TranscribeState.STOPPING).toBe('STOPPING');
    expect(TranscribeState.ERROR).toBe('ERROR');
  });

  it('message types are unique strings (no typo collisions)', () => {
    const values = Object.values(MessageType);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});
