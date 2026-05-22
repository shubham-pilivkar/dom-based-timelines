// In-meeting microphone-mute observer.
//
// The recorder captures the user's voice via its OWN getUserMedia
// mic stream, which is independent of the Meet/Teams in-app mute
// button — so muting yourself in the meeting would still be recorded.
// This watches the platform's mic toggle and reports state changes so
// the offscreen recorder can zero the mic gain while muted.
//
// Platform-agnostic: Meet/Teams pass a ``detectMuted()`` adapter that
// returns:
//   • true   — the user is muted in the meeting
//   • false  — the user is live (unmuted)
//   • null   — can't tell (DOM not found / re-rendering)
//
// DATA-SAFETY RULE: ``null`` is treated as "no change" and the first
// resolved state must be a concrete boolean before we ever report
// muted. A flaky selector must never *silently drop wanted audio*;
// the worst case of a missed mute is "recorded a bit of muted audio",
// which is strictly less bad than "lost audio the user wanted".

/**
 * @param {{
 *   detectMuted: () => (boolean|null),
 *   onChange: (muted: boolean) => void,
 *   intervalMs?: number,
 *   now?: () => number,
 * }} opts
 */
export function startMicStateObserver(opts) {
  const { detectMuted, onChange, intervalMs = 900 } = opts;
  let last = null;       // last REPORTED boolean (null until first report)
  let timer = null;
  let disposed = false;

  function tick() {
    if (disposed) return;
    let m;
    try { m = detectMuted(); } catch { m = null; }
    if (m === null || m === undefined) return; // unknown → keep last
    const muted = !!m;
    if (muted === last) return;                // no change → no spam
    last = muted;
    try { onChange(muted); } catch { /* best-effort */ }
  }

  // Immediate read so a meeting started already-muted is honoured
  // from the first chunk; then steady polling (Meet/Teams re-render
  // the controls, so a MutationObserver alone is unreliable —
  // polling is simple and self-healing, same approach as
  // caption-policy's reconcile loop).
  tick();
  timer = setInterval(tick, intervalMs);

  return {
    tick,
    /** @returns {boolean|null} last reported state */
    state() { return last; },
    dispose() {
      disposed = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
