// Round-2 bug fixes (post Phase A–E + caption policy):
//  1. duplicate 'started' must not wipe the accumulating transcript
//  3. recording UI (pill + control window) hides immediately on stop
//  4. overlay mounts before any failable start step (all modes)
//  2. transcribe stop is deterministic; fast restart can't wedge
//  5. resize from all 4 edges + 4 corners
// Source-contract style, consistent with the other suites.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const overlay = readFileSync(resolve(here, '../src/transcribe/overlay.js'), 'utf8');
const sw = readFileSync(resolve(here, '../src/background/service-worker.js'), 'utf8');

describe('Bug 1 — transcript accumulates (idempotent session reset)', () => {
  it('the one-time resets are gated on overlaySessionInitialized', () => {
    expect(overlay).toContain('let overlaySessionInitialized = false;');
    const br = overlay.slice(
      overlay.indexOf("} else {", overlay.indexOf("if (message.isReconnect) {")),
      overlay.indexOf("} else if (message.phase === 'paused')"),
    );
    // resetOverlayForNewSession + speakerMap.reset run ONLY inside the
    // first-time guard.
    expect(br).toContain('if (!overlaySessionInitialized) {');
    expect(br).toContain('overlaySessionInitialized = true;');
    const guarded = br.slice(
      br.indexOf('if (!overlaySessionInitialized) {'),
      br.indexOf('} else {', br.indexOf('if (!overlaySessionInitialized) {')),
    );
    expect(guarded).toContain('resetOverlayForNewSession()');
    expect(guarded).toContain('speakerMap.reset()');
    // The duplicate-started path only ensures the panel exists.
    expect(br).toMatch(/else \{[\s\S]*ensureOverlay\(\);[\s\S]*\}/);
  });

  it('the guard is cleared on stop + teardown so a NEW session resets', () => {
    const es = overlay.slice(
      overlay.indexOf('function enterStoppedState('),
      overlay.indexOf('function enterStoppedState(') + 220,
    );
    expect(es).toContain('overlaySessionInitialized = false;');
    const rm = overlay.slice(
      overlay.indexOf('function removeOverlay'),
      overlay.indexOf('function removeOverlay') + 500,
    );
    expect(rm).toContain('overlaySessionInitialized = false;');
  });

  it('retains far more than 12 turns (felt like "not accumulating")', () => {
    const m = overlay.match(/const MAX_VISIBLE_FINALS = (\d+);/);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(100);
  });
});

