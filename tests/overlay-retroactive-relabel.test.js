// Retroactive speaker relabel — Mode 2 (and the Mode 3 tab substream)
// often render the first one or two finals as "Speaker A/B/…" because
// the meeting-platform caption observer hasn't seen a participant tile
// yet. Without retroactive patching, those rows stay as letter labels
// for the rest of the session (numeric→name cache only binds on
// FUTURE events). This suite pins:
//
//   * the source contract — renderFinal tags rows with the pending
//     numeric speaker + render wall-clock when the resolved label is
//     a generic "Speaker X" letter, and SPEAKER_CHANGE walks those
//     rows + patches in place when a real-name observation lands
//     within the freshness window;
//   * the SpeakerNameMap.lookupAt + numericToName binding the
//     relabel relies on — that a fresh observation does resolve to
//     the real name within the documented window.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FRESHNESS_MS,
  SpeakerNameMap,
  TranscribeMode,
} from '../src/transcribe/speaker-name-map.js';

const here = dirname(fileURLToPath(import.meta.url));
const overlaySrc = readFileSync(
  resolve(here, '../src/transcribe/overlay.js'),
  'utf8',
);

describe('overlay.js — render tags rows with the pending numeric', () => {
  it('renderFinal stamps data-mm-pending-speaker when the label is generic', () => {
    const start = overlaySrc.indexOf('function renderFinal(');
    const end = overlaySrc.indexOf('\nfunction renderPartials(', start);
    const fn = overlaySrc.slice(start, end);
    expect(fn).toContain('data-mm-pending-speaker');
    // Equivalent to: dataset.mmPendingSpeaker = String(event.speaker)
    expect(fn).toMatch(/dataset\.mmPendingSpeaker\s*=\s*String\(event\.speaker\)/);
    expect(fn).toMatch(/dataset\.mmRenderedAt\s*=\s*String\(nowMs\)/);
  });

  it('skips tagging mic-origin rows (mic always resolves to selfName)', () => {
    const start = overlaySrc.indexOf('function renderFinal(');
    const end = overlaySrc.indexOf('\nfunction renderPartials(', start);
    const fn = overlaySrc.slice(start, end);
    expect(fn).toMatch(/!_isMicEvent\(streamRole\)/);
  });

  it('only tags when the resolver returned a generic letter label', () => {
    const start = overlaySrc.indexOf('function renderFinal(');
    const end = overlaySrc.indexOf('\nfunction renderPartials(', start);
    const fn = overlaySrc.slice(start, end);
    expect(fn).toMatch(/_isGenericSpeakerLabel\(resolvedName\)/);
  });
});

describe('overlay.js — _isGenericSpeakerLabel matches the resolver fallback shape', () => {
  // Helper recreated locally — this regex is a one-line guard so a
  // refactor must not loosen it. Keep the test in sync with the
  // constant.
  const _GENERIC_SPEAKER_LABEL = /^Speaker(?: [A-Z]| \d+)?$/;

  it('matches bare "Speaker"', () => {
    expect(_GENERIC_SPEAKER_LABEL.test('Speaker')).toBe(true);
  });

  it('matches letter labels (A..Z)', () => {
    for (const c of ['A', 'B', 'Z']) {
      expect(_GENERIC_SPEAKER_LABEL.test(`Speaker ${c}`)).toBe(true);
    }
  });

  it('matches numeric labels (Speaker 27 = 26 in the resolver)', () => {
    expect(_GENERIC_SPEAKER_LABEL.test('Speaker 27')).toBe(true);
  });

  it('does NOT match real participant names', () => {
    expect(_GENERIC_SPEAKER_LABEL.test('Shubham Pilivkar')).toBe(false);
    expect(_GENERIC_SPEAKER_LABEL.test('Rishi Patel')).toBe(false);
    // A real name that starts with "Speaker" the way another name
    // might — the regex anchors on the end with $ so any trailing
    // word kills the match.
    expect(_GENERIC_SPEAKER_LABEL.test('Speaker House')).toBe(false);
  });

  it('also exists in the source as a single const so refactors are localised', () => {
    expect(overlaySrc).toMatch(
      /const\s+_GENERIC_SPEAKER_LABEL\s*=\s*\/\^Speaker\(\?:\s*\[A-Z\]\s*\|\s*\\d\+\)\?\$\//,
    );
    expect(overlaySrc).toMatch(/function\s+_isGenericSpeakerLabel\(label\)/);
  });
});

