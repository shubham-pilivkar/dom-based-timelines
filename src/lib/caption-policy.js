// Caption ownership policy.
//
// Speaker timelines are captured by scraping the meeting's own live
// captions. To do that we need captions ON — but the user may or may
// not want to SEE them. The old code unconditionally injected
// hide-CSS, which trampled a user who deliberately had captions on.
//
// This module is the single source of truth for "should the caption
// box be visible right now?". It is platform-agnostic: Meet / Teams
// pass thin adapters. It runs a small reconcile loop that keeps
// captions flowing for the scraper while honouring the user's intent.
//
// Ownership model (covers the real-world cases):
//
//   • Captions already ON when we attach  → the USER turned them on
//     (their saved preference or an earlier click). Respect it: never
//     inject hide-CSS, leave them visible. (case 1)
//
//   • Captions OFF when we attach          → the user doesn't use
//     captions. We enable them and hide the box so the scraper works
//     invisibly. (case 2 — the prior behaviour)
//
//   • OFF → ON transition we did NOT cause → the user just turned
//     captions on; they want to see them. Stop hiding. (case 3)
//
//   • ON → OFF transition                  → we NEVER turn captions
//     off, so this is always the user. They don't want captions
//     showing → go back to stealth: re-enable + hide. (case 4)
//
// "Did we cause it" is decided by a short grace window after our own
// enable click — an ON that lands inside the window is ours (keep the
// current policy); an ON outside it is the user's (show them).

/**
 * @param {{
 *   isOn: () => boolean,            // captions currently rendering?
 *   enable: () => void,             // one-directional "turn on" (never toggles off)
 *   disable?: () => void,           // turn captions OFF (used ONLY by dispose({restore}))
 *   hideUI: () => void,             // inject hide-CSS (idempotent)
 *   unhideUI: () => void,           // remove hide-CSS (idempotent)
 *   intervalMs?: number,
 *   enableGraceMs?: number,
 *   now?: () => number,
 *   onTelemetry?: (name: string, payload: object) => void,
 * }} opts
 */
export function startCaptionPolicy(opts) {
  const {
    isOn, enable, disable, hideUI, unhideUI,
    intervalMs = 1500,
    enableGraceMs = 3500,
    now = () => Date.now(),
    onTelemetry,
  } = opts;

  let userWantsVisible = false;
  // Explicit user choice from the popup ("Show / Hide captions").
  // null = no choice yet → fall back to the auto-detected
  // ``userWantsVisible``. When set it OVERRIDES detection: the
  // reconcile loop still keeps captions ENABLED (needed for the
  // speaker-timeline scrape) but visibility follows the user's
  // explicit answer.
  let explicitVisible = null;
  let weEnabledAt = 0;
  let prevOn = null; // null until the first observation
  let timer = null;
  let disposed = false;

  const tel = (name, payload) => {
    try { onTelemetry?.(name, payload); } catch { /* best-effort */ }
  };

  function wantVisible() {
    return explicitVisible !== null ? explicitVisible : userWantsVisible;
  }

  function applyVisibility() {
    // The ONLY place hide/unhide is decided. Both adapters are
    // idempotent so calling every tick is cheap and self-healing
    // (e.g. Meet re-mounts the caption region → re-hide sticks).
    if (wantVisible()) {
      try { unhideUI(); } catch { /* best-effort */ }
    } else {
      try { hideUI(); } catch { /* best-effort */ }
    }
  }

  function tick() {
    if (disposed) return;
    let on;
    try { on = !!isOn(); } catch { on = prevOn ?? false; }

    if (prevOn === null) {
      // First observation == the user's pre-existing state.
      if (on) {
        userWantsVisible = true; // case 1 — user had captions on
        tel('caption_policy_user_preowned', {});
      }
    } else if (on && !prevOn) {
      // OFF → ON. Ours (we just clicked enable) or the user's?
      if (now() - weEnabledAt > enableGraceMs) {
        // Not us within the grace window → the user enabled captions.
        if (!userWantsVisible) {
          userWantsVisible = true; // case 3 — user wants to see them
          tel('caption_policy_user_enabled', {});
        }
      }
    } else if (!on && prevOn) {
      // ON → OFF. We never turn captions off, so the user did. They
      // don't want captions showing → drop back to stealth.
      if (userWantsVisible) {
        userWantsVisible = false; // case 4 — user turned them off
        tel('caption_policy_user_disabled', {});
      }
    }
    prevOn = on;

    if (!on) {
      // Timeline scraping needs captions flowing — re-enable. Mark
      // the moment so the resulting ON transition is attributed to
      // us, not the user.
      try { enable(); } catch { /* best-effort */ }
      weEnabledAt = now();
      // Pre-apply so the box doesn't flash before the next tick when
      // captions come back.
      applyVisibility();
      return;
    }
    applyVisibility();
  }

  // Immediate first reconcile, then steady cadence.
  tick();
  timer = setInterval(tick, intervalMs);

  return {
    /** Force a reconcile (used by tests + on visibility regain). */
    tick,
    /**
     * Explicit user choice from the popup "Show / Hide captions"
     * prompt. ``true`` → captions stay ENABLED (for the timeline
     * scrape) AND visible; ``false`` → enabled but hidden;
     * ``null`` → clear the override, fall back to auto-detection.
     * Takes effect immediately.
     * @param {boolean|null} visible
     */
    setUserVisible(visible) {
      explicitVisible = visible === null ? null : !!visible;
      applyVisibility();
    },
    /** @returns {{userWantsVisible:boolean, captionsOn:boolean|null, explicitVisible:boolean|null}} */
    state() {
      return { userWantsVisible, captionsOn: prevOn, explicitVisible };
    },
    /**
     * Stop the reconcile loop. With ``{ restore: true }`` (called
     * from the content-script stopDetector on recording/transcribe
     * stop): if the EXTENSION owns captions — i.e. the user did NOT
     * want them visible (we enabled them purely to scrape the
     * speaker timeline) and they are still on — turn them OFF so the
     * caption box doesn't linger after the session ends, putting the
     * meeting back exactly as the user had it. If the USER owns
     * captions (had them on, or turned them on themselves), leave
     * them alone. No-arg ``dispose()`` keeps the old behaviour.
     */
    dispose({ restore = false } = {}) {
      disposed = true;
      if (timer) { clearInterval(timer); timer = null; }
      if (!restore || userWantsVisible || typeof disable !== 'function') {
        return;
      }
      let stillOn;
      try { stillOn = !!isOn(); } catch { stillOn = prevOn === true; }
      if (!stillOn) return; // nothing to turn off
      try {
        disable();
        tel('caption_policy_restored_off', {});
      } catch { /* best-effort — worst case the box lingers */ }
    },
  };
}
