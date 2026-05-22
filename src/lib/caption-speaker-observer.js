// Caption-based speaker-timeline observer — the production-standard,
// most-accurate DOM technique for "who spoke when" in Google Meet /
// Microsoft Teams (the same approach recall.ai's in-house bots,
// Tactiq, and the widely-used Teams Live-Captions-Saver use).
//
// Why captions instead of the speaking-ring tile heuristic:
//   * The caption region is a semantic ARIA live region
//     (``[aria-live]``) / a stable ``data-tid`` surface — Google and
//     Microsoft will not drop it (it's an accessibility surface), so
//     it's far more stable than the obfuscated tile class/jsname hooks
//     that rotate every release.
//   * Each caption block is attributed to a SPEAKER NAME by the
//     meeting client itself → accurate attribution, not a guess.
//   * Real spoken text + real names → an accurate speaker timeline.
//
// Requires live captions to be ON. We attempt to enable them; if the
// user/meeting blocks that, the caller falls back to the (hardened)
// tile detector. Best-effort throughout: never throws into the
// recording/transcribe pipeline.
//
// Selectors verified against the current (2026) Meet/Teams web clients
// using the maintained reference implementations: recall.ai's
// google-meet-meeting-bot (Meet badge ``.NWpY1d, .xoMHSc``) and
// Zerg00s/Live-Captions-Saver (Teams ``closed-caption-v2`` wrapper +
// ``.fui-ChatMessageCompact`` + ``[data-tid="author"]``).

const DEFAULTS = Object.freeze({
  // Meet's speaker-name badge classes + resilient fallbacks. Verified
  // against the live 2026 Meet web client (real-capture e2e,
  // tests/e2e/realmeet-capture.spec.js): the speaker name renders as
  // ``<span class="NWpY1d">Full Name</span>`` inside the caption
  // block — ``.NWpY1d`` matched a real participant ("Shubham
  // Pilivkar"). ``.xoMHSc`` is kept as a historical/roll-back
  // fallback; the attribute selectors guard future class churn.
  //
  // Bug 5.2 — the two ``[data-tid='closed-caption*'] [data-tid='author']``
  // entries are scoped Teams variants. The previous bare
  // ``[data-tid='author']`` matched ANY author cell on the Teams web
  // app — including the side-panel chat author badge — so a chat
  // message could spuriously look like a caption block. Scoped to a
  // caption-container parent so only real caption-author cells match.
  // Bare ``[data-self-name]`` / ``[data-speaker-name]`` remain as
  // generic fallbacks (those attributes are already caption-specific
  // on Meet and don't have the Teams over-match problem).
  badgeSelectors:
    '.NWpY1d, .xoMHSc, [class*="caption" i] [class*="name" i],'
    + '[data-self-name], [data-speaker-name],'
    + " [data-tid='closed-caption-v2-window-wrapper'] [data-tid='author'],"
    + " [data-tid='closed-captions-renderer'] [data-tid='author'],"
    + ' [data-tid*="closed-caption" i] [data-tid="author"]',
  // Caption region anchors. The semantic
  // ``[role="region"][aria-label="Captions"]`` node is the MOST
  // stable hook (an accessibility surface Google won't drop) and is
  // the actual 2026 container — added first after a real-Meet capture
  // showed the caption block lives directly under it (itself nested
  // in ``jsname="dsyhDe"``). ``[aria-live]`` is the generic a11y
  // anchor. The ``jsname`` values outlive class-name churn; the 2026
  // client uses ``dsyhDe`` (``tgaKEf`` kept for roll-forward/-back).
  // All kept so the characterData path still resolves the block
  // across client versions.
  regionSelectors:
    '[role="region"][aria-label*="caption" i], [aria-live],'
    + ' [jsname="tgaKEf"], [jsname="dsyhDe"], [data-tid*="caption" i]',
});

// When caption TEXT is clearly flowing but NO speaker badge resolves
// (Meet rotates the obfuscated badge class every few releases — see the
// header), attributing every line to this generic label keeps a
// COARSE-but-real timeline instead of emitting nothing. A one-speaker
// timeline is a soft degradation the backend correlator already
// tolerates; a MISSING timeline (no speaker_timelines row → no
// timelines.json) is the actual user-visible defect this guards
// against. Mirrors the "never nothing" philosophy of the finalize /
// correlation workers.
const GENERIC_SPEAKER = 'Speaker';

