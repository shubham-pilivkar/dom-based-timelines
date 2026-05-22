// Mode 3 ("you + others") wiring tests. Mode 3 captures the user's
// mic AND the meeting tab audio as two parallel WebSocket streams,
// each backed by its own backend session. The extension owns the
// merge into a unified timeline; the backend never sees "both" — it
// just sees two normal sessions (one ``self``, one ``participants``).
//
// Same source-text contract style as `transcribe-edge-cases.test.js`:
// we don't run the SW / offscreen / overlay for real, just pin the
// wiring so a refactor that breaks one piece fails here first.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  StreamRole,
  TranscribeMode,
} from '../src/constants.js';
import { SpeakerNameMap } from '../src/transcribe/speaker-name-map.js';

const here = dirname(fileURLToPath(import.meta.url));
const swJs = readFileSync(
  resolve(here, '../src/background/service-worker.js'),
  'utf8',
);
const offscreenJs = readFileSync(
  resolve(here, '../src/offscreen/transcribe.js'),
  'utf8',
);
const overlayJs = readFileSync(
  resolve(here, '../src/transcribe/overlay.js'),
  'utf8',
);
const popupJs = readFileSync(
  resolve(here, '../src/popup/popup.js'),
  'utf8',
);
const popupHtml = readFileSync(
  resolve(here, '../src/popup/popup.html'),
  'utf8',
);

// ---- constants ---------------------------------------------------------

describe('Mode 3 — constants', () => {
  it("TranscribeMode.BOTH is 'both'", () => {
    expect(TranscribeMode.BOTH).toBe('both');
  });

  it('StreamRole enum exists with mic + tab values', () => {
    expect(StreamRole.MIC).toBe('mic');
    expect(StreamRole.TAB).toBe('tab');
  });
});

// ---- popup picker ------------------------------------------------------

describe('Mode 3 — popup picker', () => {
  it('exposes the third mode in the dropdown', () => {
    // The HTML must offer ``value="both"`` so users can actually
    // pick Mode 3; a missing option silently strands the feature
    // even though the code path works.
    expect(popupHtml).toContain('value="both"');
    expect(popupHtml).toMatch(/You\s*\+\s*others/);
  });

});

// ---- SW state + dual-session creation ----------------------------------