describe('Bug 2 — deterministic transcribe stop + safe restart', () => {
  it('stopTranscribe drives IDLE itself (not only via offscreen event)', () => {
    const fn = sw.slice(
      sw.indexOf('async function stopTranscribe('),
      sw.indexOf('async function pauseTranscribe('),
    );
    expect(fn).toContain('OFFSCREEN_TRANSCRIBE_STOP');
    // Authoritative reset to IDLE inside stopTranscribe.
    expect(fn).toContain('...INITIAL_TRANSCRIBE_STATE');
    expect(fn).toContain('state: TranscribeState.IDLE');
    // Tab told to stop BEFORE the doc may be closed.
    expect(fn).toContain("phase: 'stopped'");
    expect(fn).toContain('destroyOffscreenIfIdle()');
  });

  it('stopTranscribe DEFENSIVELY releases the backend row (WS-leak / "limit exceeded" fix)', () => {
    // The backend has no REST cancel — a ``live`` row is freed only by
    // a WS open→close. The offscreen's close doesn't reach the server
    // when the user stops during STARTING (socket still CONNECTING),
    // the offscreen is unreachable, or a reconnect just minted a fresh
    // row. Without a defensive release the row lingered ``live`` for
    // the 5h stale-grace and burned the 3-session cap ("max 3
    // concurrent live-transcribe sessions reached").
    const fn = sw.slice(
      sw.indexOf('async function stopTranscribe('),
      sw.indexOf('async function pauseTranscribe('),
    );
    // Release happens AFTER asking the offscreen to stop (so a clean
    // offscreen close still wins; this is only the safety net).
    const offStopIdx = fn.indexOf('OFFSCREEN_TRANSCRIBE_STOP');
    const relIdx = fn.indexOf('releaseTranscribeSession(cur.wsUrl)');
    expect(offStopIdx).toBeGreaterThan(-1);
    expect(relIdx).toBeGreaterThan(offStopIdx);
    // Both substreams (mode=both) released; tab side guarded.
    expect(fn).toMatch(/cur\.wsUrlTab[\s\S]*?releaseTranscribeSession\(cur\.wsUrlTab\)/);
    // ws_url(s) are read from the PRE-reset snapshot (cur), not after
    // ...INITIAL_TRANSCRIBE_STATE wipes them.
    expect(fn.indexOf('releaseTranscribeSession(cur.wsUrl)'))
      .toBeLessThan(fn.indexOf('...INITIAL_TRANSCRIBE_STATE'));
  });

  it('the ws_url(s) are persisted on mint + reconnect so stop can release them', () => {
    // State shape carries them.
    expect(sw).toContain('wsUrl: null');
    expect(sw).toContain('wsUrlTab: null');
    // Stored when the session is minted in startTranscribe.
    const start = sw.slice(
      sw.indexOf('async function startTranscribe('),
      sw.indexOf('async function refreshTranscribeReconnectUrl('),
    );
    expect(start).toMatch(/wsUrl: session\.ws_url/);
    expect(start).toMatch(/wsUrlTab: sessionTab\?\.ws_url \?\? null/);
    // Kept current across a reconnect (fresh row's ws_url replaces the
    // stored one, per substream).
    const recon = sw.slice(
      sw.indexOf('async function refreshTranscribeReconnectUrl('),
      sw.indexOf('async function stopTranscribe('),
    );
    expect(recon).toMatch(/sessionIdTab: fresh\.session_id, wsUrlTab: fresh\.ws_url/);
    expect(recon).toMatch(/sessionId: fresh\.session_id, wsUrl: fresh\.ws_url/);
  });

  it('offscreen start tears down a stale session instead of throwing', () => {
    const off = readFileSync(
      resolve(here, '../src/offscreen/transcribe.js'), 'utf8',
    );
    const guard = off.slice(
      off.indexOf('if (session || sessionTab) {'),
      off.indexOf('if (session || sessionTab) {') + 900,
    );
    expect(guard).toContain("tearDown({ reason: 'superseded_by_new_session' })");
    expect(guard).not.toContain("throw new Error('already_transcribing')");
  });
});