// System / non-speech lines that appear inside the caption or live
// region and must NOT create phantom speaker turns. Mirrors the
// junk filter recall.ai's bot applies to Meet captions.
const DEFAULT_JUNK = new RegExp(
  [
    'you left the (call|meeting)',
    'return to home screen',
    'rejoin|leave call|leave meeting',
    'turn on captions|turn off captions',
    'meeting (is being|was) recorded|recording (started|stopped)',
    'waiting for|trying to (re)?connect|reconnecting',
    'learn more|give feedback|audio and video',
    'captions? (are|is) (on|off)|live captions',
  ].join('|'),
  'i',
);

let CAP_ID_SEQ = 0;

// Health-check defaults (Bug 5.1). Fires ``selectors_broken``
// telemetry when captions were once flowing but stopped landing for
// longer than the breakage threshold. Mirrors the speaker-detector's
// ``SELECTORS_BROKEN_MS`` (the constants-module value used by the
// production tile detector — kept consistent so both paths trip on
// the same wall-clock budget). Callers can override via opts to keep
// the tests fast without 30s waits.
const DEFAULT_SELECTORS_BROKEN_MS = 30_000;
const DEFAULT_HEALTH_CHECK_TICK_MS = 5_000;

/**
 * @param {{
 *   root?: ParentNode,
 *   badgeSelectors?: string,
 *   regionSelectors?: string,
 *   blockSelector?: string,
 *   textSelector?: string,
 *   junkFilter?: RegExp | ((text: string) => boolean),
 *   enableCaptions?: () => void,
 *   getElapsedSeconds: () => number,
 *   isActive: () => boolean,
 *   onChange: (e: { speaker_name: string, start_time: number, end_time: number }) => void,
 *   onTelemetry?: (name: string, payload?: Record<string, unknown>) => void,
 * }} opts
 */
