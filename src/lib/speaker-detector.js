import {
  POLL_FALLBACK_MS,
  POLL_FALLBACK_TRIGGER_MS,
  SELECTORS_BROKEN_MS,
  SPEAKER_DEBOUNCE_MS,
} from '../constants.js';

// Speaker detection runs inside a content script and does two things:
//   1. Watches the meeting DOM via MutationObserver and reports which
//      participant tile is currently "speaking".
//   2. Falls back to a setInterval poll if the observer has produced
//      zero events for POLL_FALLBACK_TRIGGER_MS while a recording is
//      active — Meet/Teams class names rotate often enough that the
//      observer alone is not reliable.
//
// We use the elapsed-seconds clock (passed in via getElapsedSeconds) so
// the timeline stays monotonic and aligns with the SW-authoritative t0.
//
// onTelemetry (optional) receives diagnostics:
//   - 'polling_fallback_engaged' — observer went quiet, polling kicked in
//   - 'selectors_broken'         — probe returned 0 tiles for too long
// Each event fires at most once per detector instance to avoid spam.

/**
 * @typedef {Object} SpeakerProbe
 * @property {() => Array<{ id: string, name: string, speaking: boolean }>} snapshot
 * @property {Element} observeRoot
 * @property {string[]} attributeFilter
 */

/**
 * @param {{
 *   probe: SpeakerProbe,
 *   getElapsedSeconds: () => number,
 *   onChange: (event: { speaker_name: string, start_time: number, end_time: number }) => void,
 *   isActive: () => boolean,
 *   onTelemetry?: (name: string, payload?: Record<string, unknown>) => void,
 * }} args
 */
export function startSpeakerDetector({
  probe,
  getElapsedSeconds,
  onChange,
  isActive,
  onTelemetry,
}) {
  let currentSpeaker = null;          // { name, startTime }
  let pendingChange = null;           // { name, at }
  let debounceTimer = null;
  let lastObserverEventAt = performance.now();
  let lastTilesSeenAt = performance.now();
  let pollTimer = null;
  let pollingEngagedEmitted = false;
  let selectorsBrokenEmitted = false;

  function fire(name, payload) {
    if (!onTelemetry) return;
    try {
      onTelemetry(name, payload ?? {});
    } catch {
      /* telemetry must never throw into the caller */
    }
  }

  function commitSpeaker(name, now) {
    if (currentSpeaker && currentSpeaker.name !== name) {
      onChange({
        speaker_name: currentSpeaker.name,
        start_time: currentSpeaker.startTime,
        end_time: now,
      });
    }
    if (!currentSpeaker || currentSpeaker.name !== name) {
      currentSpeaker = name ? { name, startTime: now } : null;
    }
  }

  function safeSnapshot() {
    // Meet/Teams DOMs occasionally have transient states where
    // ``getAttribute`` / ``textContent`` throw on a partially-rendered
    // node. We never want a single bad probe call to kill the
    // detector — recording + live transcription must keep working
    // even if speaker capture goes blind. Treat a throw as "no tiles
    // observable right now" and let the next tick try again.
    try {
      const tiles = probe.snapshot();
      return Array.isArray(tiles) ? tiles : [];
    } catch (err) {
      fire('probe_snapshot_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  function evaluate() {
    if (!isActive()) return;
    const tiles = safeSnapshot();
    if (tiles.length > 0) {
      lastTilesSeenAt = performance.now();
    }
    const speaking = tiles.find((t) => t.speaking && t.name);
    const name = speaking ? speaking.name : null;
    const desired = name ?? (currentSpeaker ? currentSpeaker.name : null);

    if ((currentSpeaker?.name ?? null) === desired && name === desired) {
      return;
    }

    pendingChange = { name, at: performance.now() };
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!pendingChange) return;
      const elapsed = getElapsedSeconds();
      // Wrap commit so a malformed onChange callback (or a network
      // error inside it) doesn't propagate out of setTimeout where it
      // would surface as an unhandled rejection. The detector should
      // keep running even if downstream telemetry has issues.
      try {
        commitSpeaker(pendingChange.name, elapsed);
      } catch (err) {
        fire('commit_speaker_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      pendingChange = null;
    }, SPEAKER_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(() => {
    lastObserverEventAt = performance.now();
    // ``evaluate`` is already defensive inside (safeSnapshot +
    // commit try/catch). This outer guard is belt-and-suspenders so
    // a regression in evaluate's contract still can't kill the
    // observer callback path.
    try {
      evaluate();
    } catch (err) {
      fire('evaluate_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ``observe`` itself can throw if ``probe.observeRoot`` was
  // detached between probe construction and now. Treat as a degraded
  // mode — pollTimer below still runs and will keep the detector
  // useful via the poll path. Recording is fully independent of this
  // and continues regardless.
  try {
    observer.observe(probe.observeRoot, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: probe.attributeFilter,
    });
  } catch (err) {
    fire('observer_attach_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Polling fallback — only kicks in when the observer goes quiet during
  // an active recording. While running it also watches for the "no tiles
  // visible" condition that signals our selectors have rotted.
  pollTimer = setInterval(() => {
    // Whole-callback guard: any throw inside setInterval becomes an
    // unhandled error that would still re-fire next tick, but
    // there's no harm in being explicit about the contract.
    try {
      if (!isActive()) return;
      const now = performance.now();
      const observerIdleFor = now - lastObserverEventAt;
      if (observerIdleFor >= POLL_FALLBACK_TRIGGER_MS) {
        if (!pollingEngagedEmitted) {
          pollingEngagedEmitted = true;
          fire('polling_fallback_engaged', { idleMs: Math.round(observerIdleFor) });
        }
        evaluate();
      }
      if (
        !selectorsBrokenEmitted &&
        now - lastTilesSeenAt >= SELECTORS_BROKEN_MS
      ) {
        selectorsBrokenEmitted = true;
        fire('selectors_broken', {
          sinceMs: Math.round(now - lastTilesSeenAt),
        });
      }
    } catch (err) {
      fire('poll_tick_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, POLL_FALLBACK_MS);

  function flush() {
    if (currentSpeaker) {
      const elapsed = getElapsedSeconds();
      onChange({
        speaker_name: currentSpeaker.name,
        start_time: currentSpeaker.startTime,
        end_time: elapsed,
      });
      currentSpeaker = null;
    }
  }

  function dispose() {
    observer.disconnect();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pollTimer) clearInterval(pollTimer);
  }

  return { evaluate, flush, dispose };
}