describe('Timeline flush survives MV3 SW suspension (timelines.json-absent fix)', () => {
  it('the heartbeat alarm (chrome.alarms) flushes the timeline while recording', () => {
    // ``startTimelineFlusher`` is setInterval-based and dies with the
    // SW; on a normal recording the SW is evicted between chunk POSTs
    // so it never fires again and the buffered speaker timeline only
    // had the stopRecording flush to rely on. The heartbeat alarm runs
    // on chrome.alarms (survives suspension) — it must opportunistically
    // drain the timeline so a /timeline POST actually happens and a
    // speaker_timelines row (→ timelines.json) gets created.
    const handler = sw.slice(
      sw.indexOf('chrome.alarms.onAlarm.addListener'),
      sw.indexOf('// Chunk drain pump + queue back-pressure'),
    );
    expect(handler).toContain('HEARTBEAT_ALARM_NAME');
    // The flush sits in the recording-busy path, guarded by meetingId,
    // and swallows errors (an alarm tick must not tear down recording).
    expect(handler).toMatch(
      /if \(cur\.meetingId\) \{\s*try \{ await flushTimeline\(cur\.meetingId\); \} catch/,
    );
    // It must run BEFORE the heartbeat-timeout teardown so a lost
    // heartbeat still gets one last drain attempt this tick.
    expect(handler.indexOf('await flushTimeline(cur.meetingId)'))
      .toBeLessThan(handler.indexOf('offscreen heartbeat lost'));
  });
});

describe('Bug 3 — recording UI hides immediately on stop', () => {
  it('stopRecording broadcasts stopped + closes control window before drain', () => {
    const fn = sw.slice(
      sw.indexOf('async function stopRecording('),
      sw.indexOf('function scheduleStopForceTimeout('),
    );
    const lifeIdx = fn.indexOf("phase: 'stopped'");
    const offStopIdx = fn.indexOf('OFFSCREEN_STOP');
    expect(lifeIdx).toBeGreaterThan(-1);
    expect(fn).toContain('closeControlWindow()');
    // The tab broadcast happens BEFORE the offscreen-stop / drain.
    expect(lifeIdx).toBeLessThan(offStopIdx);
  });
});

describe('Bug 4 — overlay mounts before any failable start step', () => {
  it('mountTranscribeOverlay is called right after STARTING, pre-tabCapture', () => {
    const fn = sw.slice(
      sw.indexOf('async function startTranscribe('),
      sw.indexOf('async function refreshTranscribeReconnectUrl('),
    );
    const mountIdx = fn.indexOf('mountTranscribeOverlay(tabId, mode)');
    const tabCapIdx = fn.indexOf('getMediaStreamId(tabId)');
    expect(mountIdx).toBeGreaterThan(-1);
    expect(tabCapIdx).toBeGreaterThan(-1);
    expect(mountIdx).toBeLessThan(tabCapIdx); // mounted before it can fail
    // Every early failure unmounts with the reason. The tabCapture
    // refusal builds a ``tabCapture_failed: …`` detail then unmounts
    // with it (the streamId mint moved to step 4.5 — after the mic
    // window — so the detail is now a variable, not an inline literal).
    expect(fn).toContain("unmountTranscribeOverlay(tabId, 'mode_requires_meeting_tab')");
    expect(fn).toMatch(/const detail = `tabCapture_failed: \$\{err\.message \?\? err\}`;/);
    expect(fn).toMatch(/unmountTranscribeOverlay\(tabId, detail\)/);
    expect(fn).toContain("unmountTranscribeOverlay(tabId, 'auth_expired')");
  });
});

describe('Bug 5 — resize from all 4 edges + 4 corners', () => {
  it('builds 8 grips and wires them with edge descriptors', () => {
    for (const cls of [
      'resize-handle', 'resize-corner-tr', 'resize-corner-bl',
      'resize-corner-br', 'resize-edge-x', 'resize-edge-r',
      'resize-edge-y', 'resize-edge-b',
    ]) {
      expect(overlay).toContain(`'${cls}'`);
    }
    expect(overlay).toContain("edges: { right: true, top: true }");
    expect(overlay).toContain("edges: { left: true, bottom: true }");
    expect(overlay).toContain("edges: { right: true, bottom: true }");
  });

  it('right/bottom drags move the anchor so the far edge stays pinned', () => {
    const fn = overlay.slice(
      overlay.indexOf('function attachResizeHandlers('),
      overlay.indexOf('function detachResizeHandlers('),
    );
    expect(fn).toContain('startRight: overlayPos.right');
    expect(fn).toContain('startBottom: overlayPos.bottom');
    expect(fn).toContain('if (ed.left) w = clampW(resizeState.startW - dx)');
    expect(fn).toContain('if (ed.top) h = clampH(resizeState.startH - dy)');
    expect(fn).toContain('right = Math.max(0, resizeState.startRight - (w - resizeState.startW))');
    expect(fn).toContain('bottom = Math.max(0, resizeState.startBottom - (h - resizeState.startH))');
    expect(fn).toContain('applyOverlayPosition();');
  });

  it('every grip is hidden while minimized', () => {
    expect(overlay).toContain('.panel.minimized .resize-corner-br');
  });
});

describe('Bug — overlay missing because content script not injected (MV3 stale-tab)', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(here, '../manifest.json'), 'utf8'),
  );

  it('manifest has the scripting permission for programmatic injection', () => {
    expect(manifest.permissions).toContain('scripting');
  });

  it('SW ensureOverlayInjected pings then executeScripts the live-manifest loader', () => {
    const fn = sw.slice(
      sw.indexOf('async function ensureOverlayInjected('),
      sw.indexOf('async function mountTranscribeOverlay('),
    );
    expect(fn).toContain('MessageType.OVERLAY_PING');
    expect(fn).toContain('chrome.scripting.executeScript');
    // Loader path comes from the LIVE manifest (crxjs hash-proof).
    expect(sw).toContain('chrome.runtime.getManifest().content_scripts');
    expect(sw).toContain('/overlay/i.test(f)');
  });

  it('mountTranscribeOverlay ensures injection BEFORE broadcasting started', () => {
    const fn = sw.slice(
      sw.indexOf('async function mountTranscribeOverlay('),
      sw.indexOf('async function unmountTranscribeOverlay('),
    );
    const inj = fn.indexOf('ensureOverlayInjected(tabId)');
    const send = fn.indexOf("phase: 'started'");
    expect(inj).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(-1);
    expect(inj).toBeLessThan(send);
  });

  it('SW re-injects overlay into open meeting tabs on install + startup', () => {
    expect(sw).toContain('async function reinjectOverlayIntoOpenMeetingTabs(');
    expect(sw).toContain("'https://meet.google.com/*', 'https://teams.microsoft.com/*'");
    const calls = (sw.match(/reinjectOverlayIntoOpenMeetingTabs\(\)/g) || []);
    // definition + onInstalled + onStartup = 3 occurrences
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('overlay binds its listener once (re-injection safe) and answers OVERLAY_PING', () => {
    expect(overlay).toContain('if (!globalThis.__mmTranscribeOverlayBound) {');
    expect(overlay).toContain('globalThis.__mmTranscribeOverlayBound = true;');
    expect(overlay).toContain('message.type === MessageType.OVERLAY_PING');
    expect(overlay).toContain('{ ok: true, overlay: true }');
  });
});

