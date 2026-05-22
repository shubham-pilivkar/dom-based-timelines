// DOM tile-indicator speaker probes — the "dom" half of
// SPEAKER_TIMELINE_STRATEGY (see constants.js). Ported from the
// server-side Playwright meeting-bot's speaker detection
// (GoogleMeetSpeakerEvent / TeamsPersonalSpeakerEvent /
// TeamsBusinessSpeakerEvent) into in-page probes that feed the existing
// lib/speaker-detector.js (`startSpeakerDetector`).
//
// Why probes instead of the bot's MutationObserver-emits-START/END
// design: the bot ran remotely and shipped events out via
// `console.log('[SPEAKER]'…)` + `Page.on('console')`. Inside a content
// script there's no such bridge — the detector already owns a
// MutationObserver, debounce, polling fallback, flush/dispose and the
// `selectors_broken` health signal. So each probe only has to answer
// the snapshot question the detector asks on every tick:
//
//     "Which participant tiles exist, and which one is speaking RIGHT NOW?"
//
// A probe is `{ snapshot(), observeRoot, attributeFilter }` matching the
// SpeakerProbe typedef in lib/speaker-detector.js. `snapshot()` returns
// `Array<{ id, name, speaking }>`; the detector picks the first
// `speaking && name` tile, debounces it, and emits the SAME
// `{speaker_name, start_time, end_time}` events the caption path emits.
//
// Detection heuristics, per platform (verbatim from the bot):
//   * Google Meet — a tile is speaking when its CSS class count rises
//     above a self-calibrating baseline (Meet adds the animated
//     speaking-ring classes to the active tile). The baseline is the
//     lowest class count ever seen, tracked per probe instance.
//   * Teams (Personal & Business) — a voice-level indicator is speaking
//     when it carries the `vdi-frame-occlusion` class. Name extraction
//     is the only Personal-vs-Business difference.
//
// Best-effort throughout: a probe NEVER throws (the detector wraps
// snapshot() in try/catch too, but we keep it total here so a single
// malformed tile can't blank the whole snapshot).

/**
 * @typedef {import('./speaker-detector.js').SpeakerProbe} SpeakerProbe
 */

// Strip the trailing status suffixes Teams appends to display names so
// "Asha (Guest)" and "Asha" map to one speaker on the timeline.
function cleanName(name) {
  if (!name) return '';
  return name
    .replace(/\s*\((Guest|unverified)\)\s*$/i, '')
    .trim();
}

// Names shorter than 2 / longer than 60 chars are almost always UI
// chrome (initials avatars, status strings) rather than a real
// participant name — mirror the caption observer's same guard so the
// two strategies agree on what counts as a name.
function saneName(name) {
  const n = cleanName(name);
  return n.length >= 2 && n.length <= 60 ? n : '';
}

// ---------------------------------------------------------------------------
// Google Meet
// ---------------------------------------------------------------------------

// Meet renders the participant name inside `span.notranslate`; the
// self-tile also exposes it on the `data-self-name` attribute.
function meetTileName(tile) {
  try {
    const self = tile.getAttribute?.('data-self-name');
    if (self && self.trim()) return saneName(self);
    const span = tile.querySelector?.('span.notranslate');
    return saneName(span?.textContent || '');
  } catch {
    return '';
  }
}

/**
 * Google Meet speaker probe. Speaking = a tile's class count exceeds the
 * self-calibrating baseline (lowest class count ever observed). Ported
 * from GoogleMeetSpeakerEvent.setupSpeakerDetection.
 *
 * @returns {SpeakerProbe}
 */
