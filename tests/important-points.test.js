// Phase L4 — extension-side wiring for important-points extraction.
// Source-level contract tests (same pattern as popup-visibility +
// transcribe-l1-listening): we don't run the SW / offscreen / popup
// for real, just pin the wiring so a refactor that breaks the chain
// fails here first.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MessageType } from '../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const popupJs = readFileSync(resolve(here, '../src/popup/popup.js'), 'utf8');
const popupHtml = readFileSync(resolve(here, '../src/popup/popup.html'), 'utf8');
const popupCss = readFileSync(resolve(here, '../src/popup/popup.css'), 'utf8');
const swJs = readFileSync(
  resolve(here, '../src/background/service-worker.js'),
  'utf8',
);
const offscreenJs = readFileSync(
  resolve(here, '../src/offscreen/transcribe.js'),
  'utf8',
);

// ---- constants ----------------------------------------------------------

describe('Phase L4 constants', () => {
  it('MessageType.IMPORTANT_POINTS_UPDATE exists', () => {
    expect(MessageType.IMPORTANT_POINTS_UPDATE).toBe('IMPORTANT_POINTS_UPDATE');
  });
});

// ---- offscreen wiring ---------------------------------------------------

describe('offscreen — important_points routing', () => {
  it("routes msg.type === 'important_points' to IMPORTANT_POINTS_UPDATE", () => {
    // The offscreen WS message handler must detect the new wire
    // event shape + forward via the dedicated message type. A
    // missing branch would silently drop the relay's batches.
    expect(offscreenJs).toContain("msg.type === 'important_points'");
    expect(offscreenJs).toContain('MessageType.IMPORTANT_POINTS_UPDATE');
  });

  it('returns early after routing — does NOT also forward as TRANSCRIPT_EVENT', () => {
    // The important_points branch sits BEFORE the first-event +
    // TRANSCRIPT_EVENT-send paths so a single event isn't
    // double-routed. We check source order by locating each
    // anchor's first OCCURRENCE AS CODE (not comment).
    // ``type: MessageType.TRANSCRIPT_EVENT,`` is the actual emit
    // call — comments like "instead of TRANSCRIPT_EVENT" would
    // match a bare "TRANSCRIPT_EVENT" search and trip the test.
    const pongIdx = offscreenJs.indexOf("msg.type === 'pong'");
    const importantIdx = offscreenJs.indexOf("msg.type === 'important_points'");
    // The dedicated first-event ASSIGNMENT (not the let-decl).
    const firstEventIdx = offscreenJs.indexOf('firstEventSeen = true');
    // The actual emit call, not a comment reference.
    const transcriptEmitIdx = offscreenJs.indexOf('type: MessageType.TRANSCRIPT_EVENT');
    expect(pongIdx).toBeGreaterThan(-1);
    expect(importantIdx).toBeGreaterThan(pongIdx);
    expect(firstEventIdx).toBeGreaterThan(importantIdx);
    expect(transcriptEmitIdx).toBeGreaterThan(firstEventIdx);
  });
});

// ---- service-worker wiring ---------------------------------------------

describe('service-worker — importantPoints state + merger', () => {
  it('seeds INITIAL_TRANSCRIBE_STATE.importantPoints = []', () => {
    expect(swJs).toContain('importantPoints: []');
  });

  it('handles MessageType.IMPORTANT_POINTS_UPDATE', () => {
    expect(swJs).toContain('case MessageType.IMPORTANT_POINTS_UPDATE:');
  });

  it('dedups incoming points by id when merging', () => {
    // The handler builds a Set from existing IDs and skips
    // duplicates — defensive against reconnect-time re-emission.
    // Pin the substring presence (anywhere in the SW file is
    // fine; the dedup pattern doesn't appear elsewhere).
    expect(swJs).toMatch(/new Set\(existing\.map\(\(p\) =>\s*p\.id\)\)/);
    expect(swJs).toContain('seen.has(p.id)');
  });

  it('only re-saves state when the merge changed something', () => {
    // ``setTranscribeState`` only fires when the merged list is
    // longer than the existing list. Skip-on-no-op avoids waking
    // the popup for every duplicate batch (a reconnect storm
    // would otherwise re-broadcast unchanged state N times).
    expect(swJs).toContain('merged.length !== existing.length');
  });
});

// ---- popup wiring -------------------------------------------------------

describe('popup — important-points section', () => {
  it('declares the section + count + list elements in HTML', () => {
    expect(popupHtml).toContain('id="important-points-section"');
    expect(popupHtml).toContain('id="important-points-count"');
    expect(popupHtml).toContain('id="important-points-list"');
  });

  it('looks up every important-points element ID via the els map', () => {
    expect(popupJs).toContain("$('important-points-section')");
    expect(popupJs).toContain("$('important-points-count')");
    expect(popupJs).toContain("$('important-points-list')");
  });

  it('renderImportantPoints hides section when list empty', () => {
    expect(popupJs).toMatch(
      /function renderImportantPoints[\s\S]*?points\.length === 0[\s\S]*?classList\.add\('hidden'\)/,
    );
  });

  it('renderImportantPoints shows section + sets count when non-empty', () => {
    expect(popupJs).toContain(
      "els.importantPointsSection.classList.remove('hidden')",
    );
    expect(popupJs).toContain(
      'els.importantPointsCount.textContent = String(points.length)',
    );
  });

  it('formats every documented point type', () => {
    // The formatter must cover all four enum values. A new type
    // added on the backend without a mapping here would render
    // the raw enum string in the UI — pin the four we ship today.
    expect(popupJs).toContain("'action_item'");
    expect(popupJs).toContain("'decision'");
    expect(popupJs).toContain("'question'");
    expect(popupJs).toContain("'key_takeaway'");
  });

  it('renderTranscribeState forwards state.importantPoints to the renderer', () => {
    expect(popupJs).toContain('renderImportantPoints(');
    // Defensive — accept either array OR an empty list when state
    // hasn't seen any extraction yet.
    expect(popupJs).toMatch(
      /Array\.isArray\(state\.importantPoints\) \? state\.importantPoints : \[\]/,
    );
  });
});

// ---- CSS wiring ---------------------------------------------------------

describe('popup CSS — type-coloured chips', () => {
  it('declares one chip class per point type', () => {
    expect(popupCss).toContain('.important-point-type.action_item');
    expect(popupCss).toContain('.important-point-type.decision');
    expect(popupCss).toContain('.important-point-type.question');
    expect(popupCss).toContain('.important-point-type.key_takeaway');
  });

  it('caps the list at a max-height to scroll instead of overflowing', () => {
    // The popup is fixed-width; an unbounded list would push the
    // primary buttons off-screen. max-height + overflow-y on the
    // list container is the standard solve.
    expect(popupCss).toMatch(/\.important-points-list[\s\S]*?max-height/);
    expect(popupCss).toMatch(/\.important-points-list[\s\S]*?overflow-y/);
  });
});
