// Tests for ``lib/error-messages.js`` — the Phase U3 humanizer that
// translates internal codes into ``{title, body}`` pairs. We pin
// every catalog entry so a regression that silently drops a code
// (or worse, replaces a friendly message with a stack trace) fails
// here loudly.

// Vitest config sets environment: 'happy-dom' globally, so document +
// createElement are available without an explicit import here.
import { describe, expect, it } from 'vitest';

import { humanize, isBenignStop, renderError } from '../src/lib/error-messages.js';


describe('humanize — exact-match codes', () => {
  it('returns a {title, body} for known auth codes', () => {
    const result = humanize('auth_expired');
    expect(result).toMatchObject({
      title: expect.stringContaining('Sign-in expired'),
      body: expect.any(String),
    });
  });

  it('returns a {title, body} for busy_recording', () => {
    expect(humanize('busy_recording')?.title).toContain('Already recording');
  });

  it('returns a {title, body} for busy_transcribing', () => {
    expect(humanize('busy_transcribing')?.title).toContain('Transcription');
  });

  it('returns a {title, body} for no_meeting_tab', () => {
    expect(humanize('no_meeting_tab')?.title).toContain('No meeting tab');
  });

  it('returns a {title, body} for mic_denied', () => {
    expect(humanize('mic_denied')?.title).toContain('Microphone');
  });

  it('returns a {title, body} for e2ee_init_failed', () => {
    expect(humanize('e2ee_init_failed')?.title).toContain('encryption');
  });

  it('returns a {title, body} for transcribe_provider_unavailable', () => {
    expect(humanize('transcribe_provider_unavailable')?.title).toContain('Transcription');
  });

  it('returns a {title, body} for transcribe_concurrency_cap', () => {
    expect(humanize('transcribe_concurrency_cap')?.title).toMatch(/many|limit/i);
  });
});


describe('humanize — prefix-match codes', () => {
  it('maps start_failed_5xx to a server-error message', () => {
    const r = humanize('start_failed_502');
    expect(r?.title.toLowerCase()).toContain('server');
  });

  it('maps start_failed_4xx to a generic rejection message', () => {
    const r = humanize('start_failed_403');
    expect(r?.title).toContain('Could not start');
  });

  it('maps reconnect_failed_after_N_attempts to "Connection unstable"', () => {
    const r = humanize('reconnect_failed_after_4_attempts');
    expect(r?.title).toContain('Connection');
  });

  it('maps chunk_upload_NNN to a retry message', () => {
    const r = humanize('chunk_upload_503');
    expect(r?.title.toLowerCase()).toContain('upload');
  });

  it('maps tabCapture_failed (incl. suffix) to a capture message', () => {
    const r = humanize('tabCapture_failed: getUserMedia denied');
    expect(r?.title.toLowerCase()).toContain('capture');
  });

  it('maps media_recorder_error: ... by stripping suffix', () => {
    const r = humanize('media_recorder_error: NotSupportedError');
    expect(r?.title.toLowerCase()).toContain('recorder');
  });
});


describe('humanize — fallbacks', () => {
  it('returns null for null / undefined / empty input', () => {
    expect(humanize(null)).toBeNull();
    expect(humanize(undefined)).toBeNull();
    expect(humanize('')).toBeNull();
  });

  it('returns null for unknown codes (caller falls back to raw)', () => {
    expect(humanize('zz_definitely_unknown_code')).toBeNull();
  });

  it('handles codes with embedded "—" / spaces / colons', () => {
    // ``auth_expired — re-enter token in options`` is a real string
    // the SW emits today; the humanizer should split on the
    // separator and match the leading token.
    expect(humanize('auth_expired — re-enter token in options')?.title)
      .toContain('Sign-in expired');
  });

  it('rejects non-string inputs without throwing', () => {
    // Defensive — somewhere down the line a caller might pass an
    // Error object. Don't blow up.
    expect(humanize(42)).toBeNull();
    expect(humanize({})).toBeNull();
  });
});


describe('renderError — DOM wiring', () => {
  function makeRow() {
    return {
      rowEl: document.createElement('div'),
      msgEl: document.createElement('div'),
    };
  }

  it('clears row + msg when code is null', () => {
    const { rowEl, msgEl } = makeRow();
    rowEl.classList.remove('hidden'); // visible to start
    msgEl.textContent = 'old text';
    renderError({ rowEl, msgEl, code: null });
    expect(rowEl.classList.contains('hidden')).toBe(true);
    expect(msgEl.textContent).toBe('');
  });

  it('renders structured title + body when humanize matches', () => {
    const { rowEl, msgEl } = makeRow();
    rowEl.classList.add('hidden');
    renderError({ rowEl, msgEl, code: 'auth_expired' });
    expect(rowEl.classList.contains('hidden')).toBe(false);
    const strong = msgEl.querySelector('strong');
    expect(strong?.textContent).toContain('Sign-in expired');
    expect(msgEl.textContent.toLowerCase()).toContain('sign in again');
  });

  it('falls back to raw code when humanize returns null', () => {
    const { rowEl, msgEl } = makeRow();
    renderError({ rowEl, msgEl, code: 'something_unmapped' });
    expect(rowEl.classList.contains('hidden')).toBe(false);
    expect(msgEl.textContent).toBe('something_unmapped');
    expect(msgEl.querySelector('strong')).toBeNull();
  });

  it('replaces previous content on re-render (no stale text)', () => {
    const { rowEl, msgEl } = makeRow();
    renderError({ rowEl, msgEl, code: 'auth_expired' });
    renderError({ rowEl, msgEl, code: 'busy_recording' });
    expect(msgEl.textContent).not.toContain('Sign-in');
    expect(msgEl.textContent).toContain('Already recording');
  });

  // Regression: clicking "Stop live transcription" surfaced
  // "Error: client_stop". The clean-stop reason must never render as
  // a fault — renderError hides the row for benign stop reasons.
  it('hides the row for client_stop (clean stop is not an error)', () => {
    const { rowEl, msgEl } = makeRow();
    renderError({ rowEl, msgEl, code: 'client_stop' });
    expect(rowEl.classList.contains('hidden')).toBe(true);
    expect(msgEl.textContent).toBe('');
  });

  it('hides the row for other benign stop reasons', () => {
    for (const code of ['tab_closed', 'user_stop', 'normal_closure', 'stopped']) {
      const { rowEl, msgEl } = makeRow();
      renderError({ rowEl, msgEl, code });
      expect(rowEl.classList.contains('hidden'), code).toBe(true);
    }
  });
});

describe('isBenignStop', () => {
  it('is true for clean-stop reasons (with or without a suffix)', () => {
    expect(isBenignStop('client_stop')).toBe(true);
    expect(isBenignStop('client_stop: user pressed Stop')).toBe(true);
    expect(isBenignStop('tab_closed')).toBe(true);
  });
  it('is false for real faults and empties', () => {
    expect(isBenignStop('reconnect_failed')).toBe(false);
    expect(isBenignStop('heartbeat_timeout')).toBe(false);
    expect(isBenignStop(null)).toBe(false);
    expect(isBenignStop('')).toBe(false);
  });
});