export function createMeetSpeakerProbe() {
  // Baseline: the smallest class count any tile has shown. Meet's idle
  // tiles sit at this floor; the active speaker's tile gains the
  // speaking-ring classes and rises above it. Monotonically decreasing,
  // so it auto-calibrates to whatever the current Meet build uses
  // without a hardcoded magic threshold.
  let minClassCount = Number.MAX_SAFE_INTEGER;
  const root = (typeof document !== 'undefined'
    && document.querySelector('main')) || document.body;

  return {
    observeRoot: root,
    attributeFilter: ['class'],
    snapshot() {
      const main = document.querySelector('main');
      if (!main) return [];
      const out = [];
      // Direct <div> children of <main> are the participant tiles.
      const tiles = Array.from(main.children).filter(
        (c) => c.tagName === 'DIV',
      );
      // First pass: re-baseline against the CURRENT tiles so the floor
      // tracks the live DOM (a tile re-mount can briefly shrink the
      // class count).
      for (const tile of tiles) {
        const cc = tile.classList?.length ?? 0;
        if (cc < minClassCount) minClassCount = cc;
      }
      for (let i = 0; i < tiles.length; i += 1) {
        const tile = tiles[i];
        const cc = tile.classList?.length ?? 0;
        const name = meetTileName(tile);
        out.push({
          id: name || `meet-tile-${i}`,
          name,
          speaking: cc > minClassCount,
        });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Microsoft Teams (shared)
// ---------------------------------------------------------------------------

// The speaking indicator both Teams clients animate.
const TEAMS_INDICATOR_SEL = '[data-tid="voice-level-stream-outline"]';
const TEAMS_SPEAKING_CLASS = 'vdi-frame-occlusion';

// Teams Personal: the display name lives on the `data-tid` of the
// enclosing video container (`<div data-tid="Asha" data-stream-type="Video">`).
function teamsPersonalName(indicator) {
  try {
    const video = indicator.closest?.('[data-stream-type="Video"]');
    const tid = video?.getAttribute?.('data-tid');
    if (tid && tid.trim()) return saneName(tid);
  } catch { /* fall through */ }
  return '';
}

// Teams Business: walk up to the roster row
// (`[data-acc-id^="arrow-navigator-"]`) and read the name cell, with the
// obfuscated-class fallback the bot used for enterprise builds.
function teamsBusinessName(indicator) {
  try {
    const row = indicator.closest?.('[data-acc-id^="arrow-navigator-"]');
    if (!row) return '';
    const nameEl = row.querySelector?.('div[data-tid] + div > div');
    if (nameEl?.textContent?.trim()) return saneName(nameEl.textContent);
    const fallback = row.querySelector?.('div[class*="___2u340f0"]');
    if (fallback?.textContent?.trim()) return saneName(fallback.textContent);
  } catch { /* fall through */ }
  return '';
}

// Last-resort name resolver shared by both Teams probes: climb the
// ancestors looking for any `data-tid` that reads like a participant
// name rather than a structural id.
function teamsAncestorName(indicator) {
  try {
    let parent = indicator.parentElement;
    while (parent) {
      const tid = parent.getAttribute?.('data-tid');
      if (
        tid
        && !/voice-level|avatar|pagination|stream-outline/i.test(tid)
      ) {
        const n = saneName(tid);
        if (n) return n;
      }
      parent = parent.parentElement;
    }
  } catch { /* noop */ }
  return '';
}

// Build a Teams probe given the roster container selector and an ORDERED
// list of name resolvers (primary strategy first, the other as a
// cross-client fallback, then the generic ancestor walk). Both clients
// share the same `vdi-frame-occlusion` speaking signal.
function makeTeamsProbe(rootSelector, resolvers) {
  const root = (typeof document !== 'undefined'
    && document.querySelector(rootSelector)) || document.body;
  return {
    observeRoot: root,
    attributeFilter: ['class'],
    snapshot() {
      const indicators = document.querySelectorAll(TEAMS_INDICATOR_SEL);
      const out = [];
      let i = 0;
      for (const indicator of indicators) {
        const speaking = !!indicator.classList?.contains(TEAMS_SPEAKING_CLASS);
        let name = '';
        for (const resolve of resolvers) {
          name = resolve(indicator);
          if (name) break;
        }
        out.push({ id: name || `teams-p-${i}`, name, speaking });
        i += 1;
      }
      return out;
    },
  };
}

/**
 * Teams Personal (consumer / teams.live.com) speaker probe. Ported from
 * TeamsPersonalSpeakerEvent — name from the video container's data-tid,
 * with the Business resolver as a cross-client fallback.
 *
 * @returns {SpeakerProbe}
 */
export function createTeamsPersonalSpeakerProbe() {
  return makeTeamsProbe(
    '[data-tid="calling-pagination"]',
    [teamsPersonalName, teamsBusinessName, teamsAncestorName],
  );
}

/**
 * Teams Business (work / teams.microsoft.com) speaker probe. Ported from
 * TeamsBusinessSpeakerEvent — name from the arrow-navigator roster row,
 * with the Personal resolver as a cross-client fallback.
 *
 * @returns {SpeakerProbe}
 */
export function createTeamsBusinessSpeakerProbe() {
  return makeTeamsProbe(
    '[data-tid="call-roster"]',
    [teamsBusinessName, teamsPersonalName, teamsAncestorName],
  );
}

/**
 * Pick the right Teams probe for the current client. teams.live.com is
 * the consumer (Personal) client; teams.microsoft.com is work
 * (Business). Each probe already cross-falls-back to the other's name
 * resolver, so a hostname misread degrades to slightly worse name
 * extraction, never to no detection.
 *
 * @param {string} [hostname] override for tests
 * @returns {SpeakerProbe}
 */
export function createTeamsSpeakerProbe(hostname) {
  const host = hostname
    ?? (typeof location !== 'undefined' ? location.hostname : '');
  return /(^|\.)teams\.live\.com$/i.test(host)
    ? createTeamsPersonalSpeakerProbe()
    : createTeamsBusinessSpeakerProbe();
}
