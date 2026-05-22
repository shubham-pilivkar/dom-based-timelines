// Phase 9 — low-priority polish. Source-contract tests for the six
// items shipped in this phase. The individual changes are all small
// enough that source-grep + module-level unit tests cover their
// contracts without needing full integration scaffolding.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it, vi, beforeEach } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, '..', rel), 'utf8');

const clientJs = read('src/api/client.js');
const overlayJs = read('src/transcribe/overlay.js');
const meetJs = read('src/content/meet.js');
const teamsJs = read('src/content/teams.js');
const offscreenJs = read('src/offscreen/offscreen.js');

// =====================================================================
// 9.1 — Bug 6.1: purge IDB chunks on RecordingDurationExceededError
// =====================================================================

describe('Bug 6.1 — purge IDB pending chunks on RecordingDurationExceededError', () => {
  it('exports purgeAllPendingForMeeting helper', async () => {
    const mod = await import('../src/api/client.js');
    expect(typeof mod.purgeAllPendingForMeeting).toBe('function');
  });

  it('helper accepts a meetingId and returns deleted count', async () => {
    const mod = await import('../src/api/client.js');
    // Empty / missing meetingId is a no-op returning 0 — defensive
    // guard so callers don't accidentally wipe ALL meetings.
    expect(await mod.purgeAllPendingForMeeting(null)).toBe(0);
    expect(await mod.purgeAllPendingForMeeting('')).toBe(0);
  });

  it('drain loop calls purgeAllPendingForMeeting in the cap-exceeded branch', () => {
    // Locate the branch via the existing RecordingDurationExceededError
    // catch site and assert the bulk-purge call sits there (not the
    // old single-row delete).
    const idx = clientJs.indexOf(
      'err instanceof RecordingDurationExceededError',
    );
    expect(idx).toBeGreaterThan(-1);
    const slice = clientJs.slice(idx, idx + 1200);
    expect(slice).toMatch(/purgeAllPendingForMeeting\(meetingId\)/);
    // Telemetry now carries the purged count so we can measure
    // how many bytes were avoided per cap-exceeded incident.
    expect(slice).toMatch(/purgedCount/);
  });

  it('falls back to single-chunk delete if bulk purge throws', () => {
    const idx = clientJs.indexOf(
      'err instanceof RecordingDurationExceededError',
    );
    const slice = clientJs.slice(idx, idx + 1200);
    // ``try { await purgeAllPendingForMeeting(...) } catch { delete one }``
    expect(slice).toMatch(/catch\s*\(\s*purgeErr/);
    expect(slice).toMatch(/await deleteChunk\(record\.id\)/);
  });
});

// =====================================================================
// 9.2 — Bug 10.1: selfName refresh on storage change
// =====================================================================

describe('Bug 10.1 — overlay refreshes selfName on storage change', () => {
  it('installs a chrome.storage.onChanged listener at module load', () => {
    expect(overlayJs).toMatch(/installSelfNameStorageListener\(\)/);
    // The listener guards installation so it can be called multiple
    // times safely (e.g. SPA re-mount).
    expect(overlayJs).toMatch(/_selfNameStorageListenerInstalled/);
  });

  it('reacts to USER_NAME or USER_EMAIL changes (the two keys that affect display name)', () => {
    const idx = overlayJs.indexOf('installSelfNameStorageListener');
    const fn = overlayJs.slice(idx, idx + 2000);
    expect(fn).toMatch(/StorageKey\.USER_NAME\s+in\s+changes/);
    expect(fn).toMatch(/StorageKey\.USER_EMAIL\s+in\s+changes/);
  });

  it('fires loadSelfNameFromStorage on change so speakerMap.selfName is refreshed', () => {
    const idx = overlayJs.indexOf('installSelfNameStorageListener');
    const fn = overlayJs.slice(idx, idx + 2000);
    expect(fn).toMatch(/loadSelfNameFromStorage\(\)/);
  });

  it('only listens for local-area changes (session/sync are irrelevant)', () => {
    const idx = overlayJs.indexOf('installSelfNameStorageListener');
    const fn = overlayJs.slice(idx, idx + 2000);
    expect(fn).toMatch(/area\s*!==\s*['"]local['"]/);
  });
});

// =====================================================================
// 9.3 — Bug 14.1: viewport upper-bound clamp on overlay drag
// =====================================================================

describe('Bug 14.1 — overlay drag clamps to viewport on the right/bottom', () => {
  it('drag handler reads window.innerWidth / innerHeight', () => {
    // The first ``dragMoveHandler`` token is the ``let`` declaration
    // — anchor on the assignment site to land in the actual body.
    const idx = overlayJs.indexOf('dragMoveHandler = (e) =>');
    expect(idx).toBeGreaterThan(-1);
    const slice = overlayJs.slice(idx, idx + 2200);
    expect(slice).toMatch(/window\.innerWidth/);
    expect(slice).toMatch(/window\.innerHeight/);
  });

  it('clamps right/bottom to leave MIN_VISIBLE_PX of the panel on-screen', () => {
    const idx = overlayJs.indexOf('dragMoveHandler = (e) =>');
    const slice = overlayJs.slice(idx, idx + 2200);
    expect(slice).toMatch(/MIN_VISIBLE_PX/);
    // The dual Math.min on the clamped axis ensures BOTH min (>=0)
    // and max (<= viewport - MIN_VISIBLE_PX) bounds are applied.
    expect(slice).toMatch(/Math\.min\([\s\S]*vw\s*-\s*MIN_VISIBLE_PX/);
    expect(slice).toMatch(/Math\.min\([\s\S]*vh\s*-\s*MIN_VISIBLE_PX/);
  });
});

// =====================================================================
// 9.4 — Bug 14.2: reset overlayPrefsLoaded on SPA unmount
// =====================================================================

describe('Bug 14.2 — overlay re-loads saved prefs on SPA re-mount', () => {
  it('ensureOverlay resets overlayPrefsLoaded when it has to (re)create the host', () => {
    const idx = overlayJs.indexOf('function ensureOverlay(');
    expect(idx).toBeGreaterThan(-1);
    const slice = overlayJs.slice(idx, idx + 1500);
    // The reset happens after the connected-guard early-return so
    // it only fires on the re-mount path.
    expect(slice).toMatch(/overlayPrefsLoaded\s*=\s*false/);
  });
});

// =====================================================================
// 9.5 — R4: performance.now() for content-script elapsed clock
// =====================================================================

describe('R4 — content scripts use performance.now() for the elapsed clock', () => {
  it('meet.js declares t0Perf alongside t0', () => {
    expect(meetJs).toMatch(/let\s+t0Perf\s*=\s*null/);
    expect(meetJs).toMatch(/let\s+pausedSincePerf\s*=\s*null/);
  });

  it('teams.js declares t0Perf alongside t0', () => {
    expect(teamsJs).toMatch(/let\s+t0Perf\s*=\s*null/);
    expect(teamsJs).toMatch(/let\s+pausedSincePerf\s*=\s*null/);
  });

  it('meet.js getElapsedSeconds prefers performance.now over Date.now', () => {
    const idx = meetJs.indexOf('function getElapsedSeconds(');
    const slice = meetJs.slice(idx, idx + 800);
    expect(slice).toMatch(/performance\.now\(\)\s*-\s*t0Perf/);
    expect(slice).toMatch(/performance\.now\(\)\s*-\s*pausedSincePerf/);
  });

  it('teams.js getElapsedSeconds prefers performance.now over Date.now', () => {
    const idx = teamsJs.indexOf('function getElapsedSeconds(');
    const slice = teamsJs.slice(idx, idx + 800);
    expect(slice).toMatch(/performance\.now\(\)\s*-\s*t0Perf/);
  });

  it('meet.js captures t0Perf in every lifecycle "started" branch', () => {
    // RECORDING_LIFECYCLE, BRIDGE_LIFECYCLE, TRANSCRIBE_LIFECYCLE — all
    // three set t0 + t0Perf together. Grep for the assignment count.
    const matches = meetJs.match(
      /t0Perf\s*=\s*typeof\s+performance\s*!==\s*['"]undefined['"]\s*\?\s*performance\.now\(\)/g,
    ) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('teams.js captures t0Perf in every lifecycle "started" branch', () => {
    const matches = teamsJs.match(
      /t0Perf\s*=\s*typeof\s+performance\s*!==\s*['"]undefined['"]\s*\?\s*performance\.now\(\)/g,
    ) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('falls back to Date.now() math when performance is unavailable', () => {
    // The fallback path (older builds / missing performance API)
    // must compute elapsed from t0 + accumulatedPausedMs without
    // touching the perf-now-domain pause state. Wider slice — the
    // perf-now branch has detailed comments that push the fallback
    // line past the previous 800-char window.
    const idx = meetJs.indexOf('function getElapsedSeconds(');
    const slice = meetJs.slice(idx, idx + 1600);
    expect(slice).toMatch(/Date\.now\(\)\s*-\s*t0\s*-\s*accumulatedPausedMs/);
  });
});

// =====================================================================
// 9.6 — R1: connection_changed telemetry (observability only)
// =====================================================================

describe('R1 — connection_changed telemetry on mid-session network shift', () => {
  it('offscreen wires connection.addEventListener("change") at module load', () => {
    // The listener is in an IIFE near the online/offline listeners.
    expect(offscreenJs).toMatch(
      /conn\.addEventListener\(\s*['"]change['"]\s*,/,
    );
  });

  it('emits a connection_changed TELEMETRY_EVENT with from/to fields', () => {
    const idx = offscreenJs.indexOf(
      "conn.addEventListener('change'",
    );
    const slice = offscreenJs.slice(idx, idx + 2000);
    expect(slice).toMatch(/name:\s*['"]connection_changed['"]/);
    // Bug-fix follow-up: baseline state moved to module-scoped
    // ``_connLastEffectiveType`` / ``_connLastSaveData`` so a session
    // start can refresh it via ``resetConnectionBaseline``. Test
    // updated to match the new identifiers.
    expect(slice).toMatch(/from:\s*_connLastEffectiveType/);
    expect(slice).toMatch(/to:\s*nextType/);
    expect(slice).toMatch(/downlinkMbps/);
  });

  it('only fires while a session is active (guarded by !session early-return)', () => {
    const idx = offscreenJs.indexOf(
      "conn.addEventListener('change'",
    );
    const slice = offscreenJs.slice(idx, idx + 2000);
    expect(slice).toMatch(/if\s*\(\s*!session\s*\)\s*return/);
  });

  it('deduplicates: noop when neither effectiveType nor saveData changed', () => {
    const idx = offscreenJs.indexOf(
      "conn.addEventListener('change'",
    );
    const slice = offscreenJs.slice(idx, idx + 2000);
    expect(slice).toMatch(/nextType\s*===\s*_connLastEffectiveType/);
    expect(slice).toMatch(/nextSaveData\s*===\s*_connLastSaveData/);
  });

  it('refreshes baseline at session start so the first in-session change reports the right "from"', () => {
    // Bug-fix follow-up: module-load capture was stale by session-
    // start. resetConnectionBaseline() must run at handleStart (when
    // ``session`` is assigned) so the first ``change`` event's
    // ``from`` field reflects the actual network at recording-start.
    expect(offscreenJs).toMatch(/function resetConnectionBaseline\s*\(/);
    expect(offscreenJs).toMatch(/resetConnectionBaseline\(\)/);
    // Confirm handleStart actually calls it just before assigning
    // session — search for the call site near "session = {".
    const sessionIdx = offscreenJs.indexOf('session = {');
    expect(sessionIdx).toBeGreaterThan(-1);
    // Slice the 400 chars BEFORE the session assignment.
    const slice = offscreenJs.slice(
      Math.max(0, sessionIdx - 400), sessionIdx,
    );
    expect(slice).toMatch(/resetConnectionBaseline\(\)/);
  });

  it('does NOT trigger a rotation (back-pressure handles degraded networks instead)', () => {
    // The intentional design (per the comment near line 442) is to
    // skip live bitrate adaptation. Verify the change handler does
    // NOT call rotateAudioContext or any rotation helper.
    const idx = offscreenJs.indexOf(
      "conn.addEventListener('change'",
    );
    const slice = offscreenJs.slice(idx, idx + 2000);
    expect(slice).not.toMatch(/rotateAudioContext/);
    expect(slice).not.toMatch(/buildRecordingStream/);
  });
});
