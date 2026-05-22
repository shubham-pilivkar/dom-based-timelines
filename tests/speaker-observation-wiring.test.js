// Bug 11.1 — DOM caption-author observations are forwarded from
// content-script → SW → offscreen → live transcribe WS so the relay
// can drive ``name_by_label`` correlation for important-points
// attribution even when the user is transcribing WITHOUT a paired
// recording (Mode 2 transcribe-only).
//
// Source-contract tests (same pattern as the other overlay /
// service-worker / offscreen suites). The end-to-end behavior is
// verified by the backend side (test_observation_ingest.py) and the
// integration smoke in real meetings.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const _read = (rel) => readFileSync(resolve(here, '..', rel), 'utf8');

const sw = _read('src/background/service-worker.js');
const off = _read('src/offscreen/transcribe.js');
const constants = _read('src/constants.js');

describe('new MessageType constant declared', () => {
  it('OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION exists on MessageType', () => {
    expect(constants).toMatch(
      /OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION\s*:\s*['"]OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION['"]/,
    );
  });
});

describe('SW forwards SPEAKER_CHANGE to offscreen when transcribing', () => {
  it('SPEAKER_CHANGE handler sends OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION', () => {
    // Slice the SPEAKER_CHANGE case so the assertion is local.
    const idx = sw.indexOf('case MessageType.SPEAKER_CHANGE');
    expect(idx).toBeGreaterThan(-1);
    // Generous slice — the case body has the bridge forward, the
    // overlay forward, and the new offscreen forward.
    const fn = sw.slice(idx, idx + 3400);
    expect(fn).toMatch(
      /MessageType\.OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION/,
    );
    // Payload shape — relay validates ``name`` + ``wall_clock_ms``;
    // SW maps the SW-side ``speaker_name`` field to ``name`` and
    // ``wall_clock_ms`` to ``wallClockMs``.
    expect(fn).toMatch(/name:\s*message\.speaker_name/);
    expect(fn).toMatch(/wallClockMs:\s*message\.wall_clock_ms\s*\?\?\s*Date\.now\(\)/);
  });

  it('only forwards when transcribe is live (ACTIVE or PAUSED) AND speaker_name is a string', () => {
    const idx = sw.indexOf('case MessageType.SPEAKER_CHANGE');
    const fn = sw.slice(idx, idx + 3400);
    // The forward is gated by ``transcribeLive && typeof
    // message.speaker_name === 'string'``.
    expect(fn).toMatch(/transcribeLive\s*=/);
    expect(fn).toMatch(
      /if\s*\(\s*transcribeLive\s*&&\s*typeof\s+message\.speaker_name\s*===\s*['"]string['"]/,
    );
  });

  it('forward is fire-and-forget — never throws into the SPEAKER_CHANGE handler', () => {
    const idx = sw.indexOf('case MessageType.SPEAKER_CHANGE');
    const fn = sw.slice(idx, idx + 3400);
    // sendMessage(...).catch(() => {}) is the established pattern.
    expect(fn).toMatch(
      /sendMessage\(\{\s*\n\s*type:\s*MessageType\.OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION/,
    );
    // Trailing .catch — find the next .catch within ~400 chars of
    // the sendMessage call.
    const sendIdx = fn.indexOf('OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION');
    const after = fn.slice(sendIdx, sendIdx + 400);
    expect(after).toMatch(/\.catch\(/);
  });
});

describe('offscreen exposes sendSpeakerObservation + handler', () => {
  it('declares sendSpeakerObservation as a module function', () => {
    expect(off).toMatch(/function\s+sendSpeakerObservation\s*\(/);
  });

  it('builds the wire frame as {type: speaker_observation, name, wall_clock_ms}', () => {
    const start = off.indexOf('function sendSpeakerObservation(');
    expect(start).toBeGreaterThan(-1);
    const fn = off.slice(start, start + 2000);
    // Must serialise the WS-protocol type literal — relay matches on it.
    expect(fn).toMatch(/type:\s*['"]speaker_observation['"]/);
    expect(fn).toMatch(/name\s*,/);
    expect(fn).toMatch(/wall_clock_ms\s*:\s*wallClockMs/);
    expect(fn).toMatch(/JSON\.stringify\(/);
  });

  it('only sends on substreams whose WS is OPEN (no CONNECTING / CLOSING)', () => {
    const start = off.indexOf('function sendSpeakerObservation(');
    const fn = off.slice(start, start + 2000);
    expect(fn).toMatch(/s\.ws\.readyState\s*!==\s*WebSocket\.OPEN/);
  });

  it('iterates activeStreams so both mic + tab substreams in mode=both get the frame', () => {
    const start = off.indexOf('function sendSpeakerObservation(');
    const fn = off.slice(start, start + 2000);
    expect(fn).toMatch(/for\s*\(\s*const\s+s\s+of\s+activeStreams\(\)/);
  });

  it('coerces wallClockMs to a positive integer (defaults to Date.now)', () => {
    const start = off.indexOf('function sendSpeakerObservation(');
    const fn = off.slice(start, start + 2000);
    expect(fn).toMatch(/Number\.isFinite\(\s*payload\.wallClockMs/);
    expect(fn).toMatch(/Math\.floor\(\s*payload\.wallClockMs/);
    expect(fn).toMatch(/:\s*Date\.now\(\)/);
  });

  it('returns silently when name is empty / non-string (no WS send)', () => {
    const start = off.indexOf('function sendSpeakerObservation(');
    const fn = off.slice(start, start + 2000);
    // Early-return: ``if (!name) return;`` after trim.
    expect(fn).toMatch(/if\s*\(\s*!name\s*\)\s*return\s*;/);
  });

  it('wraps the send in try/catch so a single failure doesn\'t break the loop', () => {
    const start = off.indexOf('function sendSpeakerObservation(');
    const fn = off.slice(start, start + 2000);
    // The send is inside a try/catch — silently drops on error.
    expect(fn).toMatch(/try\s*\{\s*\n\s*s\.ws\.send\(/);
  });

  it('registers the OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION onMessage handler', () => {
    expect(off).toMatch(
      /\[MessageType\.OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION\]\s*:\s*\(message\)/,
    );
    // Handler dispatches to sendSpeakerObservation with the SW
    // payload mapped to the function's expected shape.
    const idx = off.indexOf('OFFSCREEN_TRANSCRIBE_SPEAKER_OBSERVATION]:');
    const slice = off.slice(idx, idx + 600);
    expect(slice).toMatch(/sendSpeakerObservation\(\s*\{/);
    expect(slice).toMatch(/name:\s*message\.name/);
    expect(slice).toMatch(/wallClockMs:\s*message\.wallClockMs/);
    expect(slice).toMatch(/source:\s*message\.source/);
  });
});