export function startCaptionSpeakerObserver(opts) {
  const root = opts.root || document.body;
  const badgeSel = opts.badgeSelectors || DEFAULTS.badgeSelectors;
  const regionSel = opts.regionSelectors || DEFAULTS.regionSelectors;
  // Teams delimits each speaker turn with a stable block element
  // (``.fui-ChatMessageCompact``); Meet has no equivalent so callers
  // leave this unset and we treat each badge-bearing node as a block.
  const blockSel = opts.blockSelector || '';
  // Teams exposes the caption body in a dedicated element; Meet does
  // not, so we fall back to clone-minus-badge text extraction.
  const textSel = opts.textSelector || '';
  const { getElapsedSeconds, isActive, onChange } = opts;
  const tel = (n, p) => { try { opts.onTelemetry?.(n, p ?? {}); } catch { /* noop */ } };

  const junk = opts.junkFilter ?? DEFAULT_JUNK;
  // Bug 5.1 — test seams for the health-check timing. Production
  // omits these and gets the 30s / 5s defaults.
  const now = opts.now ?? (() => Date.now());
  const selectorsBrokenMs = opts.selectorsBrokenMs ?? DEFAULT_SELECTORS_BROKEN_MS;
  const healthTickMs = opts.healthTickMs ?? DEFAULT_HEALTH_CHECK_TICK_MS;
  const isJunk = (txt) => {
    if (!txt) return true;
    try {
      return typeof junk === 'function' ? !!junk(txt) : junk.test(txt);
    } catch {
      return false;
    }
  };

  /** @type {{ name: string, startSec: number, capId: string } | null} */
  let current = null;
  // capIds of turns we've already closed (emitted). A caption row that
  // has been superseded can still receive a LATE in-place mutation
  // (Meet keeps several rows live and mutates them out of order); without
  // this, that stale mutation re-opened the finished turn as ``current``,
  // dropping the intervening speaker and stretching the old speaker's
  // window over everyone else's. Bounded FIFO so a long meeting doesn't
  // grow it without limit.
  const closedCapIds = new Set();
  const CLOSED_CAP_IDS_MAX = 2048;
  let lastSpeaker = '';
  let sawAnyCaption = false;
  let unattributedReported = false;
  let observer = null;
  let enableTimer = null;
  // Bug 5.1 — health-check state. ``lastObservationAt`` is the
  // monotonic ms of the last real caption block we successfully
  // parsed; the timer below polls every ``HEALTH_CHECK_TICK_MS`` and
  // fires ``selectors_broken`` telemetry ONCE when captions WERE
  // flowing but went silent for ``SELECTORS_BROKEN_MS`` — strongest
  // signal that the platform's caption DOM rotated under us (Meet
  // ships a new caption-class string, breakout-room re-mount changed
  // the badge wrapper, …). The tile-based detector emits this
  // signal today but it isn't wired into production; until that's
  // restored, this is the only path that surfaces caption-only
  // breakage in telemetry. One-shot per observer lifetime: a real
  // breakage doesn't recover on its own, so re-firing every tick
  // would just spam dashboards.
  let lastObservationAt = 0;
  let healthTimer = null;
  let selectorsBrokenFired = false;

  function speakerOf(block) {
    const badge = block.querySelector?.(badgeSel);
    const name = badge && badge.textContent ? badge.textContent.trim() : '';
    if (name && name.length >= 2 && name.length <= 60) return name;
    // Caption continuation lines carry no badge — Meet/Teams keep the
    // same speaker until a new badge appears.
    return lastSpeaker;
  }

  function textOf(block) {
    try {
      // Teams: the caption body has its own element — read it directly
      // so the speaker badge / timestamps never leak into the text.
      if (textSel) {
        const t = block.querySelector?.(textSel);
        if (t) return (t.textContent || '').trim();
      }
      const clone = /** @type {HTMLElement} */ (block.cloneNode(true));
      clone.querySelectorAll(badgeSel).forEach((el) => el.remove());
      if (textSel) clone.querySelectorAll(textSel).forEach(() => {});
      return (clone.textContent || '').trim();
    } catch {
      return '';
    }
  }

  function handleBlock(el) {
    if (!el || typeof el.querySelector !== 'function') return;
    let speaker = speakerOf(el);
    const text = textOf(el);
    if (!text) return; // not a caption block
    // Drop system / non-speech lines so they never open a phantom
    // turn attributed to whatever the last real speaker was. Done
    // BEFORE the generic-speaker fallback so junk can't manufacture a
    // ``GENERIC_SPEAKER`` turn out of "Turn on captions" etc.
    if (isJunk(text)) return;
    if (!speaker) {
      // Real caption text, but no speaker badge resolved → the badge
      // class almost certainly rotated. Degrade to a coarse single
      // "Speaker" timeline rather than emitting nothing (the bug this
      // fixes: mp4 present, timelines.json absent because zero
      // SPEAKER_CHANGE events were ever buffered). Surface it once so
      // the breakage is observable in telemetry instead of silent.
      //
      // Strictly gated so this can't manufacture phantom turns: the
      // node must be a real caption row — inside a caption region and
      // NOT the badge element itself (``scan`` re-feeds badge nodes,
      // whose text is the speaker LABEL, not speech). Junk is already
      // filtered above.
      const isBadgeNode = !!el.matches?.(badgeSel);
      const inRegion =
        !!el.matches?.(regionSel) || !!el.closest?.(regionSel);
      if (isBadgeNode || !inRegion) return; // not a caption block
      if (!unattributedReported) {
        unattributedReported = true;
        tel('caption_speaker_unattributed', { source: 'captions' });
      }
      speaker = GENERIC_SPEAKER;
    }
    if (!sawAnyCaption) {
      sawAnyCaption = true;
      tel('caption_speaker_observer_engaged', { source: 'captions' });
    }
    // Bug 5.1 — stamp every successful parse so the health-check tick
    // can tell "captions are flowing" from "captions stopped landing".
    // Done HERE (after junk/badge-only filters) so a flood of bogus
    // mutations against the same node doesn't keep the timestamp
    // artificially fresh while real captions are absent.
    lastObservationAt = now();
    // Stamp a stable id so repeated in-place mutations of the SAME
    // caption block (Teams/Meet grow text in place as it finalizes)
    // are recognised as the same utterance, not churn. This id is the
    // turn key below — one caption block == one turn.
    let capId;
    if (el.dataset && el.dataset.mmCapId !== undefined) {
      capId = el.dataset.mmCapId;
    } else {
      capId = String(++CAP_ID_SEQ);
      try { if (el.dataset) el.dataset.mmCapId = capId; }
      catch { /* read-only node — capId is still unique for this call */ }
    }
    lastSpeaker = speaker;
    // ``elapsedSec`` (not ``now``) — Bug 5.1 added a module-level
    // ``const now = opts.now ?? ...`` that ``lastObservationAt =
    // now()`` above relies on. A same-block ``const now`` here put
    // the OUTER ``now`` into the TDZ.
    const elapsedSec = getElapsedSeconds();

    // Turn tracking. A turn is a continuous run by one speaker; it
    // closes when a DIFFERENT speaker is seen (badge-less continuation
    // lines keep the same speaker and merely extend the open turn).
    //
    // The ``closedCapIds`` guard is the interleaving fix: Meet keeps
    // several caption rows live and the MutationObserver can fire for
    // them out of order, so AFTER a block's turn has been closed it can
    // still receive a late in-place mutation. Without the guard, that
    // stale mutation (carrying a now-different speaker than ``current``)
    // re-opened the finished block's turn — dropping the intervening
    // speaker and stretching the old speaker's window. We ignore any
    // mutation on a block whose turn we already emitted.
    if (closedCapIds.has(capId)) return; // finished block; ignore late mutation
    if (!current) {
      current = { name: speaker, startSec: elapsedSec, capId };
      return;
    }
    if (speaker === current.name) {
      // Same speaker (same block growing, or a badge-less continuation
      // row) — extend the open turn, don't emit.
      return;
    }
    // Speaker changed → close the previous turn with a real [start,end]
    // window and mark its block done so a later out-of-order mutation
    // on it can't re-open it.
    onChange({
      speaker_name: current.name,
      start_time: current.startSec,
      end_time: elapsedSec,
    });
    closedCapIds.add(current.capId);
    if (closedCapIds.size > CLOSED_CAP_IDS_MAX) {
      // FIFO trim — Set preserves insertion order.
      closedCapIds.delete(closedCapIds.values().next().value);
    }
    // Same-block reuse guard: when the speaker change came from a
    // mutation on the SAME block that opened the just-closed turn
    // (Meet/Teams occasionally reuse one row element for a new speaker
    // rather than appending a new row), ``capId`` equals the capId we
    // just pushed into ``closedCapIds``. Reusing it for the new turn
    // would make the NEXT in-place change on this block hit the
    // ``closedCapIds`` guard at the top and freeze the turn (dropping a
    // third speaker). Mint a fresh id and re-stamp the element so the
    // reopened block is tracked independently of the closed one.
    let nextCapId = capId;
    if (capId === current.capId) {
      nextCapId = String(++CAP_ID_SEQ);
      try { if (el.dataset) el.dataset.mmCapId = nextCapId; }
      catch { /* read-only node — nextCapId is still unique for this call */ }
    }
    current = { name: speaker, startSec: elapsedSec, capId: nextCapId };
  }

  function scan(nodeList) {
    for (const n of nodeList) {
      if (!(n instanceof HTMLElement)) continue;
      // Prefer the platform's stable block element when the caller
      // gave one (Teams ``.fui-ChatMessageCompact``): the mutated node
      // may be inside a block, be a block, or contain several.
      if (blockSel) {
        if (n.matches?.(blockSel)) handleBlock(n);
        const own = n.closest?.(blockSel);
        if (own) handleBlock(own);
        n.querySelectorAll?.(blockSel).forEach((b) => handleBlock(b));
        continue;
      }
      // Meet path: the mutated node may BE a caption block or contain
      // several; key off the speaker badge.
      handleBlock(n);
      const within = n.querySelectorAll?.(badgeSel);
      if (within && within.length) {
        within.forEach((b) => {
          const blk = b.closest('[aria-live] *, [aria-live]') || b.parentElement || b;
          handleBlock(blk);
        });
      }
    }
  }

  function start() {
    // Try to turn captions on (best-effort). Caller may inject a
    // platform-specific enabler (Meet Shift+C / Teams menu walk);
    // otherwise we use the generic CC-button heuristic.
    if (typeof opts.enableCaptions === 'function') {
      try { opts.enableCaptions(); } catch { /* best-effort */ }
    } else {
      tryEnableCaptions();
    }

    observer = new MutationObserver((muts) => {
      if (!isActive()) return;
      for (const m of muts) {
        if (m.addedNodes && m.addedNodes.length) scan(m.addedNodes);
        if (m.type === 'characterData'
          && m.target && m.target.parentElement instanceof HTMLElement) {
          const p = m.target.parentElement;
          const blk = (blockSel && p.closest(blockSel))
            || p.closest(regionSel)
            || p;
          handleBlock(blk);
        }
      }
    });
    // Observe at ``root`` (document.body) with subtree: the caption
    // container is frequently re-created by Meet/Teams, so scoping the
    // observer to the container would silently stop after a swap.
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    // Bug 5.1 — start the breakage health-check. Polls every 5s;
    // fires telemetry ONCE when captions go silent for >30s after
    // having been seen at least once. Cheap interval — RAF would be
    // overkill for a 5s cadence, setInterval is what every other
    // detector in this codebase uses.
    healthTimer = setInterval(_healthCheckTick, healthTickMs);
  }

  function _healthCheckTick() {
    if (!isActive()) return;
    if (selectorsBrokenFired) return;
    // ``sawAnyCaption`` guard: a session that never had captions in
    // the first place isn't "broken" — it might be a no-captions
    // meeting (host disabled them, no permission, …). Only fire when
    // captions WERE working and stopped.
    if (!sawAnyCaption) return;
    const sinceMs = now() - lastObservationAt;
    if (sinceMs < selectorsBrokenMs) return;
    selectorsBrokenFired = true;
    tel('selectors_broken', { source: 'captions', sinceMs });
  }

  // Whether captions are actually rendering. Deliberately does NOT
  // treat bare ``[aria-live]`` as "on": Meet keeps a permanent polite
  // screen-reader announcer with aria-live that exists with captions
  // OFF (confirmed against the live client), so that check fooled the
  // enabler into never clicking. Use the toggle label flip + the real
  // caption region/badge instead.
  function captionsOn() {
    return !!(
      document.querySelector('button[aria-label*="Turn off captions" i]')
      || document.querySelector('.NWpY1d, .xoMHSc')
      || document.querySelector('[role="region"][aria-label*="caption" i]')
      || document.querySelector(
        "[data-tid='closed-caption-v2-window-wrapper'],"
        + "[data-tid='closed-captions-renderer'],[data-tid*='closed-caption' i]",
      )
    );
  }

  function tryEnableCaptions() {
    const click = () => {
      try {
        if (captionsOn()) return;
        const btn = [...document.querySelectorAll('button,[role="button"]')]
          .find((b) => {
            const s = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`
              .toLowerCase();
            return /caption|subtitle|cc\b/.test(s) && !/off|stop|turn off/.test(s);
          });
        if (btn) btn.click();
      } catch { /* best-effort */ }
    };
    click();
    // Captions UI can mount late; retry a few times then give up.
    let tries = 0;
    enableTimer = setInterval(() => {
      if (captionsOn() || ++tries > 6) {
        clearInterval(enableTimer);
        enableTimer = null;
        return;
      }
      click();
    }, 3000);
  }

  function flush() {
    if (current) {
      onChange({
        speaker_name: current.name,
        start_time: current.startSec,
        end_time: getElapsedSeconds(),
      });
      current = null;
    }
  }

  function dispose() {
    try { observer?.disconnect(); } catch { /* noop */ }
    if (enableTimer) { clearInterval(enableTimer); enableTimer = null; }
    // Bug 5.1 — health-check timer must be cleaned up too; leaving it
    // running after dispose would fire telemetry against a torn-down
    // session and (when the page navigates) leak the interval.
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    observer = null;
  }

  start();
  return {
    /** True once at least one real caption block was parsed. */
    hasCaptions: () => sawAnyCaption,
    flush,
    dispose,
    // Bug 5.1 — test seams. Production callers should NOT invoke
    // these; the internal setInterval (every ``healthTickMs``)
    // already runs ``_tickHealthCheck`` on a real clock, and
    // handleBlock stamps ``lastObservationAt`` from real DOM
    // mutations. Exposed so tests can drive the timing
    // deterministically without depending on happy-dom's
    // MutationObserver + setInterval ordering, which proved racey.
    _tickHealthCheck: _healthCheckTick,
    /** Test seam — pretend a real caption just landed. */
    _test_markCaptionSeen(ms) {
      sawAnyCaption = true;
      lastObservationAt = typeof ms === 'number' ? ms : now();
    },
  };
}
