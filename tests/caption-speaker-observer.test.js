import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { startCaptionSpeakerObserver } from '../src/lib/caption-speaker-observer.js';

// MutationObserver delivers records as a microtask; give it a tick.
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('startCaptionSpeakerObserver', () => {
  let root;
  let elapsed;
  let obs;

  beforeEach(() => {
    elapsed = 0;
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    try { obs?.dispose(); } catch { /* noop */ }
    root.remove();
  });

  function startMeet(onChange) {
    return startCaptionSpeakerObserver({
      root,
      getElapsedSeconds: () => elapsed,
      isActive: () => true,
      onChange,
      enableCaptions: () => {}, // no DOM walking in the test
    });
  }

  // --- Meet: .NWpY1d badge, clone-minus-badge text ---------------------

  function meetBlock(speaker, text) {
    const b = document.createElement('div');
    b.setAttribute('aria-live', 'polite');
    b.innerHTML = `<span class="NWpY1d">${speaker}</span>`
      + `<span>${text}</span>`;
    return b;
  }

  it('Meet: closes a turn with real [start,end] on speaker change', async () => {
    const onChange = vi.fn();
    obs = startMeet(onChange);

    elapsed = 1;
    root.appendChild(meetBlock('Alice', 'hello there'));
    await tick();
    expect(onChange).not.toHaveBeenCalled(); // first speaker, turn open
    expect(obs.hasCaptions()).toBe(true);

    elapsed = 5;
    root.appendChild(meetBlock('Bob', 'hi alice'));
    await tick();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      speaker_name: 'Alice', start_time: 1, end_time: 5,
    });
  });

  it('Meet: badge-less continuation keeps the same speaker (no turn)', async () => {
    const onChange = vi.fn();
    obs = startMeet(onChange);

    elapsed = 2;
    root.appendChild(meetBlock('Alice', 'first part'));
    await tick();

    // Continuation line: no badge → lastSpeaker continuity.
    elapsed = 3;
    const cont = document.createElement('div');
    cont.setAttribute('aria-live', 'polite');
    cont.innerHTML = '<span>second part</span>';
    root.appendChild(cont);
    await tick();

    expect(onChange).not.toHaveBeenCalled();
  });

  it('Meet: junk/system lines never open a phantom turn', async () => {
    const onChange = vi.fn();
    obs = startMeet(onChange);

    elapsed = 1;
    // System toast inside the live region — must be ignored.
    const junk = document.createElement('div');
    junk.setAttribute('aria-live', 'polite');
    junk.innerHTML = '<span class="NWpY1d">Meet</span>'
      + '<span>You left the meeting</span>';
    root.appendChild(junk);
    await tick();
    expect(obs.hasCaptions()).toBe(false);

    elapsed = 4;
    root.appendChild(meetBlock('Carol', 'real speech'));
    await tick();
    // No previous real turn → still nothing emitted, but a turn is open.
    expect(onChange).not.toHaveBeenCalled();

    elapsed = 7;
    root.appendChild(meetBlock('Dave', 'next'));
    await tick();
    // Carol's turn closes cleanly — the junk line never became a turn.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      speaker_name: 'Carol', start_time: 4, end_time: 7,
    });
  });

  it('flush() emits the final open turn', async () => {
    const onChange = vi.fn();
    obs = startMeet(onChange);

    elapsed = 2;
    root.appendChild(meetBlock('Eve', 'closing words'));
    await tick();

    elapsed = 9;
    obs.flush();
    expect(onChange).toHaveBeenCalledWith({
      speaker_name: 'Eve', start_time: 2, end_time: 9,
    });
  });

  // --- Meet: badge class rotated away (the timelines.json-absent bug) --

  // Caption row with REAL text but NO recognised speaker badge — i.e.
  // Google rotated the obfuscated ``.NWpY1d``/``.xoMHSc`` class. The
  // old code returned '' here and bailed, so ZERO SPEAKER_CHANGE events
  // were ever emitted → no /timeline POST → no speaker_timelines row →
  // no timelines.json (while the mp4 still finalised). The observer
  // must degrade to a coarse single "Speaker" timeline, never nothing.
  function noBadgeBlock(text) {
    const b = document.createElement('div');
    b.setAttribute('aria-live', 'polite');
    b.innerHTML = `<span>${text}</span>`;
    return b;
  }

  it('Meet: unrecognised badge → degraded "Speaker" turn, not silence', async () => {
    const onChange = vi.fn();
    const onTelemetry = vi.fn();
    obs = startCaptionSpeakerObserver({
      root,
      getElapsedSeconds: () => elapsed,
      isActive: () => true,
      onChange,
      onTelemetry,
      enableCaptions: () => {},
    });

    elapsed = 2;
    root.appendChild(noBadgeBlock('hello from an unattributed speaker'));
    await tick();
    expect(obs.hasCaptions()).toBe(true);
    // One-shot observability signal so this breakage isn't silent.
    expect(onTelemetry).toHaveBeenCalledWith(
      'caption_speaker_unattributed',
      { source: 'captions' },
    );

    elapsed = 8;
    obs.flush();
    expect(onChange).toHaveBeenCalledWith({
      speaker_name: 'Speaker', start_time: 2, end_time: 8,
    });
  });

  it('Meet: junk with no badge does NOT manufacture a generic turn', async () => {
    const onChange = vi.fn();
    obs = startMeet(onChange);

    elapsed = 1;
    root.appendChild(noBadgeBlock('Turn on captions'));
    await tick();
    elapsed = 5;
    obs.flush();
    // Junk filter runs BEFORE the generic-speaker fallback.
    expect(onChange).not.toHaveBeenCalled();
  });

  // --- Fix 3: interleaved speakers + stale out-of-order mutations -------

  it('Meet: a late mutation on an already-closed block does NOT re-open it', async () => {
    // Meet keeps several caption rows live and the MutationObserver can
    // fire for them out of order. After Alice's turn was closed by Bob,
    // a late in-place mutation on Alice's OLD block used to re-open
    // Alice as ``current`` — dropping Bob and stretching Alice's window.
    const onChange = vi.fn();
    obs = startMeet(onChange);

    elapsed = 1;
    const aliceBlk = meetBlock('Alice', 'hello');
    root.appendChild(aliceBlk);
    await tick();

    elapsed = 5;
    root.appendChild(meetBlock('Bob', 'hi alice')); // closes Alice 1→5
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      speaker_name: 'Alice', start_time: 1, end_time: 5,
    });

    // Late, out-of-order mutation on Alice's ORIGINAL (already-closed)
    // block — must be ignored, NOT re-open Alice.
    elapsed = 9;
    aliceBlk.querySelector('span:not(.NWpY1d)').textContent = 'hello again';
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1); // still just Alice's turn

    // Bob's turn must still close cleanly on the next real speaker —
    // proving ``current`` is Bob, not a re-opened Alice.
    elapsed = 12;
    root.appendChild(meetBlock('Carol', 'next')); // closes Bob 5→12
    await tick();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({
      speaker_name: 'Bob', start_time: 5, end_time: 12,
    });
  });

  it('Meet: strict A→B→A alternation yields three distinct turns', async () => {
    const onChange = vi.fn();
    obs = startMeet(onChange);

    elapsed = 1;
    root.appendChild(meetBlock('Alice', 'one'));
    await tick();
    elapsed = 3;
    root.appendChild(meetBlock('Bob', 'two')); // closes Alice 1→3
    await tick();
    elapsed = 6;
    root.appendChild(meetBlock('Alice', 'three')); // closes Bob 3→6
    await tick();
    elapsed = 8;
    obs.flush(); // closes the final Alice 6→8

    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenNthCalledWith(1, {
      speaker_name: 'Alice', start_time: 1, end_time: 3,
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      speaker_name: 'Bob', start_time: 3, end_time: 6,
    });
    expect(onChange).toHaveBeenNthCalledWith(3, {
      speaker_name: 'Alice', start_time: 6, end_time: 8,
    });
  });

  it('Meet: ONE reused block changing speaker A→B→C closes both turns', async () => {
    // Same-block reuse: a platform that mutates one row element for a
    // new speaker (instead of appending a row) keeps the same capId.
    // The first change adds that capId to closedCapIds; without minting
    // a fresh id for the reopened block, the SECOND change would hit the
    // closed-block guard and freeze the middle turn (dropping the third
    // speaker). Both turns must close.
    const onChange = vi.fn();
    obs = startMeet(onChange);

    elapsed = 1;
    const blk = meetBlock('Alice', 'hello');
    root.appendChild(blk);
    await tick();
    expect(onChange).not.toHaveBeenCalled(); // Alice's turn open

    // Reuse the SAME block element for Bob. Mutate the existing text
    // nodes' .data (characterData) — that's how platforms grow/relabel
    // a row in place; textContent= would instead add a fresh text node
    // that the observer's scan skips.
    elapsed = 5;
    blk.querySelector('.NWpY1d').firstChild.data = 'Bob';
    blk.querySelector('span:not(.NWpY1d)').firstChild.data = 'hi';
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1); // Alice 1→5 closed

    // Reuse it AGAIN for Carol — this is the change the old code froze.
    elapsed = 9;
    blk.querySelector('.NWpY1d').firstChild.data = 'Carol';
    blk.querySelector('span:not(.NWpY1d)').firstChild.data = 'next';
    await tick();
    expect(onChange).toHaveBeenCalledTimes(2); // Bob 5→9 closed

    expect(onChange).toHaveBeenNthCalledWith(1, {
      speaker_name: 'Alice', start_time: 1, end_time: 5,
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      speaker_name: 'Bob', start_time: 5, end_time: 9,
    });
  });

  // --- Teams: .fui-ChatMessageCompact block + data-tid selectors -------

  function teamsBlock(speaker, text) {
    const b = document.createElement('div');
    b.className = 'fui-ChatMessageCompact';
    b.innerHTML = `<span data-tid="author">${speaker}</span>`
      + `<span data-tid="closed-caption-text">${text}</span>`;
    return b;
  }

  function startTeams(onChange) {
    return startCaptionSpeakerObserver({
      root,
      getElapsedSeconds: () => elapsed,
      isActive: () => true,
      onChange,
      enableCaptions: () => {},
      badgeSelectors: '[data-tid="author"]',
      regionSelectors:
        "[data-tid='closed-caption-v2-window-wrapper'], [aria-live]",
      blockSelector: '.fui-ChatMessageCompact',
      textSelector: '[data-tid="closed-caption-text"]',
    });
  }

  it('Teams: reads author + caption-text and closes turn on change', async () => {
    const onChange = vi.fn();
    obs = startTeams(onChange);

    elapsed = 3;
    root.appendChild(teamsBlock('Priya', 'good morning team'));
    await tick();
    expect(obs.hasCaptions()).toBe(true);
    expect(onChange).not.toHaveBeenCalled();

    elapsed = 10;
    root.appendChild(teamsBlock('Sam', 'morning'));
    await tick();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      speaker_name: 'Priya', start_time: 3, end_time: 10,
    });
  });

  it('Teams: in-place text growth of the same block is not a new turn', async () => {
    const onChange = vi.fn();
    obs = startTeams(onChange);

    elapsed = 1;
    const blk = teamsBlock('Priya', 'good');
    root.appendChild(blk);
    await tick();

    // Teams finalizes by growing the same node's text in place.
    elapsed = 2;
    blk.querySelector('[data-tid="closed-caption-text"]').textContent = 'good morning everyone';
    await tick();

    expect(onChange).not.toHaveBeenCalled();
  });
});
