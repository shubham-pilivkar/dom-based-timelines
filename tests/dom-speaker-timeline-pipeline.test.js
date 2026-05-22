// End-to-end pipeline test for the DOM speaker-timeline strategy: the
// REAL participant-tile probes (lib/dom-speaker-probes.js) wired into the
// REAL detector state machine (lib/speaker-detector.js), driven against
// an evolving meeting DOM, asserting the exact sequence of
// SPEAKER_CHANGE turns the content script would emit.
//
// This is the "do all the functions work together" test for the dom
// path — the unit test (dom-speaker-probes.test.js) only checks a single
// snapshot(); here we exercise snapshot → evaluate → debounce → commit →
// onChange across speaker changes, joins, and a final flush, exactly as
// meet.js / teams.js run them when SPEAKER_TIMELINE_STRATEGY === DOM.
//
// Driven deterministically the same way the existing speaker-detector
// test does: call evaluate() after each DOM change and advance the
// debounce timer, rather than racing happy-dom's MutationObserver. The
// real-browser MutationObserver path is covered by the Playwright e2e
// (tests/e2e/dom-speaker-timeline.spec.js).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startSpeakerDetector } from '../src/lib/speaker-detector.js';
import {
  createMeetSpeakerProbe,
  createTeamsPersonalSpeakerProbe,
  createTeamsBusinessSpeakerProbe,
} from '../src/lib/dom-speaker-probes.js';

const DEBOUNCE_MS = 300; // SPEAKER_DEBOUNCE_MS

