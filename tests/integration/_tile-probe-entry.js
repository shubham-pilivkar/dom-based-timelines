// esbuild entry for the live tile-detector probe. It bundles the REAL
// production speaker-detector state machine (src/lib/speaker-detector
// .js — debounce / commit / observer / poll-fallback) together with
// the EXACT participant-tile probe selectors from src/content/meet.js
// and src/content/teams.js, and exposes a single page global.
//
// The selector functions below are copied VERBATIM from the content
// scripts (Meet/Teams sections). They MUST stay byte-identical — this
// harness's whole point is to validate them against the live DOM.
// (The content scripts define these inline and don't export them, so
// a copy is unavoidable without refactoring production code.)

import { startSpeakerDetector } from '../../src/lib/speaker-detector.js';

const UI_LABEL = /^(camera|mic|microphone|video|audio|presenting|presentation|hand)\s*(off|on|muted|unmuted|raised|lowered)?$|^you$|^pinned$|^speaking$|^muted$/i;

function looksLikeName(txt) {
  if (!txt) return false;
  if (txt.length < 2 || txt.length > 60) return false;
  if (/[<>{}]/.test(txt)) return false;
  if (!/[a-zA-Z]/.test(txt)) return false;
  if (UI_LABEL.test(txt)) return false;
  return true;
}

/* ---------------- Google Meet (verbatim from meet.js) ------------- */

function meetParticipantTiles() {
  const set = new Set();
  for (const sel of [
    '[data-participant-id]',
    '[data-self-name]',
    'div[data-allocation-index]',
    '[data-requested-participant-id]',
    '[jsname][data-participant-id]',
  ]) {
    document.querySelectorAll(sel).forEach((el) => set.add(el));
  }
  if (set.size > 0) return [...set];
  document.querySelectorAll('[aria-label]').forEach((el) => {
    const lbl = (el.getAttribute('aria-label') || '').trim();
    if (!lbl || lbl.length > 80) return;
    const name = lbl.split(',')[0].replace(/\(you\)/i, '').trim();
    if (!looksLikeName(name)) return;
    if (el.querySelector('video, img, [data-self-name]')
      || el.matches('[jscontroller]')) {
      set.add(el);
    }
  });
  return [...set];
}

function meetIsSpeaking(tile) {
  if (tile.matches('[data-is-speaking="true"], [aria-label*="is speaking" i]')
    || tile.querySelector('[data-is-speaking="true"], [aria-label*="is speaking" i]')) {
    return true;
  }
  if (/speaking/i.test(tile.className || '')) return true;
  if (tile.querySelector('[class*="speaking" i], [class*="Speaking"]')) return true;
  const indicators = tile.querySelectorAll(
    '[jsname="r4nke"],[jsname="ZRYbgc"],[data-audio-level],'
    + '[class*="audio" i] [class*="bar" i],svg[class*="ripple" i]',
  );
  for (const ind of indicators) {
    const cs = getComputedStyle(ind);
    if (parseFloat(cs.opacity || '0') > 0.2
      || (cs.animationName && cs.animationName !== 'none')) {
      return true;
    }
  }
  return false;
}

function meetResolveName(tile) {
  const selfName = tile.getAttribute('data-self-name');
  if (selfName) return selfName;
  const namedChild = tile.querySelector('[data-self-name]');
  if (namedChild) {
    const v = namedChild.getAttribute('data-self-name') || namedChild.textContent?.trim();
    if (looksLikeName(v)) return v;
  }
  const aria = tile.getAttribute('aria-label');
  if (aria) {
    const head = aria.split(',')[0]
      .replace(/\bpinned\b|\bspeaking\b|\bmuted\b|\(you\)/gi, '')
      .trim();
    if (looksLikeName(head)) return head;
  }
  const candidates = tile.querySelectorAll('div, span');
  for (const el of candidates) {
    const txt = el.textContent?.trim();
    if (looksLikeName(txt)) return txt;
  }
  return '';
}

function meetProbe() {
  return {
    observeRoot: document.body,
    attributeFilter: ['class', 'data-is-speaking', 'style'],
    snapshot: () => meetParticipantTiles().map((tile) => ({
      id: tile.getAttribute('data-participant-id')
        ?? tile.getAttribute('data-self-name') ?? '',
      name: meetResolveName(tile),
      speaking: meetIsSpeaking(tile),
    })),
  };
}

