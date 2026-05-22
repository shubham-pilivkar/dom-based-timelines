// Phase L1 — contract tests for the "Listening…" cold-start indicator
// and the first-partial telemetry event. We don't bring up a full
// shadow-DOM overlay in vitest (it would require a real Window + a
// stub chrome.runtime); instead we pin the wiring at the source level
// — same shape as ``popup-visibility.test.js``.
//
// What we want to catch:
//
//   1. The new TELEMETRY_EVENT_NAMES entry exists with the documented
//      string so the backend's allowlist + the offscreen emitter agree.
//   2. The new MessageType.TRANSCRIBE_FIRST_EVENT wire constant exists.
//   3. The SW resets ``hasFirstEvent: false`` on every 'started'
//      lifecycle phase (including reconnects).
//   4. The SW flips ``hasFirstEvent: true`` on the new message.
//   5. The popup renders "Listening…" when ACTIVE && !hasFirstEvent.
//   6. The offscreen emits the telemetry + the new message inside its
//      WS message handler (once, on first non-pong event).
//   7. The overlay arms the listening indicator on 'started' and
//      clears it on first inbound provider event.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MessageType, TELEMETRY_EVENT_NAMES } from '../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const popupJs = readFileSync(resolve(here, '../src/popup/popup.js'), 'utf8');
const swJs = readFileSync(
  resolve(here, '../src/background/service-worker.js'),
  'utf8',
);
const overlayJs = readFileSync(
  resolve(here, '../src/transcribe/overlay.js'),
  'utf8',
);
const offscreenJs = readFileSync(
  resolve(here, '../src/offscreen/transcribe.js'),
  'utf8',
);

// ---- constants ----------------------------------------------------------

describe('Phase L1 constants', () => {
  it('telemetry name TRANSCRIBE_FIRST_PARTIAL_MS exists', () => {
    expect(TELEMETRY_EVENT_NAMES.TRANSCRIBE_FIRST_PARTIAL_MS).toBe(
      'transcribe_first_partial_ms',
    );
  });

  it('MessageType.TRANSCRIBE_FIRST_EVENT exists', () => {
    expect(MessageType.TRANSCRIBE_FIRST_EVENT).toBe('TRANSCRIBE_FIRST_EVENT');
  });
});

// ---- service-worker wiring ---------------------------------------------

describe('service-worker — hasFirstEvent state', () => {
  it('seeds INITIAL_TRANSCRIBE_STATE with hasFirstEvent: false', () => {
    // The INITIAL_TRANSCRIBE_STATE object literal must contain the new
    // field with the false default — without this, the popup's
    // ``state.hasFirstEvent === false`` check would be ``undefined ===
    // false`` and Listening would never render on a fresh session.
    expect(swJs).toContain('hasFirstEvent: false,');
  });

  it("resets hasFirstEvent: false on lifecycle phase 'started'", () => {
    // Inside the TRANSCRIBE_LIFECYCLE handler, the 'started' branch
    // must include hasFirstEvent: false in the setTranscribeState
    // patch so reconnects + fresh starts both re-arm the indicator.
    const startedBlock = swJs.match(
      /message\.phase === 'started'[\s\S]*?await setTranscribeState\(\{[\s\S]*?\}\);/,
    );
    expect(startedBlock, "did not find 'started' setTranscribeState block").not.toBeNull();
    expect(startedBlock[0]).toContain('hasFirstEvent: false');
  });

  it('handles TRANSCRIBE_FIRST_EVENT by flipping hasFirstEvent: true', () => {
    expect(swJs).toContain('case MessageType.TRANSCRIBE_FIRST_EVENT:');
    // The handler must call setTranscribeState({ hasFirstEvent: true }).
    const handlerBlock = swJs.match(
      /case MessageType\.TRANSCRIBE_FIRST_EVENT:[\s\S]*?return \{ ok: true \};/,
    );
    expect(handlerBlock, 'did not find TRANSCRIBE_FIRST_EVENT handler').not.toBeNull();
    expect(handlerBlock[0]).toContain('setTranscribeState({ hasFirstEvent: true })');
  });
});

// ---- popup wiring -------------------------------------------------------

describe('popup — Listening label', () => {
  it('renders "Listening…" when state is ACTIVE && hasFirstEvent === false', () => {
    // The popup's renderTranscribeState must include a branch that
    // checks hasFirstEvent === false on the ACTIVE state and sets the
    // pill text to "Listening…". The string check pins both halves.
    expect(popupJs).toContain('state.hasFirstEvent === false');
    expect(popupJs).toContain("'Listening…'");
  });

  it("keeps the CSS class state-active so colours don't flicker on flip", () => {
    // The whole point of the Listening label is to be the same colour
    // as Active so the pill stays steady when the first event lands.
    // We check the className expression is unconditional on the state
    // name (set BEFORE the label branch).
    expect(popupJs).toMatch(
      /els\.transcribeStatusPill\.className\s*=\s*`pill state-\$\{s\.toLowerCase\(\)\}`/,
    );
  });
});

