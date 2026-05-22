// esbuild entry for the DOM speaker-timeline e2e. Bundles the REAL
// production probes (src/lib/dom-speaker-probes.js) + the REAL detector
// state machine (src/lib/speaker-detector.js) into one IIFE and exposes
// a page bridge, so the Playwright spec can drive them against a
// synthetic meeting DOM in a real Chromium and read the emitted
// SPEAKER_CHANGE turns.
//
// This is the dom-strategy counterpart of _tile-probe-entry.js. Unlike
// that legacy probe (which copied selectors), this imports the SAME
// probe code the content scripts ship, so the e2e validates production
// behaviour, not a copy.

import { startSpeakerDetector } from '../../src/lib/speaker-detector.js';
import {
  createMeetSpeakerProbe,
  createTeamsPersonalSpeakerProbe,
  createTeamsBusinessSpeakerProbe,
} from '../../src/lib/dom-speaker-probes.js';

function probeFor(kind) {
  if (kind === 'teams-personal') return createTeamsPersonalSpeakerProbe();
  if (kind === 'teams-business') return createTeamsBusinessSpeakerProbe();
  return createMeetSpeakerProbe();
}

window.__mmDomStart = (kind) => {
  window.__mmTurns = [];
  const probe = probeFor(kind);
  // Per-tick diagnostics so a failing assertion can show WHY (which
  // tiles were seen, who read as speaking).
  window.__mmDiag = () => {
    let snap = [];
    try { snap = probe.snapshot(); } catch (e) { snap = [{ err: String(e) }]; }
    return {
      tiles: snap.length,
      speakingNow: snap.filter((s) => s.speaking).map((s) => s.name || s.id),
      names: snap.map((s) => s.name).filter(Boolean),
    };
  };
  const t0 = Date.now();
  const handle = startSpeakerDetector({
    probe,
    getElapsedSeconds: () => (Date.now() - t0) / 1000,
    isActive: () => true,
    onChange: (e) => {
      window.__mmTurns.push(e);
      // Mirrors meet.js/teams.js emitSpeakerChange shape sans transport.
      console.log('[domprobe] SPEAKER_CHANGE ' + JSON.stringify(e));
    },
    onTelemetry: (n, p) => console.log(
      '[domprobe] telemetry ' + n + ' ' + JSON.stringify(p || {}),
    ),
  });
  window.__mmStop = () => {
    try { handle.flush(); } catch (e) { /* noop */ }
    try { handle.dispose(); } catch (e) { /* noop */ }
  };
  return true;
};