describe('Mode 3 — SW dual-session creation', () => {
  it('INITIAL_TRANSCRIBE_STATE carries sessionIdTab', () => {
    expect(swJs).toContain('sessionIdTab: null');
  });

  it('startTranscribe mints two sessions in parallel for mode=both', () => {
    // The two ``startTranscribeSession`` calls must be wrapped in
    // Promise.all — sequential calls would double-cost the
    // user-visible latency for no benefit. Pin the shape so a
    // refactor doesn't accidentally serialise them.
    const fnIdx = swJs.indexOf('async function startTranscribe(');
    expect(fnIdx).toBeGreaterThan(-1);
    const next = swJs.indexOf('\nasync function ', fnIdx + 1);
    const body = swJs.slice(fnIdx, next === -1 ? swJs.length : next);
    expect(body).toContain("if (mode === 'both')");
    expect(body).toContain('Promise.all');
    expect(body).toMatch(/startTranscribeSession\([\s\S]*?mode:\s*'self'/);
    expect(body).toMatch(/startTranscribeSession\([\s\S]*?mode:\s*'participants'/);
  });

  it('OFFSCREEN_TRANSCRIBE_START ride-along carries wsUrlTab + audioFormatTab', () => {
    // The offscreen needs both URLs in a single round-trip;
    // dropping wsUrlTab would silently downgrade Mode 3 to
    // mic-only without surfacing a useful error.
    expect(swJs).toContain('wsUrlTab:');
    expect(swJs).toContain('audioFormatTab:');
  });

  it("requires a meeting tab for mode=both (mode_requires_meeting_tab)", () => {
    // Same hard requirement as Mode 2 — tabCapture needs a target.
    expect(swJs).toContain("'mode_requires_meeting_tab'");
    // The guard branches on both modes that need the tab.
    expect(swJs).toMatch(/mode === 'participants' \|\| mode === 'both'/);
  });
});

// ---- A2: tabCapture streamId freshness ---------------------------------

describe('A2 — streamId minted last, not before startMeeting', () => {
  it('startRecording fetches the streamId AFTER ensureOffscreen()', () => {
    // The tabCapture streamId is short-lived — it must be consumed by
    // getUserMedia within seconds. If it were minted before the
    // ``startMeeting`` backend round-trip, a slow/mobile network could
    // leave it dead by the time the offscreen doc uses it (recording
    // fails silently mid-setup). Pin that the acquisition sits AFTER
    // ensureOffscreen() and BEFORE the OFFSCREEN_START dispatch loop.
    const fnIdx = swJs.indexOf('async function startRecording(');
    expect(fnIdx).toBeGreaterThan(-1);
    const next = swJs.indexOf('\nasync function ', fnIdx + 1);
    const body = swJs.slice(fnIdx, next === -1 ? swJs.length : next);

    const startMeetingIdx = body.indexOf('await startMeeting(');
    const ensureOffscreenIdx = body.indexOf('await ensureOffscreen()');
    const streamIdIdx = body.indexOf('await getMediaStreamId(');
    const offscreenStartIdx = body.indexOf('MessageType.OFFSCREEN_START');

    expect(startMeetingIdx).toBeGreaterThan(-1);
    expect(ensureOffscreenIdx).toBeGreaterThan(-1);
    expect(streamIdIdx).toBeGreaterThan(-1);
    expect(offscreenStartIdx).toBeGreaterThan(-1);

    // Order invariant: startMeeting → ensureOffscreen → getMediaStreamId
    // → OFFSCREEN_START.
    expect(streamIdIdx).toBeGreaterThan(startMeetingIdx);
    expect(streamIdIdx).toBeGreaterThan(ensureOffscreenIdx);
    expect(offscreenStartIdx).toBeGreaterThan(streamIdIdx);
  });

  it('a stale-window streamId fetch is NOT left before startMeeting', () => {
    const fnIdx = swJs.indexOf('async function startRecording(');
    const next = swJs.indexOf('\nasync function ', fnIdx + 1);
    const body = swJs.slice(fnIdx, next === -1 ? swJs.length : next);
    // Exactly one acquisition site in startRecording.
    const matches = body.match(/await getMediaStreamId\(/g) || [];
    expect(matches.length).toBe(1);
  });

  it('startTranscribe mints the streamId LAST — after ensureMicPermission (Mode 3 regression)', () => {
    // Mode 3 ("both") calls ensureMicPermission(), which can hold a
    // permission window open for up to 90s. The OLD code minted the
    // tabCapture streamId at step 1, BEFORE that window, so it was
    // dead by the time the offscreen consumed it and Chrome refused
    // the capture ("Could not capture the tab —"). The mint must sit
    // AFTER ensureMicPermission + ensureOffscreen + the session mint,
    // and immediately BEFORE the OFFSCREEN_TRANSCRIBE_START dispatch.
    const fnIdx = swJs.indexOf('async function startTranscribe(');
    expect(fnIdx).toBeGreaterThan(-1);
    const next = swJs.indexOf('\nasync function ', fnIdx + 1);
    const body = swJs.slice(fnIdx, next === -1 ? swJs.length : next);

    const micPermIdx = body.indexOf('await ensureMicPermission()');
    const ensureOffscreenIdx = body.indexOf('await ensureOffscreen()');
    const sessionMintIdx = body.indexOf('await startTranscribeSession(');
    const streamIdIdx = body.indexOf('await getMediaStreamId(');
    const offscreenStartIdx = body.indexOf(
      'MessageType.OFFSCREEN_TRANSCRIBE_START',
    );

    expect(micPermIdx).toBeGreaterThan(-1);
    expect(ensureOffscreenIdx).toBeGreaterThan(-1);
    expect(sessionMintIdx).toBeGreaterThan(-1);
    expect(streamIdIdx).toBeGreaterThan(-1);
    expect(offscreenStartIdx).toBeGreaterThan(-1);

    // Order invariant: mic-permission → ensureOffscreen → session mint
    // → getMediaStreamId → OFFSCREEN_TRANSCRIBE_START.
    expect(streamIdIdx).toBeGreaterThan(micPermIdx);
    expect(streamIdIdx).toBeGreaterThan(ensureOffscreenIdx);
    expect(streamIdIdx).toBeGreaterThan(sessionMintIdx);
    expect(offscreenStartIdx).toBeGreaterThan(streamIdIdx);

    // Exactly one acquisition site — no stale step-1 mint left behind.
    expect((body.match(/await getMediaStreamId\(/g) || []).length).toBe(1);
  });

  it('a tabCapture mint failure releases the already-minted backend session', () => {
    // Because the streamId is now minted AFTER the session, a refusal
    // must release the live row(s) or they linger for the 5h
    // stale-grace and burn the per-user concurrency cap.
    const fnIdx = swJs.indexOf('async function startTranscribe(');
    const next = swJs.indexOf('\nasync function ', fnIdx + 1);
    const body = swJs.slice(fnIdx, next === -1 ? swJs.length : next);
    const mintIdx = body.indexOf('await getMediaStreamId(');
    const catchBlock = body.slice(mintIdx, mintIdx + 600);
    expect(catchBlock).toContain('tabCapture_failed');
    expect(catchBlock).toContain('releaseTranscribeSession(session.ws_url)');
    expect(catchBlock).toMatch(/sessionTab\?\.ws_url[\s\S]*?releaseTranscribeSession/);
  });
});

// ---- offscreen dual capture --------------------------------------------

describe('Mode 3 — offscreen dual capture', () => {
  it('declares a sessionTab global for the tab substream', () => {
    expect(offscreenJs).toContain('let sessionTab = null');
  });

  it('activeStreams() iterates both substreams in order', () => {
    // The iteration order matters for tearDown (mic-first so a
    // partial bring-up tears down in the reverse-of-set-up order).
    expect(offscreenJs).toContain('function activeStreams()');
    const fnIdx = offscreenJs.indexOf('function activeStreams()');
    const next = offscreenJs.indexOf('\nfunction ', fnIdx + 1);
    const body = offscreenJs.slice(fnIdx, next === -1 ? offscreenJs.length : next);
    // Mic first, tab second.
    const sessIdx = body.indexOf('push(session)');
    const tabIdx = body.indexOf('push(sessionTab)');
    expect(sessIdx).toBeGreaterThan(-1);
    expect(tabIdx).toBeGreaterThan(sessIdx);
  });

  it("startTranscribe branches on 'both' and opens both streams", () => {
    const fnIdx = offscreenJs.indexOf('async function startTranscribe(');
    expect(fnIdx).toBeGreaterThan(-1);
    const next = offscreenJs.indexOf('\nasync function ', fnIdx + 1);
    const body = offscreenJs.slice(fnIdx, next === -1 ? offscreenJs.length : next);
    expect(body).toContain("if (mode === 'both')");
    // A3 — parallel mic + tab capture via allSettled (NOT Promise.all,
    // which would leak the sibling stream on a one-sided failure).
    expect(body).toMatch(/Promise\.allSettled\(\s*\[\s*getMicStream\(\)/);
    expect(body).toMatch(/getTabStream\(tabStreamId\)/);
    // Both substreams get set up via _setupStream with explicit
    // roles.
    expect(body).toMatch(/_setupStream\([\s\S]*?role:\s*'mic'/);
    expect(body).toMatch(/_setupStream\([\s\S]*?role:\s*'tab'/);
  });

  it('A3 — partial Mode-3 bring-up stops the surviving sibling stream', () => {
    // ``Promise.all`` rejects on first failure but the other capture
    // can still resolve a LIVE MediaStream that then leaks (mic stays
    // in-use / tab-capture indicator stays lit). The allSettled path
    // must explicitly stop the fulfilled sibling's tracks before it
    // re-throws — ``tearDown`` can't reach it (session/sessionTab are
    // still null at this point).
    const fnIdx = offscreenJs.indexOf('async function startTranscribe(');
    const next = offscreenJs.indexOf('\nasync function ', fnIdx + 1);
    const body = offscreenJs.slice(fnIdx, next === -1 ? offscreenJs.length : next);
    expect(body).toMatch(/micRes\.status === 'rejected'\s*\|\|\s*tabRes\.status === 'rejected'/);
    expect(body).toMatch(/r\.status === 'fulfilled'[\s\S]*?getTracks\(\)[\s\S]*?\.stop\(\)/);
    // Re-throws the original rejection (mic-first bias preserved) so
    // the user-facing error message is stable.
    expect(body).toMatch(/throw\s+micRes\.status === 'rejected'\s*\?\s*micRes\.reason\s*:\s*tabRes\.reason/);
  });

  it('control handlers (pause/resume/stop) fan out via activeStreams()', () => {
    // Handler order in the onMessage map is START → STOP → PAUSE →
    // RESUME. We search left-to-right from each known anchor to
    // slice each handler's body cleanly.
    const stopIdx = offscreenJs.indexOf('MessageType.OFFSCREEN_TRANSCRIBE_STOP');
    const pauseIdx = offscreenJs.indexOf('MessageType.OFFSCREEN_TRANSCRIBE_PAUSE', stopIdx);
    const resumeIdx = offscreenJs.indexOf('MessageType.OFFSCREEN_TRANSCRIBE_RESUME', pauseIdx);
    expect(stopIdx).toBeGreaterThan(-1);
    expect(pauseIdx).toBeGreaterThan(stopIdx);
    expect(resumeIdx).toBeGreaterThan(pauseIdx);

    // STOP handler: marks each substream stopping before tearDown.
    const stopBlock = offscreenJs.slice(stopIdx, pauseIdx);
    expect(stopBlock).toContain('for (const s of activeStreams()) s.stopping = true');

    // PAUSE handler:
    const pauseBlock = offscreenJs.slice(pauseIdx, resumeIdx);
    expect(pauseBlock).toContain('for (const s of activeStreams())');
    expect(pauseBlock).toContain('s.paused = true');

    // RESUME handler:
    const resumeBlock = offscreenJs.slice(resumeIdx, resumeIdx + 700);
    expect(resumeBlock).toContain('for (const s of activeStreams())');
    expect(resumeBlock).toContain('s.paused = false');
  });
});

// ---- streamRole tagging ------------------------------------------------

describe('Mode 3 — streamRole on the wire', () => {
  it('attachWebSocket accepts + forwards streamRole', () => {
    expect(offscreenJs).toContain('streamRole = null');
    // TRANSCRIPT_EVENT, IMPORTANT_POINTS_UPDATE, TRANSCRIBE_LIFECYCLE,
    // and TRANSCRIBE_FIRST_EVENT all need to carry the role.
    const fnIdx = offscreenJs.indexOf('function attachWebSocket(');
    const next = offscreenJs.indexOf('\nfunction ', fnIdx + 1)
      || offscreenJs.indexOf('\nasync function ', fnIdx + 1);
    const body = offscreenJs.slice(fnIdx, next === -1 ? offscreenJs.length : next);
    expect(body).toMatch(/MessageType\.TRANSCRIPT_EVENT[\s\S]*?streamRole/);
    expect(body).toMatch(/MessageType\.IMPORTANT_POINTS_UPDATE[\s\S]*?streamRole/);
    expect(body).toMatch(/MessageType\.TRANSCRIBE_LIFECYCLE[\s\S]*?streamRole/);
    expect(body).toMatch(/MessageType\.TRANSCRIBE_FIRST_EVENT[\s\S]*?streamRole/);
  });

  it('SW forwards streamRole on TRANSCRIPT_EVENT to the tab', () => {
    const caseIdx = swJs.indexOf('case MessageType.TRANSCRIPT_EVENT:');
    const next = swJs.indexOf('case MessageType.', caseIdx + 1);
    const block = swJs.slice(caseIdx, next);
    expect(block).toContain('streamRole: message.streamRole');
  });
});

// ---- overlay rendering -------------------------------------------------

describe('Mode 3 — overlay chips', () => {
  it('handleEvent accepts streamRole and threads it to renderFinal', () => {
    expect(overlayJs).toContain('function handleEvent(event, streamRole');
    expect(overlayJs).toContain('renderFinal(event, streamRole)');
  });

  it("renderFinal tags mic-origin rows with 'turn-mic' class", () => {
    expect(overlayJs).toContain("streamRole === 'mic' ? 'turn turn-mic' : 'turn'");
  });

  it('partial map keys are composite (role:speaker) to avoid mic/tab collision', () => {
    // Both substreams independently diarize and may both emit
    // ``speaker=0``; a numeric-only key would have one stream
    // overwrite the other's partial text on every event.
    expect(overlayJs).toContain('function _partialKey(streamRole, speakerNumeric)');
    expect(overlayJs).toContain('_partialKey(streamRole, event.speaker)');
  });

  it('loads selfName for BOTH mode (mic substream needs the user name)', () => {
    expect(overlayJs).toMatch(
      /message\.mode === TranscribeMode\.SELF[\s\S]*?TranscribeMode\.BOTH[\s\S]*?loadSelfNameFromStorage/,
    );
  });

  it('Mode 3 chips have distinct CSS', () => {
    expect(overlayJs).toContain('.turn-mic');
    expect(overlayJs).toContain('.partial-mic');
  });
});

// ---- speaker-name-map behavioural test ---------------------------------

describe('Mode 3 — SpeakerNameMap.resolve(event, streamRole)', () => {
  it("collapses mic-stream events to selfName regardless of mode", () => {
    const m = new SpeakerNameMap();
    m.setMode(TranscribeMode.BOTH);
    m.setSelfName('Alice');
    // Mic substream always resolves to the user — provider's numeric
    // speaker label is irrelevant because it's a single-speaker
    // stream by construction.
    expect(m.resolve({ speaker: 0 }, 'mic')).toBe('Alice');
    expect(m.resolve({ speaker: 7 }, 'mic')).toBe('Alice');
  });

  it("routes tab-stream events through the participant resolver", () => {
    const m = new SpeakerNameMap();
    m.setMode(TranscribeMode.BOTH);
    m.setSelfName('Alice');
    // No DOM observation in the freshness window → fall back to
    // the numeric→letter label, NOT the selfName.
    expect(m.resolve({ speaker: 0 }, 'tab')).toBe('Speaker A');
  });

  it('honours DOM observations for tab-stream events', () => {
    let clock = 1_000_000;
    const m = new SpeakerNameMap({ now: () => clock });
    m.setMode(TranscribeMode.BOTH);
    m.recordObservation('Bob', clock);
    clock += 100;
    expect(m.resolve({ speaker: 0 }, 'tab')).toBe('Bob');
    // And the binding is sticky for the same numeric id.
    clock += 60_000;
    expect(m.resolve({ speaker: 0 }, 'tab')).toBe('Bob');
  });

  it('null streamRole preserves legacy mode-based behaviour', () => {
    const selfMap = new SpeakerNameMap();
    selfMap.setMode(TranscribeMode.SELF);
    selfMap.setSelfName('Alice');
    expect(selfMap.resolve({ speaker: 0 }, null)).toBe('Alice');

    const partsMap = new SpeakerNameMap();
    partsMap.setMode(TranscribeMode.PARTICIPANTS);
    expect(partsMap.resolve({ speaker: 0 }, null)).toBe('Speaker A');
  });
});

// ---- reconnect routing -------------------------------------------------

describe('Mode 3 — per-substream reconnect', () => {
  it('attemptReconnect threads streamRole into GET_RECONNECT_URL', () => {
    const fnIdx = offscreenJs.indexOf('async function attemptReconnect(');
    expect(fnIdx).toBeGreaterThan(-1);
    const next = offscreenJs.indexOf('\nasync function ', fnIdx + 1)
      || offscreenJs.indexOf('\nfunction ', fnIdx + 1);
    const body = offscreenJs.slice(fnIdx, next === -1 ? offscreenJs.length : next);
    expect(body).toContain('streamRole = null');
    expect(body).toMatch(
      /OFFSCREEN_TRANSCRIBE_GET_RECONNECT_URL[\s\S]*?role:\s*streamRole/,
    );
  });

  it('refreshTranscribeReconnectUrl patches the right slot by role', () => {
    const fnIdx = swJs.indexOf('async function refreshTranscribeReconnectUrl(');
    expect(fnIdx).toBeGreaterThan(-1);
    const next = swJs.indexOf('\nasync function ', fnIdx + 1);
    const body = swJs.slice(fnIdx, next === -1 ? swJs.length : next);
    // Tab role → mode=participants + patch sessionIdTab.
    expect(body).toMatch(/role === 'tab'/);
    expect(body).toContain('sessionIdTab: fresh.session_id');
    // Mic / single-mode → keep using ``sessionId``.
    expect(body).toContain('sessionId: fresh.session_id');
  });
});