// ---- overlay wiring -----------------------------------------------------

describe('overlay — listening indicator + partial debounce', () => {
  it('defines setListeningIndicator and toggles the .listening class', () => {
    expect(overlayJs).toContain('function setListeningIndicator');
    expect(overlayJs).toContain("dot.classList.add('listening')");
    expect(overlayJs).toContain("dot.classList.remove('listening')");
  });

  it('arms the listening indicator on lifecycle phase "started"', () => {
    // Both the reconnect AND fresh-start branches inside the
    // TRANSCRIBE_LIFECYCLE handler must call setListeningIndicator(true).
    // Count occurrences so we don't accidentally regress one of the
    // two branches.
    const armCalls = (overlayJs.match(/setListeningIndicator\(true\)/g) ?? []).length;
    expect(armCalls).toBeGreaterThanOrEqual(2);
  });

  it('clears the listening indicator on the first provider event', () => {
    // handleEvent must call setListeningIndicator(false) so the dot
    // returns to its steady-state red.
    expect(overlayJs).toMatch(/function handleEvent\([\s\S]*?setListeningIndicator\(false\)/);
  });

  it('defines a 150ms partial-render debounce', () => {
    expect(overlayJs).toContain('PARTIAL_RENDER_DEBOUNCE_MS = 150');
    expect(overlayJs).toContain('schedulePartialFlush');
  });

  it('finals bypass the debounce + flush pending partials first', () => {
    // On a final, we MUST drain any pending partial-render so the
    // visible order matches the wire order (partial then final).
    // ``flushPartialsNow()`` is the synchronous flush; the final
    // branch must call it before renderFinal.
    expect(overlayJs).toContain('flushPartialsNow');
    expect(overlayJs).toMatch(
      // Mode 3 added a streamRole arg → ``renderFinal(event, streamRole)``.
      // Match the open-paren + ``event`` token without pinning the
      // closing paren so future additions don't trip this.
      /event\.type === 'final'[\s\S]*?flushPartialsNow\(\)[\s\S]*?renderFinal\(event\b/,
    );
  });

  it('cleans up the partial-flush timer in removeOverlay', () => {
    // A pending setTimeout against a removed shadow-root would no-op
    // but leaves the timer registered — drop it so the cleanup is
    // observably tidy. Also defends against the schedule-flush call
    // path after removeOverlay (race during a fast stop).
    expect(overlayJs).toMatch(/function removeOverlay[\s\S]*?clearTimeout\(partialFlushTimer\)/);
  });
});

// ---- offscreen wiring ---------------------------------------------------

describe('offscreen — first-event timing + telemetry', () => {
  it('stamps wsOpenedAtPerf at WS open', () => {
    // performance.now() captured inside the 'open' handler — used as
    // the t0 for the latency calculation on first inbound event.
    expect(offscreenJs).toContain("ws.addEventListener('open'");
    expect(offscreenJs).toContain('wsOpenedAtPerf = performance.now()');
    expect(offscreenJs).toContain('firstEventSeen = false');
  });

  it('emits TRANSCRIBE_FIRST_PARTIAL_MS telemetry on first inbound event', () => {
    expect(offscreenJs).toContain(
      'TELEMETRY_EVENT_NAMES.TRANSCRIBE_FIRST_PARTIAL_MS',
    );
    // Latency payload key is ``latencyMs`` (matches the
    // CHUNK_UPLOAD_LATENCY convention so dashboards can union the
    // two distributions if useful).
    expect(offscreenJs).toMatch(/payload:\s*\{\s*latencyMs/);
  });

  it('notifies the SW via TRANSCRIBE_FIRST_EVENT with the latency', () => {
    expect(offscreenJs).toContain('MessageType.TRANSCRIBE_FIRST_EVENT');
    // Coalesced — the firstEventSeen latch must be set so subsequent
    // messages don't double-fire.
    expect(offscreenJs).toMatch(/if \(!firstEventSeen[\s\S]*?firstEventSeen = true/);
  });

  it('does NOT fire on pong (heartbeat) frames', () => {
    // The pong-skip check is BEFORE the first-event block so a
    // heartbeat doesn't pretend to be the first provider event.
    // We search the file by absolute index of well-known anchors
    // (instead of regex-extracting a handler block — that approach
    // proved fragile when L4 inserted a new branch with its own
    // ``});`` between the pong check and the first-event check).
    const pongIdx = offscreenJs.indexOf("msg.type === 'pong'");
    // ``firstEventSeen = true`` is the LATCH set inside the
    // first-event branch — distinct from the let-decl ``firstEventSeen = false``
    // up at the variable-init block. We anchor on the latch so the
    // order check stays meaningful.
    const firstEventIdx = offscreenJs.indexOf('firstEventSeen = true');
    expect(pongIdx).toBeGreaterThan(-1);
    expect(firstEventIdx).toBeGreaterThan(pongIdx);
  });
});