describe('DOM speaker-timeline pipeline (probe + startSpeakerDetector)', () => {
  let elapsed;
  let onChange;
  let handle;

  beforeEach(() => {
    vi.useFakeTimers();
    elapsed = 0;
    onChange = vi.fn();
    handle = null;
  });

  afterEach(() => {
    try { handle?.dispose(); } catch { /* noop */ }
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  // Run the detector for the given probe; returns a `step(mutate, atSec)`
  // helper that applies a DOM change, advances the elapsed clock,
  // evaluates, and fires the debounce so a steady speaker commits.
  function drive(probe) {
    handle = startSpeakerDetector({
      probe,
      getElapsedSeconds: () => elapsed,
      onChange,
      isActive: () => true,
    });
    return (mutate, atSec) => {
      mutate();
      elapsed = atSec;
      handle.evaluate();
      vi.advanceTimersByTime(DEBOUNCE_MS);
    };
  }

  const names = () => onChange.mock.calls.map((c) => c[0].speaker_name);
  const turns = () => onChange.mock.calls.map((c) => c[0]);

  // ----- Google Meet ------------------------------------------------------

  it('Meet: emits ordered Alice→Bob→Alice turns with sane windows', () => {
    document.body.innerHTML = `
      <main>
        <div id="alice" class="t"><span class="notranslate">Alice</span></div>
        <div id="bob" class="t"><span class="notranslate">Bob</span></div>
      </main>`;
    const alice = document.getElementById('alice');
    const bob = document.getElementById('bob');
    const step = drive(createMeetSpeakerProbe());

    // Alice speaks (class count rises above the baseline of 1) → commits
    // as current, but emits nothing (no previous speaker to close).
    step(() => { alice.className = 't speaking ring'; }, 1);
    expect(onChange).not.toHaveBeenCalled();

    // Bob speaks, Alice stops → closes Alice's turn.
    step(() => {
      alice.className = 't';
      bob.className = 't speaking ring';
    }, 4);
    expect(names()).toEqual(['Alice']);

    // Alice speaks again → closes Bob's turn.
    step(() => {
      bob.className = 't';
      alice.className = 't speaking ring';
    }, 9);
    expect(names()).toEqual(['Alice', 'Bob']);

    // Stop → flush closes the open Alice turn.
    elapsed = 12;
    handle.flush();
    expect(names()).toEqual(['Alice', 'Bob', 'Alice']);

    // Every emitted window is [start ≤ end] and starts are non-decreasing.
    const t = turns();
    let prevStart = -1;
    for (const turn of t) {
      expect(turn.end_time).toBeGreaterThanOrEqual(turn.start_time);
      expect(turn.start_time).toBeGreaterThanOrEqual(prevStart);
      prevStart = turn.start_time;
    }
    expect(t[0]).toMatchObject({ speaker_name: 'Alice', start_time: 1, end_time: 4 });
    expect(t[1]).toMatchObject({ speaker_name: 'Bob', start_time: 4, end_time: 9 });
  });

  it('Meet: detects a participant who joins and speaks mid-call', () => {
    document.body.innerHTML = `
      <main>
        <div id="alice" class="t"><span class="notranslate">Alice</span></div>
      </main>`;
    const main = document.querySelector('main');
    const alice = document.getElementById('alice');
    const step = drive(createMeetSpeakerProbe());

    // Establish the idle baseline first (Alice present, silent) — the
    // class-count heuristic needs an at-rest reference, which is the
    // real sequence: tiles render before anyone starts talking.
    step(() => {}, 0);
    expect(onChange).not.toHaveBeenCalled();

    step(() => { alice.className = 't speaking ring'; }, 1); // Alice (current)

    // Carol's tile appears (Meet adds a child div) and she speaks; Alice
    // stops. The probe re-queries main.children each snapshot, so the new
    // tile is seen → Alice's turn closes, Carol becomes current.
    step(() => {
      alice.className = 't';
      const carol = document.createElement('div');
      carol.id = 'carol';
      carol.className = 't speaking ring';
      carol.innerHTML = '<span class="notranslate">Carol</span>';
      main.appendChild(carol);
    }, 5);
    expect(names()).toEqual(['Alice']);

    elapsed = 8;
    handle.flush();
    expect(names()).toEqual(['Alice', 'Carol']);
  });

  // ----- Teams Personal (teams.live.com) ----------------------------------

  it('Teams Personal: vdi-frame-occlusion toggles drive Asha→Ravi turns', () => {
    document.body.innerHTML = `
      <div data-tid="calling-pagination">
        <div data-stream-type="Video" data-tid="Asha">
          <div id="asha" data-tid="voice-level-stream-outline" class="ind"></div>
        </div>
        <div data-stream-type="Video" data-tid="Ravi">
          <div id="ravi" data-tid="voice-level-stream-outline" class="ind"></div>
        </div>
      </div>`;
    const asha = document.getElementById('asha');
    const ravi = document.getElementById('ravi');
    const step = drive(createTeamsPersonalSpeakerProbe());

    step(() => asha.classList.add('vdi-frame-occlusion'), 2); // Asha (current)
    expect(onChange).not.toHaveBeenCalled();

    step(() => {
      asha.classList.remove('vdi-frame-occlusion');
      ravi.classList.add('vdi-frame-occlusion');
    }, 6);
    expect(names()).toEqual(['Asha']);

    elapsed = 10;
    handle.flush();
    expect(names()).toEqual(['Asha', 'Ravi']);
  });

  // ----- Teams Business (teams.microsoft.com) -----------------------------

  it('Teams Business: arrow-navigator names drive Carol→Dan turns', () => {
    document.body.innerHTML = `
      <div data-tid="call-roster">
        <div data-acc-id="arrow-navigator-1">
          <div data-tid="meta-c"></div><div><div>Carol</div></div>
          <div id="ic" data-tid="voice-level-stream-outline" class="ind"></div>
        </div>
        <div data-acc-id="arrow-navigator-2">
          <div data-tid="meta-d"></div><div><div>Dan</div></div>
          <div id="id" data-tid="voice-level-stream-outline" class="ind"></div>
        </div>
      </div>`;
    const ic = document.getElementById('ic');
    const id = document.getElementById('id');
    const step = drive(createTeamsBusinessSpeakerProbe());

    step(() => ic.classList.add('vdi-frame-occlusion'), 3); // Carol (current)
    expect(onChange).not.toHaveBeenCalled();

    step(() => {
      ic.classList.remove('vdi-frame-occlusion');
      id.classList.add('vdi-frame-occlusion');
    }, 7);
    expect(names()).toEqual(['Carol']);

    elapsed = 11;
    handle.flush();
    expect(names()).toEqual(['Carol', 'Dan']);
  });
});
