import { afterEach, describe, expect, it } from 'vitest';

import {
  createMeetSpeakerProbe,
  createTeamsPersonalSpeakerProbe,
  createTeamsBusinessSpeakerProbe,
  createTeamsSpeakerProbe,
} from '../src/lib/dom-speaker-probes.js';

// The probes read live DOM (happy-dom). Each test sets document.body and
// asserts what snapshot() reports — the contract startSpeakerDetector
// consumes: Array<{ id, name, speaking }> where it picks the first
// `speaking && name` tile.
afterEach(() => {
  document.body.innerHTML = '';
});

function speakingOf(snapshot) {
  return snapshot.find((t) => t.speaking && t.name) || null;
}

describe('createMeetSpeakerProbe', () => {
  it('flags the tile whose class count rises above the baseline', () => {
    document.body.innerHTML = `
      <main>
        <div class="tile"><span class="notranslate">Alice</span></div>
        <div class="tile speaking ring"><span class="notranslate">Bob</span></div>
      </main>`;
    const probe = createMeetSpeakerProbe();
    expect(probe.attributeFilter).toEqual(['class']);

    const snap = probe.snapshot();
    expect(snap).toHaveLength(2);
    // Baseline = 1 (Alice's single class); Bob has 3 → speaking.
    expect(speakingOf(snap)).toMatchObject({ name: 'Bob', speaking: true });
    expect(snap.find((t) => t.name === 'Alice').speaking).toBe(false);
  });

  it('reads the self-tile name from data-self-name', () => {
    document.body.innerHTML = `
      <main>
        <div class="tile"><span class="notranslate">Alice</span></div>
        <div class="tile speaking ring" data-self-name="Me"></div>
      </main>`;
    const snap = createMeetSpeakerProbe().snapshot();
    expect(speakingOf(snap)).toMatchObject({ name: 'Me', speaking: true });
  });

  it('keeps the baseline across snapshots so a later speaker is caught', () => {
    document.body.innerHTML = `
      <main>
        <div class="tile"><span class="notranslate">Alice</span></div>
        <div class="tile"><span class="notranslate">Bob</span></div>
      </main>`;
    const probe = createMeetSpeakerProbe();
    // Resting — nobody above baseline.
    expect(speakingOf(probe.snapshot())).toBeNull();
    // Alice starts speaking (gains classes) on a later tick.
    document.querySelectorAll('main > div')[0].className = 'tile speaking ring';
    expect(speakingOf(probe.snapshot())).toMatchObject({ name: 'Alice' });
  });

  it('returns [] when there is no <main> and never throws', () => {
    document.body.innerHTML = '<div>no meeting here</div>';
    expect(createMeetSpeakerProbe().snapshot()).toEqual([]);
  });
});

describe('createTeamsPersonalSpeakerProbe', () => {
  it('marks vdi-frame-occlusion indicators speaking, names via Video container', () => {
    document.body.innerHTML = `
      <div data-tid="calling-pagination">
        <div data-stream-type="Video" data-tid="Asha">
          <div data-tid="voice-level-stream-outline" class="vdi-frame-occlusion x"></div>
        </div>
        <div data-stream-type="Video" data-tid="Ravi">
          <div data-tid="voice-level-stream-outline" class="x"></div>
        </div>
      </div>`;
    const snap = createTeamsPersonalSpeakerProbe().snapshot();
    expect(snap).toHaveLength(2);
    expect(speakingOf(snap)).toMatchObject({ name: 'Asha', speaking: true });
    expect(snap.find((t) => t.name === 'Ravi').speaking).toBe(false);
  });

  it('strips the (Guest) suffix so guests merge with their named turns', () => {
    document.body.innerHTML = `
      <div data-tid="calling-pagination">
        <div data-stream-type="Video" data-tid="Asha (Guest)">
          <div data-tid="voice-level-stream-outline" class="vdi-frame-occlusion"></div>
        </div>
      </div>`;
    const snap = createTeamsPersonalSpeakerProbe().snapshot();
    expect(speakingOf(snap)).toMatchObject({ name: 'Asha' });
  });
});

describe('createTeamsBusinessSpeakerProbe', () => {
  it('extracts the name from the arrow-navigator roster row', () => {
    document.body.innerHTML = `
      <div data-tid="call-roster">
        <div data-acc-id="arrow-navigator-1">
          <div data-tid="row-meta"></div>
          <div><div>Carol</div></div>
          <div data-tid="voice-level-stream-outline" class="vdi-frame-occlusion"></div>
        </div>
      </div>`;
    const snap = createTeamsBusinessSpeakerProbe().snapshot();
    expect(speakingOf(snap)).toMatchObject({ name: 'Carol', speaking: true });
  });

  it('returns [] when no indicators are present', () => {
    document.body.innerHTML = '<div data-tid="call-roster"></div>';
    expect(createTeamsBusinessSpeakerProbe().snapshot()).toEqual([]);
  });
});

describe('createTeamsSpeakerProbe (hostname routing)', () => {
  it('uses the Personal probe (calling-pagination root) on teams.live.com', () => {
    document.body.innerHTML = `
      <div data-tid="calling-pagination" id="pag"></div>
      <div data-tid="call-roster" id="roster"></div>`;
    const probe = createTeamsSpeakerProbe('teams.live.com');
    expect(probe.observeRoot.id).toBe('pag');
  });

  it('uses the Business probe (call-roster root) on teams.microsoft.com', () => {
    document.body.innerHTML = `
      <div data-tid="calling-pagination" id="pag"></div>
      <div data-tid="call-roster" id="roster"></div>`;
    const probe = createTeamsSpeakerProbe('teams.microsoft.com');
    expect(probe.observeRoot.id).toBe('roster');
  });
});