describe('Bug — finals not accumulating (ensureOverlay rebuilt every event)', () => {
  it('ensureOverlay guard uses isConnected, not document.body.contains', () => {
    const fn = overlay.slice(
      overlay.indexOf('function ensureOverlay()'),
      overlay.indexOf('function ensureOverlay()') + 700,
    );
    // The host is appended to documentElement, so a body.contains
    // guard is ALWAYS false → panel rebuilt (empty) on every event.
    expect(fn).toContain('if (shadowHost && shadowHost.isConnected) return;');
    // The buggy guard expression must not be the ACTIVE condition
    // (it may still be quoted in the explanatory comment).
    expect(fn).not.toContain('if (shadowHost && document.body.contains');
  });

  it('handleEvent calls ensureOverlay per event, so the guard must be idempotent', () => {
    const fn = overlay.slice(
      overlay.indexOf('function handleEvent('),
      overlay.indexOf('function handleEvent(') + 600,
    );
    expect(fn).toContain('ensureOverlay();');
    // renderFinal appends + is bounded (accumulates, not replaces).
    // Slice widened 2400 → 3200 → 4400 → 5400 → 6400 to accommodate the
    // Bug 12.1 Mode 3 echo-dedup guard, the Mode-2 retroactive-relabel
    // row-tagging block, the turn_order replace-in-place dedup, and the
    // replace-branch pending-tag re-sync — all added before the append.
    const rf = overlay.slice(
      overlay.indexOf('function renderFinal('),
      overlay.indexOf('function renderFinal(') + 6400,
    );
    expect(rf).toContain('finalsEl.appendChild(row)');
    expect(rf).toContain('finalsEl.childElementCount > MAX_VISIBLE_FINALS');
  });
});