describe('overlay.js — SPEAKER_CHANGE handler triggers a relabel pass', () => {
  it('SPEAKER_CHANGE records the observation AND calls _relabelPendingFinals', () => {
    // Slice the SPEAKER_CHANGE branch so the assertions are scoped.
    const branchIdx = overlaySrc.indexOf('MessageType.SPEAKER_CHANGE');
    expect(branchIdx).toBeGreaterThan(0);
    const branch = overlaySrc.slice(branchIdx, branchIdx + 1200);
    expect(branch).toMatch(/speakerMap\.recordObservation\(/);
    expect(branch).toMatch(/_relabelPendingFinals\(\)/);
  });

  it('defines _relabelPendingFinals that walks data-mm-pending-speaker rows', () => {
    expect(overlaySrc).toMatch(/function\s+_relabelPendingFinals\(\)/);
    const fnIdx = overlaySrc.indexOf('function _relabelPendingFinals()');
    const fn = overlaySrc.slice(fnIdx, fnIdx + 2400);
    // Query the right attribute.
    expect(fn).toMatch(/querySelectorAll\(['"]\[data-mm-pending-speaker\]['"]\)/);
    // Look up against the JUST-arrived observation (lookupAt(now)).
    expect(fn).toMatch(/speakerMap\.lookupAt\(now\)/);
    // Only patch when the new lookup actually returns a real name
    // (skip generic letter labels — they're what we're trying to
    // replace, not propagate).
    expect(fn).toMatch(/_isGenericSpeakerLabel\(realName\)/);
    // Symmetric row-age bound — skip rows whose render wall-clock is
    // more than the resolver's freshness window older than now.
    // Without this, a mid-meeting observation would stamp the wrong
    // name onto a 10-minute-old row.
    expect(fn).toMatch(/now - renderedAt > maxRowAgeMs/);
    // The patched binding must also be written into the numericToName
    // cache so SUBSEQUENT finals for the same provider speaker resolve
    // directly without needing another retroactive pass.
    expect(fn).toMatch(/speakerMap\.numericToName\.set\(numeric,\s*realName\)/);
  });

  it('clears the data- tags after patching (so a later observation does not flap the row)', () => {
    const fnIdx = overlaySrc.indexOf('function _relabelPendingFinals()');
    const fn = overlaySrc.slice(fnIdx, fnIdx + 2400);
    expect(fn).toMatch(/delete row\.dataset\.mmPendingSpeaker/);
    expect(fn).toMatch(/delete row\.dataset\.mmRenderedAt/);
  });
});

describe('SpeakerNameMap behavior the relabel relies on', () => {
  function makeMap(nowRef) {
    const m = new SpeakerNameMap({ now: () => nowRef.t });
    m.setMode(TranscribeMode.PARTICIPANTS);
    return m;
  }

  it('lookupAt(now) returns the freshest observation after recordObservation', () => {
    // Relabel calls lookupAt(now) — the just-arrived observation is
    // by definition within the freshness window of "now".
    const nowRef = { t: 1_000_000 };
    const m = makeMap(nowRef);
    expect(m.lookupAt(nowRef.t)).toBeNull();
    m.recordObservation('Rishi Patel', nowRef.t);
    expect(m.lookupAt(nowRef.t)).toBe('Rishi Patel');
  });

  it('the row-age symmetric bound is the speakerMap freshness window', () => {
    // The relabel walks pending rows and skips any whose render
    // wall-clock is more than ``freshnessMs`` older than now. This
    // upper bound has to live in the overlay because lookupAt is
    // one-sided. The constant must be the same the resolver uses
    // at first-render time, so they stay consistent.
    expect(DEFAULT_FRESHNESS_MS).toBeGreaterThan(0);
    // Documented in the resolver — 20s as of writing. Pin so a
    // change reaches us via a failing test (and we can revisit the
    // relabel's row-age semantics in lockstep).
    expect(DEFAULT_FRESHNESS_MS).toBe(20000);
  });

  it('numericToName.set persists the binding so future finals resolve directly', () => {
    // The relabel writes back into the cache; subsequent
    // _resolveParticipant for the same numeric must short-circuit.
    const nowRef = { t: 0 };
    const m = makeMap(nowRef);
    m.numericToName.set('0', 'Rishi Patel');
    // No fresh observation, but the cache hits.
    expect(m.resolve({ speaker: 0 })).toBe('Rishi Patel');
  });
});