/* ---------------- Microsoft Teams (verbatim from teams.js) -------- */

function teamsParticipantTiles() {
  const set = new Set();
  for (const sel of [
    '[data-tid="participant-tile"]',
    '[data-tid="video-tile"]',
    '[data-tid*="roster-participant" i]',
    '[data-cid="calling-participant-stream"]',
    '[data-tid*="participant" i][aria-label]',
  ]) {
    document.querySelectorAll(sel).forEach((el) => set.add(el));
  }
  if (set.size > 0) return [...set];
  document.querySelectorAll('[role="group"][aria-label],[aria-label]').forEach((el) => {
    const lbl = (el.getAttribute('aria-label') || '').trim();
    if (!lbl || lbl.length > 80) return;
    const name = lbl.split(',')[0].replace(/\(you\)/i, '').trim();
    if (looksLikeName(name) && el.querySelector('video, img')) set.add(el);
  });
  return [...set];
}

function teamsIsSpeaking(tile) {
  if (tile.matches('[class*="is-speaking" i], [aria-label*="is speaking" i],'
    + '[data-is-speaking="true"]')
    || tile.querySelector('[class*="is-speaking" i], [data-is-speaking="true"],'
      + '[aria-label*="is speaking" i]')) {
    return true;
  }
  if (/speaking/i.test(tile.className || '')) return true;
  if (tile.querySelector('[class*="speaking" i], [class*="Speaking"]')) return true;
  const rings = tile.querySelectorAll(
    '[class*="voice-level" i],[class*="voiceLevel"],[class*="audio" i] svg,'
    + '[data-cid*="audio" i]',
  );
  for (const ring of rings) {
    const cs = getComputedStyle(ring);
    if (parseFloat(cs.opacity || '0') > 0.2
      || (cs.animationName && cs.animationName !== 'none')) {
      return true;
    }
  }
  return false;
}

function teamsResolveName(tile) {
  const named = tile.querySelector(
    '[data-tid="participant-name"],[data-tid*="display-name" i],'
    + '[class*="participant-name" i],[class*="displayName"]',
  );
  if (named) {
    const txt = named.textContent?.trim();
    if (looksLikeName(txt)) return txt;
  }
  const aria = tile.getAttribute('aria-label')
    || tile.querySelector('[aria-label]')?.getAttribute('aria-label');
  if (aria) {
    const head = aria.split(',')[0]
      .replace(/\bpinned\b|\bspeaking\b|\bmuted\b|\(you\)/gi, '')
      .trim();
    if (looksLikeName(head)) return head;
  }
  return '';
}

function teamsProbe() {
  return {
    observeRoot: document.body,
    attributeFilter: ['class', 'aria-label'],
    snapshot: () => teamsParticipantTiles().map((tile, i) => ({
      id: tile.getAttribute('data-tid-id') ?? String(i),
      name: teamsResolveName(tile),
      speaking: teamsIsSpeaking(tile),
    })),
  };
}

/* ---------------- page bridge ------------------------------------- */

window.__mmTileStart = (platform) => {
  window.__mmTurns = [];
  window.__mmDiag = () => {
    const probe = platform === 'teams' ? teamsProbe() : meetProbe();
    let snap = [];
    try { snap = probe.snapshot(); } catch (e) { snap = [{ err: String(e) }]; }
    return {
      tiles: snap.length,
      speakingNow: snap.filter((s) => s.speaking).map((s) => s.name || s.id),
      names: snap.map((s) => s.name).filter(Boolean).slice(0, 12),
    };
  };
  const t0 = Date.now();
  const handle = startSpeakerDetector({
    probe: platform === 'teams' ? teamsProbe() : meetProbe(),
    getElapsedSeconds: () => (Date.now() - t0) / 1000,
    isActive: () => true,
    onChange: (e) => {
      window.__mmTurns.push(e);
      console.log('[probe] SPEAKER_CHANGE ' + JSON.stringify(e));
    },
    onTelemetry: (n, p) => console.log('[probe] telemetry ' + n + ' '
      + JSON.stringify(p || {})),
  });
  window.__mmStop = () => {
    try { handle.flush(); } catch (e) { /* noop */ }
    try { handle.dispose(); } catch (e) { /* noop */ }
  };
  return true;
};