describe('Deep-audit fixes (full-codebase review)', () => {
  const client = readFileSync(resolve(here, '../src/api/client.js'), 'utf8');

  it('A1 — REPORT_PROBLEM uses sessionReplay.clearReplay (no bare `sr`)', () => {
    expect(sw).not.toMatch(/\bsr\.clearReplay\(/);
    expect(sw).toContain('await sessionReplay.clearReplay();');
  });

  it('A2 — overlay indicators target .header .header-title, not span:last-child', () => {
    expect(overlay).not.toContain("'.header span:last-child'");
    const n = (overlay.match(/querySelector\('\.header \.header-title'\)/g) || []).length;
    expect(n).toBeGreaterThanOrEqual(4);
  });

  it("A2b — 'resumed' lifecycle is gated on an active session", () => {
    const i = overlay.indexOf("message.phase === 'resumed'");
    expect(overlay.slice(i, i + 360)).toContain('if (!transcribeSessionActive)');
  });

  it('A3 — finalizeAfterStop is single-flight + STOPPING-guarded', () => {
    expect(sw).toContain('let finalizeInFlight = null;');
    const w = sw.slice(
      sw.indexOf('async function finalizeAfterStop('),
      sw.indexOf('async function _finalizeAfterStopImpl('),
    );
    expect(w).toContain('if (finalizeInFlight) return finalizeInFlight;');
    const impl = sw.slice(
      sw.indexOf('async function _finalizeAfterStopImpl('),
      sw.indexOf('async function _finalizeAfterStopImpl(') + 1400,
    );
    expect(impl).toContain('cur.state !== RecordingState.STOPPING');
  });

  it('A4 — START_TRANSCRIBE backstop ignores busy_* mutex codes', () => {
    const i = sw.indexOf('backstop only an unexpected non-start');
    const block = sw.slice(i, i + 900);
    expect(block).toContain("result.code !== 'busy_transcribing'");
    expect(block).toContain("result.code !== 'busy_recording'");
  });

  it('A5 — chunk drain drops a poison (non-retryable 4xx) chunk + advances', () => {
    const fn = client.slice(
      client.indexOf('async function _drainChunkQueueImpl('),
      client.indexOf('function sleep('),
    );
    expect(fn).toContain('chunk_dropped_poison');
    expect(fn).toMatch(/status === 400 \|\| status === 413/);
    expect(fn).toContain('await deleteChunk(record.id)');
    // Poison path must `continue` (advance the queue head), NOT sleep+retry.
    const poisonIdx = fn.indexOf('if (poison) {');
    expect(fn.slice(poisonIdx, poisonIdx + 800)).toContain('continue;');
  });
});

describe("provider 'error' event no longer logs [object Object]", () => {
  it('error branch derives code/message via providerErrorDetail (not the raw object)', () => {
    const br = overlay.slice(
      overlay.indexOf("} else if (event.type === 'error') {"),
      overlay.indexOf("function providerErrorDetail("),
    );
    // Must NOT pass the event object to console.warn anymore.
    expect(br).not.toContain("console.warn('[transcribe-overlay] provider error', event)");
    expect(br).toContain('providerErrorDetail(event)');
    expect(br).toContain('_lastProviderErrorDetail'); // de-spam
    expect(br).toContain('flashProviderIssue()');     // user-visible hint
  });

  it('providerErrorDetail never returns "[object Object]"', () => {
    const fn = overlay.slice(
      overlay.indexOf('function providerErrorDetail('),
      overlay.indexOf('function providerErrorDetail(') + 600,
    );
    expect(fn).toContain('event.code');
    expect(fn).toContain('event.message');
    expect(fn).toContain('event.text');
    expect(fn).toContain("'unknown provider error'");
  });

  it('de-spam memory resets on a recovered final + on teardown', () => {
    const fin = overlay.slice(
      overlay.indexOf("} else if (event.type === 'final') {"),
      overlay.indexOf("} else if (event.type === 'final') {") + 300,
    );
    expect(fin).toContain('_lastProviderErrorDetail = null;');
    const rm = overlay.slice(
      overlay.indexOf('function removeOverlay'),
      overlay.indexOf('function removeOverlay') + 1500,
    );
    expect(rm).toContain('_lastProviderErrorDetail = null;');
    expect(rm).toContain('clearTimeout(_providerIssueTimer)');
  });
});
