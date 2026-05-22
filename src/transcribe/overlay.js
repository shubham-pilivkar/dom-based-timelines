// Content script — injects the live-transcription overlay into Meet
// and Teams tabs. Runs separately from meet.js / teams.js (which do
// recording's DOM-tile speaker detection) so the two concerns stay
// decoupled — adding a third platform later only requires updating
// the manifest matches, not rewriting the recording script.
//
// Renders inside a Shadow DOM root so host-page CSS never bleeds in.
// All styles live in one ``<style>`` tag inside the shadow root.

import { MessageType, StorageKey, TranscribeMode } from '../constants.js';
import { SpeakerNameMap } from './speaker-name-map.js';
import {
  loadDisplayName,
  resolveImportantPointSpeaker,
} from '../lib/user-name.js';
import { MicEchoDedup } from './mic-echo-dedup.js';

const ROOT_ID = 'meetminutes-transcribe-root';
// How many final-turn paragraphs to retain. The transcript half
// scrolls, so this is a memory bound, not a visible-line count —
// keeping only 12 made the panel feel like it "wasn't accumulating"
// (Bug 1). 250 turns is a long meeting's worth while still bounding
// DOM growth; older turns scroll up and out, newest stays in view.
const MAX_VISIBLE_FINALS = 250;

let shadowHost = null;
let shadowRoot = null;
// Test-only: when the SW forwards e2eOpenShadow on TRANSCRIBE_LIFECYCLE
// 'started', the shadow root is attached 'open' so an e2e harness can
// inspect the rendered turns. Defaults false → closed shadow root
// (production behaviour, isolates the overlay from host-page scripts).
let e2eOpenShadow = false;
let finalsEl = null;
let partialEl = null;
// Scroll container for the transcript half — auto-scrolled to the
// newest turn. The panel itself is a fixed-height flex column with
// overflow hidden, so the scroll has to live on this inner wrapper
// (scrolling the panel would also drag the important-points half).
let transcriptScrollEl = null;
// "Important points" section, rendered BELOW the transcript half.
// Populated from IMPORTANT_POINTS_UPDATE messages the SW forwards
// from the relay's extractor (same data the popup shows).
let pointsListEl = null;
let pointsCountEl = null;
let importantPoints = [];
// Hard gate for issue #2: the overlay must mount ONLY for a real
// transcription session in THIS tab. The content script is injected
// on every Meet/Teams page (it shares the manifest match with the
// recording speaker-tile detector), so without this flag a stray or
// stale TRANSCRIPT_EVENT / IMPORTANT_POINTS_UPDATE — or anything from
// the recording path — could mount the panel during a recording-only
// session. Set true ONLY on TRANSCRIBE_LIFECYCLE phase='started'
// (the explicit "transcription started here" signal) and false on
// 'stopped' / teardown. Every other mount path is gated on it.
let transcribeSessionActive = false;
// True while the user has muted their in-meeting mic (relayed by the
// SW as MIC_MUTE_STATE during an active transcribe). While set, the
// mic substream's partials/finals are dropped from the overlay so a
// muted user never sees their own speech transcribed; cleared on
// unmute. Tab/participant substreams are unaffected.
let micSuppressed = false;
// A transcript event is "mic-origin" when it came from the user's
// mic: Mode 3 tags it streamRole='mic'; Mode 1 ("self") has no
// streamRole but the whole session IS the mic. Participants/tab is
// never mic-origin (muting your mic must not stop transcribing
// others).
function _isMicEvent(streamRole) {
  if (streamRole === 'mic') return true;
  if (streamRole === 'tab') return false;
  return speakerMap.mode === TranscribeMode.SELF;
}

// Generic placeholder labels emitted by ``numericToLetter`` when the
// speaker-name resolver has no observation to bind against. Matches
// "Speaker", "Speaker A", "Speaker Z", "Speaker 27", etc. Used by
// the retroactive relabel pass to identify rendered rows that should
// be patched when a real-name observation arrives within the
// freshness window — important for Mode 2 (and the Mode 3 tab
// substream) where the first few finals routinely land before the
// caption observer sees a participant tile.
const _GENERIC_SPEAKER_LABEL = /^Speaker(?: [A-Z]| \d+)?$/;
function _isGenericSpeakerLabel(label) {
  return typeof label === 'string' && _GENERIC_SPEAKER_LABEL.test(label);
}
// Bug-1 guard: the SAME session emits ``started`` more than once — an
// SW-originated early mount, then the offscreen's WS-open started
// (twice for mode "both": mic + tab). The destructive
// "new session" resets (speaker map, important points, transcript
// clear) must run AT MOST ONCE per session, or each duplicate
// ``started`` wipes the accumulating transcript. Set on the first
// non-reconnect started; cleared on stop / teardown.
let overlaySessionInitialized = false;
// Speaker → last-known partial text. Lets us update each speaker's
// partial line in place instead of stacking duplicates as the
// provider revises the partial.
const partialBySpeaker = new Map();

// turn_order → committed final row element (keyed per substream, so a
// mic turn 1 and a tab turn 1 don't collide). AssemblyAI re-emits a
// final for the SAME turn_order when it formats / refines a turn —
// without this the overlay stacked each as a new line (the
// "duplicated, superset, out-of-order" transcript). When a final
// arrives for a turn_order we've already committed, we REPLACE that
// row's text in place instead of appending. Reset per session.
const finalRowByTurn = new Map();
function _turnKey(streamRole, turnOrder) {
  return `${streamRole ?? 'default'}:${turnOrder}`;
}

// Single resolver instance — see ``speaker-name-map.js`` for the full
// rationale on numeric→name binding. Reset on each new session via
// ``speakerMap.reset()`` from the lifecycle handler.
const speakerMap = new SpeakerNameMap();

// Mode 3 double-render guard (Bug 12.1): in mode='both' the user's
// voice is captured TWICE — directly by the mic substream and
// echoed back via the tab substream (the meeting audio mix
// includes the user's own speech). Without dedup the overlay
// renders each utterance twice. This ring records mic-substream
// finals; ``isEcho`` lets ``renderFinal`` drop a tab-substream
// final that matches a recent mic one. Reset on every new
// session via the lifecycle handler.
const micEchoDedup = new MicEchoDedup();

// Phase U6 — overlay position + minimize state. Defaults match the
// pre-U6 hardcoded ``right: 16, bottom: 96``. Loaded from storage on
// first ensureOverlay() so the panel respects the user's last drop
// point. Saved on mouseup so a drag-and-throwaway move doesn't
// thrash IDB.
// right/bottom = anchor offsets (panel is fixed-position bottom-right);
// width/height = user-resized panel size. Defaults match the original
// hardcoded panel. Bumped to a taller rectangle so the panel opens
// large enough to read a few turns AND show the important-points
// section underneath without an immediate resize.
const OVERLAY_DEFAULTS = Object.freeze({
  right: 16, bottom: 96, width: 440, height: 580,
});
// Resize clamps — keep the panel usable and on-screen. Min height
// raised so both the transcript and important-points halves stay
// visible at the smallest size.
const OVERLAY_MIN = Object.freeze({ width: 280, height: 240 });
const OVERLAY_MAX = Object.freeze({ width: 860, height: 900 });
let overlayPos = { ...OVERLAY_DEFAULTS };
let overlayMinimized = false;
let overlayPrefsLoaded = false;

async function loadOverlayPrefs() {
  if (overlayPrefsLoaded) return;
  overlayPrefsLoaded = true;
  try {
    const got = await chrome.storage.local.get([
      StorageKey.OVERLAY_POSITION,
      StorageKey.OVERLAY_MINIMIZED,
    ]);
    const pos = got[StorageKey.OVERLAY_POSITION];
    if (pos && typeof pos === 'object'
        && typeof pos.right === 'number' && Number.isFinite(pos.right)
        && typeof pos.bottom === 'number' && Number.isFinite(pos.bottom)) {
      const clamp = (v, lo, hi, dflt) =>
        (typeof v === 'number' && Number.isFinite(v)
          ? Math.min(hi, Math.max(lo, v)) : dflt);
      // Bug 14.1 follow-up — apply the SAME upper-bound viewport
      // clamp the drag handler uses, so a legacy off-screen position
      // saved before the runtime drag clamp shipped (or saved on a
      // larger monitor and reloaded on a smaller one) doesn't render
      // the panel invisibly. Mirror the constants from the drag
      // handler so the load-time and drag-time behaviour match.
      const MIN_VISIBLE_PX = 16;
      const vw = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0;
      const vh = (typeof window !== 'undefined' ? window.innerHeight : 0) || 0;
      const maxRight = Math.max(0, vw - MIN_VISIBLE_PX);
      const maxBottom = Math.max(0, vh - MIN_VISIBLE_PX);
      overlayPos = {
        right: Math.min(maxRight, Math.max(0, pos.right)),
        bottom: Math.min(maxBottom, Math.max(0, pos.bottom)),
        width: clamp(pos.width, OVERLAY_MIN.width, OVERLAY_MAX.width,
          OVERLAY_DEFAULTS.width),
        height: clamp(pos.height, OVERLAY_MIN.height, OVERLAY_MAX.height,
          OVERLAY_DEFAULTS.height),
      };
    }
    overlayMinimized = !!got[StorageKey.OVERLAY_MINIMIZED];
  } catch {
    /* storage failure — use defaults */
  }
}

function applyOverlayPosition() {
  if (!shadowHost) return;
  shadowHost.style.right = `${overlayPos.right}px`;
  shadowHost.style.bottom = `${overlayPos.bottom}px`;
}

// Apply the user-chosen panel size. Skipped while minimized (the
// minimized pill is auto-sized); re-applied on restore.
function applyOverlaySize() {
  if (!shadowRoot) return;
  const panel = shadowRoot.querySelector('.panel');
  if (!panel || overlayMinimized) return;
  panel.style.width = `${overlayPos.width}px`;
  // Fixed height (not max-height): the panel is a flex column whose
  // transcript half flexes and important-points half is pinned at the
  // bottom, so it needs a definite box to divide.
  panel.style.height = `${overlayPos.height}px`;
}

function applyOverlayMinimized() {
  if (!shadowRoot) return;
  const panel = shadowRoot.querySelector('.panel');
  if (!panel) return;
  panel.classList.toggle('minimized', overlayMinimized);
  if (overlayMinimized) {
    // Let the minimized pill auto-size.
    panel.style.width = '';
    panel.style.height = '';
    panel.style.maxHeight = '';
  } else {
    applyOverlaySize();
  }
}

async function saveOverlayPos() {
  try {
    await chrome.storage.local.set({
      [StorageKey.OVERLAY_POSITION]: { ...overlayPos },
    });
  } catch { /* best-effort */ }
}

async function saveOverlayMinimized() {
  try {
    await chrome.storage.local.set({
      [StorageKey.OVERLAY_MINIMIZED]: overlayMinimized,
    });
  } catch { /* best-effort */ }
}

// Drag handlers. We attach mousemove + mouseup on window so a drag
// continues smoothly when the cursor leaves the panel (e.g. user
// throws the overlay quickly across the screen). The handler refs
// are module-local so removeOverlay() can detach them; without that
// a stale handler would keep firing after the session ended.
let dragState = null;
let dragMoveHandler = null;
let dragUpHandler = null;
// Resize handlers — same window-listener pattern + detach discipline.
let resizeState = null;
let resizeMoveHandler = null;
let resizeUpHandler = null;

function attachDragHandlers(panelEl) {
  if (!panelEl) return;
  panelEl.addEventListener('mousedown', (e) => {
    // Buttons, inputs, resize handles, and links keep their own click
    // semantics — only blank panel surface starts a drag.
    if (e.target.closest(
      '.minimize-btn, .icon-btn, button, input, textarea, select, ' +
      'a, [contenteditable], [class*="resize-"]'
    )) return;
    dragState = {
      startX: e.clientX, startY: e.clientY,
      startRight: overlayPos.right, startBottom: overlayPos.bottom,
    };
    // Preventing default keeps text selection from kicking in when
    // the user drags across the transcript / speaker rows.
    e.preventDefault();
  });

  dragMoveHandler = (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    // Mouse moving right ⇒ right anchor decreases; same for bottom.
    // Bug 14.1 — clamp BOTH ends so the panel can't be dragged
    // off-screen. The bottom-right anchor was already floored at 0
    // but had no upper bound, so a user could push the right/bottom
    // offsets past the viewport → panel invisible AND its off-screen
    // position got persisted to storage, making the overlay
    // permanently invisible on reload. Cap so at least
    // MIN_VISIBLE_PX of the panel stays inside the viewport on the
    // anchored side (still grabbable to drag back).
    const MIN_VISIBLE_PX = 16;
    const vw = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0;
    const vh = (typeof window !== 'undefined' ? window.innerHeight : 0) || 0;
    overlayPos.right = Math.max(
      0,
      Math.min(Math.max(0, vw - MIN_VISIBLE_PX), dragState.startRight - dx),
    );
    overlayPos.bottom = Math.max(
      0,
      Math.min(Math.max(0, vh - MIN_VISIBLE_PX), dragState.startBottom - dy),
    );
    applyOverlayPosition();
  };
  dragUpHandler = () => {
    if (!dragState) return;
    dragState = null;
    void saveOverlayPos();
  };
  window.addEventListener('mousemove', dragMoveHandler, true);
  window.addEventListener('mouseup', dragUpHandler, true);
}

function detachDragHandlers() {
  if (dragMoveHandler) {
    window.removeEventListener('mousemove', dragMoveHandler, true);
    dragMoveHandler = null;
  }
  if (dragUpHandler) {
    window.removeEventListener('mouseup', dragUpHandler, true);
    dragUpHandler = null;
  }
  dragState = null;
}

// Drag any edge or corner to resize (Bug 5 — previously only the
// top-left grew the panel). The panel is anchored bottom-right, so:
//   • left edge   → width grows as it moves left (anchor unchanged)
//   • top edge    → height grows as it moves up   (anchor unchanged)
//   • right edge  → width follows the cursor; the ``right`` offset is
//     adjusted by the same amount so the LEFT edge stays put
//   • bottom edge → height follows; ``bottom`` adjusted so the TOP
//     edge stays put
//   • corners     → the two adjacent edges combined
// ``handles`` is a list of { el, edges } where edges is a subset of
// {left,right,top,bottom}. Clamped to OVERLAY_MIN/MAX, anchor offsets
// kept ≥ 0, persisted on mouseup.
function attachResizeHandlers(panelEl, handles) {
  if (!panelEl || !Array.isArray(handles)) return;
  for (const h of handles) {
    if (!h || !h.el) continue;
    const edges = h.edges || {};
    h.el.addEventListener('mousedown', (e) => {
      if (overlayMinimized) return;
      resizeState = {
        startX: e.clientX, startY: e.clientY,
        startW: overlayPos.width, startH: overlayPos.height,
        startRight: overlayPos.right, startBottom: overlayPos.bottom,
        edges,
      };
      panelEl.classList.add('resizing');
      e.preventDefault();
      e.stopPropagation();
    });
  }

  const clampW = (w) => Math.min(
    OVERLAY_MAX.width, Math.max(OVERLAY_MIN.width, w),
  );
  const clampH = (h) => Math.min(
    OVERLAY_MAX.height, Math.max(OVERLAY_MIN.height, h),
  );

  resizeMoveHandler = (e) => {
    if (!resizeState) return;
    const dx = e.clientX - resizeState.startX;
    const dy = e.clientY - resizeState.startY;
    const ed = resizeState.edges;
    let w = resizeState.startW;
    let h = resizeState.startH;
    let right = resizeState.startRight;
    let bottom = resizeState.startBottom;
    // Left/top: opposite (anchored) edge fixed → just resize.
    if (ed.left) w = clampW(resizeState.startW - dx);
    if (ed.top) h = clampH(resizeState.startH - dy);
    // Right/bottom: move the anchor by the SAME delta as the size
    // change so the far (left/top) edge stays visually pinned.
    if (ed.right) {
      w = clampW(resizeState.startW + dx);
      right = Math.max(0, resizeState.startRight - (w - resizeState.startW));
    }
    if (ed.bottom) {
      h = clampH(resizeState.startH + dy);
      bottom = Math.max(0, resizeState.startBottom - (h - resizeState.startH));
    }
    overlayPos.width = w;
    overlayPos.height = h;
    overlayPos.right = right;
    overlayPos.bottom = bottom;
    applyOverlaySize();
    applyOverlayPosition();
  };
  resizeUpHandler = () => {
    if (!resizeState) return;
    resizeState = null;
    if (panelEl) panelEl.classList.remove('resizing');
    void saveOverlayPos();
  };
  window.addEventListener('mousemove', resizeMoveHandler, true);
  window.addEventListener('mouseup', resizeUpHandler, true);
}

function detachResizeHandlers() {
  if (resizeMoveHandler) {
    window.removeEventListener('mousemove', resizeMoveHandler, true);
    resizeMoveHandler = null;
  }
  if (resizeUpHandler) {
    window.removeEventListener('mouseup', resizeUpHandler, true);
    resizeUpHandler = null;
  }
  resizeState = null;
}

async function loadSelfNameFromStorage() {
  // Pull the canonical display name (backend ``user.name`` →
  // email-derived fallback) via the shared resolver. "You" is the
  // final ambient fallback for the signed-out / first-paint case so
  // the overlay never renders a blank speaker label.
  try {
    const name = await loadDisplayName();
    speakerMap.setSelfName(name || 'You');
  } catch {
    speakerMap.setSelfName('You');
  }
}

// Bug 10.1 — refresh ``speakerMap.selfName`` mid-session when the
// signed-in user changes (sign-out → sign-in as a different account
// in the popup while the overlay is still mounted in a meeting tab).
// Without this, the overlay continues rendering the OLD name on every
// mic-substream event until the user starts a fresh transcribe session.
// Idempotent + cheap: only re-reads storage when the relevant keys
// changed. Safe to register at module load — chrome.storage.onChanged
// is a per-extension global.
let _selfNameStorageListenerInstalled = false;
function installSelfNameStorageListener() {
  if (_selfNameStorageListenerInstalled) return;
  _selfNameStorageListenerInstalled = true;
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local') return;
      if (
        !(StorageKey.USER_NAME in changes)
        && !(StorageKey.USER_EMAIL in changes)
      ) return;
      // Fire-and-forget — the resolver is async but the overlay's
      // next render will pick up the new selfName via the same
      // ``speakerMap.selfName`` it always reads.
      void loadSelfNameFromStorage();
    });
  } catch { /* chrome.storage unavailable in some contexts */ }
}
installSelfNameStorageListener();

function ensureOverlay() {
  // ``isConnected`` (NOT document.body.contains): the host is appended
  // to ``document.documentElement`` (the <html> element), so
  // ``document.body.contains(shadowHost)`` was ALWAYS false — the
  // early-return never fired, so every transcript event (handleEvent
  // calls ensureOverlay per event) tore the panel down and rebuilt it
  // EMPTY, wiping every accumulated final. ``isConnected`` is true for
  // any node attached to the document tree (html OR body, shadow DOM
  // included), making this guard actually idempotent so finals
  // accumulate.
  if (shadowHost && shadowHost.isConnected) return;
  // Bug 14.2 — SPA navigation can unmount the entire ``document``
  // subtree (Meet route change between meeting rooms / breakout
  // re-mount). On the re-mount path we land here with no shadow host
  // (or a disconnected one). Resetting the prefs-loaded latch makes
  // ``loadOverlayPrefs()`` re-run on the next mount so the panel
  // respects the user's saved position again instead of stranding
  // them at the default. Cheap and safe — the storage read is
  // idempotent; rerunning it just refreshes the cached values.
  overlayPrefsLoaded = false;
  // Tear down a stale root from a previous session (rare but cheap
  // to guard against — e.g. SPA-navigated meeting page that didn't
  // GC our previous host element).
  const stale = document.getElementById(ROOT_ID);
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale);

  shadowHost = document.createElement('div');
  shadowHost.id = ROOT_ID;
  // Inline positioning so the overlay isn't affected by Meet's /
  // Teams's host-page CSS. z-index pinned at the practical max so
  // the meeting controls don't obscure the transcript. Phase U6 —
  // the right/bottom values come from the persisted position; we
  // still write a fallback inline-style first so the overlay never
  // renders at 0,0 when the storage read is still pending.
  shadowHost.setAttribute(
    'style',
    [
      'all: initial',
      'position: fixed',
      `right: ${overlayPos.right}px`,
      `bottom: ${overlayPos.bottom}px`,
      'z-index: 2147483647',
      'pointer-events: none',
    ].join(';'),
  );
  shadowRoot = shadowHost.attachShadow({
    mode: e2eOpenShadow ? 'open' : 'closed',
  });
  // Meet/Teams enforce Trusted Types CSP — assigning a STRING to
  // innerHTML throws a TypeError and the overlay never renders.
  // Build the shadow DOM via textContent (CSS) + createElement
  // (structure); neither is a Trusted-Types-restricted sink.
  const _style = document.createElement('style');
  _style.textContent = `
      :host { all: initial; }
      .panel {
        position: relative;
        display: flex;
        flex-direction: column;
        font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: #f3f4f6;
        background: rgba(15, 17, 23, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.08);
        backdrop-filter: blur(8px);
        border-radius: 12px;
        padding: 12px 14px;
        width: 440px;
        height: 580px;
        overflow: hidden;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        pointer-events: auto;
        transition: width 0.15s ease, height 0.15s ease, padding 0.15s ease;
        /* Whole panel is the drag surface — interactive children
           reassert their own cursor below so the user sees the right
           affordance when hovering buttons / text / handles. */
        cursor: move;
      }
      .panel button,
      .panel a,
      .panel .icon-btn,
      .panel .minimize-btn,
      .panel [class*="resize-"] { cursor: pointer; }
      .panel input,
      .panel textarea,
      .panel [contenteditable] { cursor: text; }
      .panel .transcript-area,
      .panel .points-list { cursor: default; }
      /* Upper, major half — the live transcript. Flexes to fill all
         the space the important-points half below it doesn't claim,
         and scrolls internally (the panel itself does not scroll). */
      .transcript-area {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
      }
      /* Lower half — extracted important points. Pinned under the
         transcript with a divider; capped so a long meeting scrolls
         this list instead of crowding out the transcript. */
      .points {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        max-height: 42%;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
      }
      .points-head {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #93a4bf;
        margin-bottom: 6px;
        flex: 0 0 auto;
      }
      .points-count {
        font-variant-numeric: tabular-nums;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 999px;
        padding: 1px 7px;
        color: #cbd5e1;
      }
      .points-list {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
      }
      .point {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        margin: 5px 0;
        word-wrap: break-word;
      }
      .point-type {
        flex: 0 0 auto;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 1px 6px;
        border-radius: 5px;
        margin-top: 1px;
        color: #0f1115;
      }
      .point-type.action_item { background: #fbbf24; }
      .point-type.decision { background: #34d399; }
      .point-type.question { background: #60a5fa; }
      .point-type.key_takeaway { background: #c084fc; }
      .point-type.note { background: #94a3b8; }
      .point-text { flex: 1 1 auto; color: #e5e7eb; }
      .point-speaker { color: #93a4bf; margin-left: 4px; }
      /* Suppress the smooth transition while actively dragging the
         resize grip so the panel tracks the pointer 1:1. */
      .panel.resizing { transition: none; }
      /* Bug 5 — resize from EVERY edge and corner. Panel is anchored
         bottom-right; the move handlers do the anchor math so any
         side can grow/shrink. Thin hit-zones with a faint tint
         (brighter on hover) so they're discoverable but unobtrusive.
         Corners sit above edges (higher z) so the diagonal cursor
         wins in the overlap. */
      .resize-edge-x, .resize-edge-y,
      .resize-edge-r, .resize-edge-b,
      .resize-handle, .resize-corner-tr,
      .resize-corner-bl, .resize-corner-br {
        position: absolute;
        z-index: 2;
        background: rgba(147, 197, 253, 0.10);
      }
      .resize-edge-x:hover, .resize-edge-y:hover,
      .resize-edge-r:hover, .resize-edge-b:hover,
      .resize-handle:hover, .resize-corner-tr:hover,
      .resize-corner-bl:hover, .resize-corner-br:hover {
        background: rgba(147, 197, 253, 0.45);
      }
      /* Edges (thin strips, inset by the corner size so corners own
         the ends). */
      .resize-edge-x { left: 0;  top: 14px; bottom: 14px; width: 7px;  cursor: ew-resize; }
      .resize-edge-r { right: 0; top: 14px; bottom: 14px; width: 7px;  cursor: ew-resize; }
      .resize-edge-y { top: 0;    left: 14px; right: 14px; height: 7px; cursor: ns-resize; }
      .resize-edge-b { bottom: 0; left: 14px; right: 14px; height: 7px; cursor: ns-resize; }
      /* Corners (14px squares; diagonal cursors). */
      .resize-handle    { top: 0;    left: 0;  width: 14px; height: 14px; cursor: nwse-resize; border-top-left-radius: 12px; }
      .resize-corner-tr { top: 0;    right: 0; width: 14px; height: 14px; cursor: nesw-resize; border-top-right-radius: 12px; }
      .resize-corner-bl { bottom: 0; left: 0;  width: 14px; height: 14px; cursor: nesw-resize; border-bottom-left-radius: 12px; }
      .resize-corner-br { bottom: 0; right: 0; width: 14px; height: 14px; cursor: nwse-resize; border-bottom-right-radius: 12px; }
      .panel.minimized .resize-edge-x, .panel.minimized .resize-edge-y,
      .panel.minimized .resize-edge-r, .panel.minimized .resize-edge-b,
      .panel.minimized .resize-handle, .panel.minimized .resize-corner-tr,
      .panel.minimized .resize-corner-bl,
      .panel.minimized .resize-corner-br { display: none; }
      /* Header action buttons (copy / stop / close). */
      .icon-btn {
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.16);
        color: inherit;
        font: inherit;
        font-size: 11px;
        line-height: 1;
        padding: 2px 7px;
        border-radius: 6px;
        cursor: pointer;
      }
      .icon-btn:hover { background: rgba(255, 255, 255, 0.06); }
      .icon-btn:focus-visible {
        outline: 2px solid rgba(147, 197, 253, 0.7);
        outline-offset: 1px;
      }
      .stop-btn { border-color: rgba(248, 113, 113, 0.5); color: #fecaca; }
      .stop-btn:hover { background: rgba(248, 113, 113, 0.14); }
      .close-btn { border-color: rgba(148, 163, 184, 0.5); }
      .copy-btn.copied { border-color: rgba(52, 211, 153, 0.7); color: #6ee7b7; }
      .hidden { display: none !important; }
      /* Stopped state — calm grey dot, no pulse. */
      .panel.stopped .dot {
        background: #94a3b8 !important;
        animation: none !important;
        box-shadow: none !important;
        opacity: 0.7;
      }
      /* Phase U6 — minimized state. Collapses to a tiny pill that
         doesn't obstruct the meeting view. Click the pill (which
         in minimized mode is the whole panel) to restore. */
      .panel.minimized {
        width: auto;
        max-height: none;
        padding: 6px 10px;
        cursor: pointer;
      }
      .panel.minimized .transcript-area,
      .panel.minimized .points,
      .panel.minimized .header-title {
        display: none;
      }
      .panel.minimized .header {
        margin-bottom: 0;
      }
      .panel.minimized .minimize-btn::before {
        content: 'Live';
        font-weight: 600;
      }
      .header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #93a4bf;
        margin-bottom: 8px;
        cursor: move;
        user-select: none;
      }
      .header-title { flex: 1; }
      .dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #ef4444;
        animation: mm-pulse 1.4s ease-in-out infinite;
      }
      @keyframes mm-pulse { 0%,100% {opacity:1} 50% {opacity:.35} }
      /* Phase L1 — "Listening…" cold-start indicator. Cyan instead
         of red so it's visually distinct from the steady-state red
         "recording" dot; ring-pulse animation reads as "waiting for
         input" instead of "active output." */
      .dot.listening {
        background: #06b6d4;
        animation: mm-listening 1.2s ease-in-out infinite;
      }
      @keyframes mm-listening {
        0%,100% { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0.6); opacity: 1; }
        50% { box-shadow: 0 0 0 6px rgba(6, 182, 212, 0); opacity: .6; }
      }
      /* Minimize button — looks like a chip; doubles as the
         "click to expand" affordance when minimized. */
      .minimize-btn {
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.16);
        color: inherit;
        font: inherit;
        font-size: 11px;
        line-height: 1;
        padding: 2px 6px;
        border-radius: 6px;
        cursor: pointer;
      }
      .minimize-btn:hover {
        background: rgba(255, 255, 255, 0.06);
      }
      .minimize-btn:focus-visible {
        outline: 2px solid rgba(147, 197, 253, 0.7);
        outline-offset: 1px;
      }
      .finals .turn {
        margin: 6px 0;
        word-wrap: break-word;
      }
      .speaker {
        color: #93c5fd;
        font-weight: 600;
        margin-right: 6px;
      }
      /* Spec UI format: ''[Start Time] Speaker Name: Content''. The
         time is the local wall-clock when the line was first seen —
         provider ''started_at_ms'' is stream-relative and several
         providers emit 0, so it can't drive a user-meaningful clock.
         tabular-nums keeps the bracketed times vertically aligned. */
      .ts {
        color: #6b7488;
        margin-right: 6px;
        font-variant-numeric: tabular-nums;
      }
      /* Mode 3 — distinguish mic-substream (the user) finals from
         tab-substream (other participants) finals at a glance. A
         green chip-coloured speaker label + a left border doubles
         as a quick "this was you" visual cue without changing the
         text-rendering shape (so finals and partials still align). */
      .finals .turn-mic .speaker,
      .partials .partial-mic .speaker {
        color: #86efac;
      }
      .finals .turn-mic,
      .partials .partial-mic {
        border-left: 2px solid rgba(134, 239, 172, 0.4);
        padding-left: 6px;
      }
      .partials .partial {
        margin: 6px 0;
        color: #c7d2e0;
        font-style: italic;
        word-wrap: break-word;
      }
      .empty {
        color: #6b7488;
        font-style: italic;
      }
    `;
  const _mk = (tag, cls, attrs) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') el.textContent = v; else el.setAttribute(k, v);
    }
    return el;
  };
  const _panel = _mk('div', 'panel', { role: 'region', 'aria-label': 'Live transcription' });
  // 8 resize grips: 4 corners + 4 edges (Bug 5 — any side resizes).
  const _rh = _mk('div', 'resize-handle', { title: 'Resize', 'aria-hidden': 'true' });
  const _rcTr = _mk('div', 'resize-corner-tr', { title: 'Resize', 'aria-hidden': 'true' });
  const _rcBl = _mk('div', 'resize-corner-bl', { title: 'Resize', 'aria-hidden': 'true' });
  const _rcBr = _mk('div', 'resize-corner-br', { title: 'Resize', 'aria-hidden': 'true' });
  const _rex = _mk('div', 'resize-edge-x', { title: 'Resize width', 'aria-hidden': 'true' });
  const _rer = _mk('div', 'resize-edge-r', { title: 'Resize width', 'aria-hidden': 'true' });
  const _rey = _mk('div', 'resize-edge-y', { title: 'Resize height', 'aria-hidden': 'true' });
  const _reb = _mk('div', 'resize-edge-b', { title: 'Resize height', 'aria-hidden': 'true' });
  const _header = _mk('div', 'header');
  const _dot = _mk('span', 'dot', { 'aria-hidden': 'true' });
  const _title = _mk('span', 'header-title', { text: 'Live transcription' });
  const _copy = _mk('button', 'icon-btn copy-btn', { type: 'button', 'aria-label': 'Copy transcript', title: 'Copy transcript + important points', text: 'Copy' });
  const _stop = _mk('button', 'icon-btn stop-btn', { type: 'button', 'aria-label': 'Stop transcription', title: 'Stop live transcription', text: 'Stop' });
  const _close = _mk('button', 'icon-btn close-btn hidden', { type: 'button', 'aria-label': 'Close panel', title: 'Close', text: 'Close' });
  const _min = _mk('button', 'minimize-btn', { type: 'button', 'aria-label': 'Toggle overlay size', title: 'Drag the header to move; click here to minimize', text: '\u2212' });
  _header.append(_dot, _title, _copy, _stop, _close, _min);
  // Upper half: the transcript, in its own scroll container so it
  // can be auto-scrolled independently of the points half.
  const _scroll = _mk('div', 'transcript-area');
  const _finals = _mk('div', 'finals', { role: 'log', 'aria-live': 'polite' });
  const _partials = _mk('div', 'partials', { 'aria-live': 'off' });
  _scroll.append(_finals, _partials);
  // Lower half: extracted important points, always present (shows a
  // placeholder until the first batch arrives) so the panel has the
  // requested two-section shape from the moment it opens.
  const _points = _mk('div', 'points', { role: 'region', 'aria-label': 'Important points' });
  const _pHead = _mk('div', 'points-head');
  const _pTitle = _mk('span', 'points-title', { text: 'Important points' });
  const _pCount = _mk('span', 'points-count', { text: '0' });
  _pHead.append(_pTitle, _pCount);
  const _pList = _mk('div', 'points-list', { role: 'log', 'aria-live': 'polite' });
  _points.append(_pHead, _pList);
  _panel.append(
    _rh, _rcTr, _rcBl, _rcBr, _rex, _rer, _rey, _reb,
    _header, _scroll, _points,
  );
  shadowRoot.append(_style, _panel);
  finalsEl = shadowRoot.querySelector('.finals');
  partialEl = shadowRoot.querySelector('.partials');
  transcriptScrollEl = shadowRoot.querySelector('.transcript-area');
  pointsListEl = shadowRoot.querySelector('.points-list');
  pointsCountEl = shadowRoot.querySelector('.points-count');
  document.documentElement.appendChild(shadowHost);
  // Repaint any points already accumulated this session (the overlay
  // can be (re)mounted after batches have arrived — e.g. reconnect).
  renderImportantPoints();

  // Phase U6 — wire drag + minimize. Lazy-load prefs so the
  // overlay paints with the last saved position even if storage
  // resolves a tick late (defaults already applied above). The
  // panel itself is the drag surface (filtered for buttons / inputs
  // / resize handles in attachDragHandlers) — header-only drag was
  // too small a hit target.
  const minimizeBtn = shadowRoot.querySelector('.minimize-btn');
  const panelDragEl = shadowRoot.querySelector('.panel');
  attachDragHandlers(panelDragEl);
  // The minimize button toggles the minimized state on click; in
  // the minimized state the WHOLE panel becomes click-to-expand
  // (cursor pointer + click on panel restores).
  const toggleMinimize = (e) => {
    e.stopPropagation();
    overlayMinimized = !overlayMinimized;
    applyOverlayMinimized();
    void saveOverlayMinimized();
  };
  if (minimizeBtn) minimizeBtn.addEventListener('click', toggleMinimize);

  // Phase D — Copy / Stop / Close header actions.
  const copyBtn = shadowRoot.querySelector('.copy-btn');
  const stopBtn = shadowRoot.querySelector('.stop-btn');
  const closeBtn = shadowRoot.querySelector('.close-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void copyTranscript(copyBtn);
    });
  }
  if (stopBtn) {
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Ask the SW to stop the session. The resulting
      // TRANSCRIBE_LIFECYCLE 'stopped' flips us into the stopped
      // state (Close button) — we do NOT tear down here so the user
      // can still read / copy the transcript.
      try {
        chrome.runtime.sendMessage({ type: MessageType.STOP_TRANSCRIBE });
      } catch { /* SW asleep — the lifecycle event will still arrive */ }
      enterStoppedState('client_stop');
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Closing the window MUST tear the session down — otherwise the
      // backend WS(s) stay open (the user's mic keeps streaming in
      // self/both) and the SW state stays ACTIVE, so the NEXT Start
      // returns busy_transcribing until the stale socket dies minutes
      // later. STOP_TRANSCRIBE is idempotent (no-op if already
      // stopped), so this is safe whether the session was running or
      // already in the stopped state.
      try {
        chrome.runtime.sendMessage({ type: MessageType.STOP_TRANSCRIBE });
      } catch { /* SW asleep — supersede-on-next-start still recovers */ }
      removeOverlay();
    });
  }

  // Clicking anywhere on a minimized panel expands it back. The
  // dedicated button handler stopPropagation()s so this listener
  // doesn't double-fire.
  const panelEl = shadowRoot.querySelector('.panel');
  const _q = (s) => shadowRoot.querySelector(s);
  attachResizeHandlers(panelEl, [
    // Corners (two edges each).
    { el: _q('.resize-handle'), edges: { left: true, top: true } },
    { el: _q('.resize-corner-tr'), edges: { right: true, top: true } },
    { el: _q('.resize-corner-bl'), edges: { left: true, bottom: true } },
    { el: _q('.resize-corner-br'), edges: { right: true, bottom: true } },
    // Edges (single side).
    { el: _q('.resize-edge-x'), edges: { left: true } },
    { el: _q('.resize-edge-r'), edges: { right: true } },
    { el: _q('.resize-edge-y'), edges: { top: true } },
    { el: _q('.resize-edge-b'), edges: { bottom: true } },
  ]);
  if (panelEl) {
    panelEl.addEventListener('click', (e) => {
      if (!overlayMinimized) return;
      if (e.target.closest('.minimize-btn')) return;
      if (e.target.closest('.icon-btn')) return;
      if (e.target.closest('[class*="resize-"]')) return;
      overlayMinimized = false;
      applyOverlayMinimized();
      void saveOverlayMinimized();
    });
  }
  // Apply persisted prefs after the DOM is wired. Fire-and-forget;
  // any storage hiccup leaves the defaults in place.
  void loadOverlayPrefs().then(() => {
    applyOverlayPosition();
    applyOverlaySize();
    applyOverlayMinimized();
  });
}

function removeOverlay() {
  detachDragHandlers();
  detachResizeHandlers();
  // Any teardown drops the session gate (#2): a later data message
  // must not silently re-mount a panel for a session that's gone.
  transcribeSessionActive = false;
  overlaySessionInitialized = false;
  if (shadowHost && shadowHost.parentNode) {
    shadowHost.parentNode.removeChild(shadowHost);
  }
  shadowHost = null;
  shadowRoot = null;
  finalsEl = null;
  partialEl = null;
  transcriptScrollEl = null;
  pointsListEl = null;
  pointsCountEl = null;
  // Session ended — drop accumulated points so a subsequent session
  // in the same long-lived tab doesn't inherit the old meeting's.
  importantPoints = [];
  partialBySpeaker.clear();
  finalRowByTurn.clear();
  // Phase L1 — drop any pending partial-render timer so a late
  // schedulePartialFlush from a final inbound message doesn't fire
  // against a removed shadow root.
  if (partialFlushTimer !== null) {
    clearTimeout(partialFlushTimer);
    partialFlushTimer = null;
  }
  // Drop the provider-issue revert timer + de-spam memory so a new
  // session starts clean.
  if (_providerIssueTimer !== null) {
    clearTimeout(_providerIssueTimer);
    _providerIssueTimer = null;
  }
  _lastProviderErrorDetail = null;
}

// Composite key for the partials map: in Mode 3 both substreams
// emit ``speaker=0`` independently (provider diarization is
// substream-local), so a numeric-only key would collide them and the
// last partial would overwrite the other's text. Tagging by stream
// role keeps them distinct.
function _partialKey(streamRole, speakerNumeric) {
  return `${streamRole ?? 'default'}:${speakerNumeric ?? 'none'}`;
}

// Spec UI format: ``[Start Time] Speaker Name: Content``. ``ms`` is a
// wall-clock epoch (Date.now()); we render local 24h HH:MM:SS so the
// bracket is unambiguous regardless of the viewer's locale.
function _formatClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function _makeTimeSpan(ms) {
  const span = document.createElement('span');
  span.className = 'ts';
  span.textContent = `[${_formatClock(ms)}]`;
  return span;
}

function renderFinal(event, streamRole) {
  if (!finalsEl) return;
  // Resolve the speaker label once so the dedup guard, the row
  // class, and the rendered span all see the same value.
  const resolvedName = speakerMap.resolve(event, streamRole);
  const nowMs = Date.now();
  // Bug 12.1 — Mode 3 echo guard. In mode='both' the user's voice
  // hits both substreams: mic directly + tab via meeting-audio
  // echo. The mic final lands first (lower latency), the tab final
  // lands 1-3s later for the SAME utterance, resolved to the same
  // selfName via Phase 2D cross-pollination. Drop the tab echo so
  // the user reads each turn once.
  if (streamRole === 'tab'
    && micEchoDedup.isEcho(resolvedName, event.text, nowMs)) {
    // Clear any pending partial for this key so a stale partial
    // doesn't linger on the panel after we suppress the final.
    const _suppressedKey = _partialKey(streamRole, event.speaker);
    if (partialBySpeaker.delete(_suppressedKey)) renderPartials();
    return;
  }
  // Drop the speaker's pending partial — the final supersedes it.
  // Use the composite key so a tab final doesn't clear a mic partial
  // that happens to share the same numeric speaker id. Carry the
  // partial's first-seen timestamp onto the final so the bracketed
  // time reflects when the utterance *started*, not when it
  // finalised (a long sentence can sit as a partial for seconds).
  const _pkey = _partialKey(streamRole, event.speaker);
  const _startMs = partialBySpeaker.get(_pkey)?.ts ?? nowMs;
  partialBySpeaker.delete(_pkey);
  renderPartials();

  // turn_order dedup — if this turn was already committed (AssemblyAI
  // re-emits a final for the same turn_order when it formats/refines
  // the turn), REPLACE the existing row's text instead of appending a
  // duplicate/superset line. Only the text + speaker label update; the
  // bracketed start time stays as first committed.
  const _hasTurn = event.turn_order !== null && event.turn_order !== undefined;
  if (_hasTurn) {
    const existing = finalRowByTurn.get(_turnKey(streamRole, event.turn_order));
    if (existing && existing.isConnected) {
      const spk = existing.querySelector('.speaker');
      const txt = existing.querySelector('.text');
      if (spk) spk.textContent = `${resolvedName}:`;
      if (txt) txt.textContent = ` ${event.text}`;
      // Re-sync the retroactive-relabel tag for this re-emitted turn.
      // The re-render may now resolve to a real name (drop the tag so a
      // later SPEAKER_CHANGE can't flap an already-correct row) OR still
      // be generic with a possibly-changed provider speaker (refresh the
      // numeric + render clock so relabel keeps tracking it). Mirrors the
      // first-render tagging logic below.
      if (
        !_isMicEvent(streamRole)
        && _isGenericSpeakerLabel(resolvedName)
        && event.speaker !== null
        && event.speaker !== undefined
      ) {
        existing.dataset.mmPendingSpeaker = String(event.speaker);
        existing.dataset.mmRenderedAt = String(nowMs);
      } else {
        delete existing.dataset.mmPendingSpeaker;
        delete existing.dataset.mmRenderedAt;
      }
      if (transcriptScrollEl) {
        transcriptScrollEl.scrollTop = transcriptScrollEl.scrollHeight;
      }
      return;
    }
  }

  // Record mic-origin finals so the next tab-substream final
  // arriving for the same speech can recognise and drop the echo.
  // _isMicEvent covers BOTH mode='both' (streamRole='mic') and
  // mode='self' (streamRole=null, whole session is mic).
  if (_isMicEvent(streamRole) && resolvedName) {
    micEchoDedup.recordMicFinal(resolvedName, event.text, nowMs);
  }

  const row = document.createElement('div');
  // Tag mic-origin rows with an extra class so the chip can be
  // styled distinctly ("You" chip vs participant chips) in Mode 3.
  // The CSS adds the styling — overlay.html / overlay.css ship the
  // ``turn-mic`` rule alongside the existing ``turn`` rule.
  row.className = streamRole === 'mic' ? 'turn turn-mic' : 'turn';
  const spkSpan = document.createElement('span');
  spkSpan.className = 'speaker';
  spkSpan.textContent = `${resolvedName}:`;
  // Retroactive relabel — Mode 2 (and the Mode 3 tab substream) often
  // render the first few finals as "Speaker A/B" because the caption
  // observer hasn't seen a participant tile yet. Tag the row with the
  // provider's numeric speaker + render wall-clock so the next
  // SPEAKER_CHANGE handler can patch the displayed label in place when
  // a real-name observation lands within the freshness window. Tagging
  // is skipped for mic-origin rows (mic is always ``selfName``) and
  // for finals already resolved to a real participant name.
  if (
    !_isMicEvent(streamRole)
    && _isGenericSpeakerLabel(resolvedName)
    && event.speaker !== null
    && event.speaker !== undefined
  ) {
    row.dataset.mmPendingSpeaker = String(event.speaker);
    row.dataset.mmRenderedAt = String(nowMs);
  }
  const textSpan = document.createElement('span');
  // ``.text`` class so the turn_order replace-in-place path can target
  // the body span when AssemblyAI re-emits a final for this turn.
  textSpan.className = 'text';
  // Concatenate with a leading space so the speaker prefix has
  // breathing room. textContent (not innerHTML) is critical here —
  // any HTML escape would otherwise re-enable XSS via a forged
  // provider event.
  textSpan.textContent = ` ${event.text}`;
  row.appendChild(_makeTimeSpan(_startMs));
  row.appendChild(spkSpan);
  row.appendChild(textSpan);
  finalsEl.appendChild(row);
  // Remember this row by turn so a later re-emitted final for the same
  // turn replaces it instead of appending a duplicate.
  if (_hasTurn) {
    finalRowByTurn.set(_turnKey(streamRole, event.turn_order), row);
  }

  // Cap visible history so the overlay doesn't grow forever.
  while (finalsEl.childElementCount > MAX_VISIBLE_FINALS) {
    finalsEl.removeChild(finalsEl.firstChild);
  }
  // Auto-scroll the transcript half (not the panel — the panel is a
  // fixed flex column with overflow hidden; the scroll lives on the
  // inner transcript wrapper so it doesn't disturb the points half).
  if (transcriptScrollEl) {
    transcriptScrollEl.scrollTop = transcriptScrollEl.scrollHeight;
  }
}

/**
 * Walk the final rows currently in the transcript and rebind any that
 * are still labelled with a generic "Speaker A/B/…" placeholder when
 * a fresh DOM caption observation has now landed for them.
 *
 * Bounds: only rows rendered within the speakerMap's freshness window
 * of NOW are candidates. That symmetric window prevents stamping a
 * mid-meeting observation onto an old row from before the speaker
 * switched (``speakerMap.lookupAt`` itself is one-sided — it doesn't
 * upper-bound on wallClockMs — so the upper bound has to live here).
 *
 * The relabel uses ``speakerMap.lookupAt(now)`` so it picks up the
 * observation that JUST arrived (which is what triggered this call).
 * Also writes the binding into ``numericToName`` so subsequent finals
 * for the same provider speaker number resolve directly without
 * needing another retroactive pass. Updates the partial row in place
 * via ``renderPartials`` so any pending partial flips name too.
 */
function _relabelPendingFinals() {
  if (!finalsEl) return;
  const rows = finalsEl.querySelectorAll('[data-mm-pending-speaker]');
  if (!rows.length) return;
  const now = Date.now();
  const realName = speakerMap.lookupAt(now);
  if (!realName || _isGenericSpeakerLabel(realName)) return;
  const maxRowAgeMs = speakerMap.freshnessMs;
  let touched = false;
  for (const row of rows) {
    const numeric = row.dataset.mmPendingSpeaker;
    const renderedAt = Number(row.dataset.mmRenderedAt) || 0;
    if (!numeric || !renderedAt) continue;
    // Symmetric window — skip rows too old for the just-arrived
    // observation to be load-bearing on them.
    if (now - renderedAt > maxRowAgeMs) {
      delete row.dataset.mmPendingSpeaker;
      delete row.dataset.mmRenderedAt;
      continue;
    }
    const spkSpan = row.querySelector('.speaker');
    if (!spkSpan) continue;
    spkSpan.textContent = `${realName}:`;
    speakerMap.numericToName.set(numeric, realName);
    delete row.dataset.mmPendingSpeaker;
    delete row.dataset.mmRenderedAt;
    touched = true;
  }
  // Refresh in-flight partials too — a partial currently labelled
  // "Speaker A" should flip to the real name on the same observation,
  // not wait for the next provider partial revision.
  if (touched) renderPartials();
}

function renderPartials() {
  if (!partialEl) return;
  partialEl.replaceChildren();
  for (const entry of partialBySpeaker.values()) {
    if (!entry || !entry.text) continue;
    const row = document.createElement('div');
    row.className = entry.streamRole === 'mic'
      ? 'partial partial-mic'
      : 'partial';
    const spkSpan = document.createElement('span');
    spkSpan.className = 'speaker';
    // Synthesize the minimal event shape the resolver consumes; the
    // streamRole rides along as a second arg so Mode 3 mic partials
    // collapse to "You" without looking up against the
    // numeric→name cache.
    spkSpan.textContent = `${speakerMap.resolve({ speaker: entry.speaker }, entry.streamRole)}:`;
    const textSpan = document.createElement('span');
    textSpan.textContent = ` ${entry.text}`;
    row.appendChild(_makeTimeSpan(entry.ts ?? Date.now()));
    row.appendChild(spkSpan);
    row.appendChild(textSpan);
    partialEl.appendChild(row);
  }
}

// Mirror the popup's label mapping (src/popup/popup.js
// formatPointType) so the in-call overlay and the popup name point
// types identically. Unknown/unmapped types fall back to a title-
// cased token rather than the raw enum.
function formatPointType(t) {
  switch (t) {
    case 'action_item': return 'Action';
    case 'decision': return 'Decision';
    case 'question': return 'Question';
    case 'key_takeaway': return 'Takeaway';
    default:
      return typeof t === 'string' && t
        ? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ')
        : 'Note';
  }
}

// Repaint the important-points list from the module-level array.
// Full re-render (≤500 points, capped by the SW) — cheaper than
// diffing at that size and matches the popup's approach. textContent
// only (never innerHTML): a forged relay point must not be an HTML
// injection sink.
function renderImportantPoints() {
  if (!pointsListEl) return;
  if (pointsCountEl) pointsCountEl.textContent = String(importantPoints.length);
  pointsListEl.replaceChildren();
  if (importantPoints.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No important points yet';
    pointsListEl.appendChild(empty);
    return;
  }
  for (const p of importantPoints) {
    if (!p || typeof p.text !== 'string') continue;
    const row = document.createElement('div');
    row.className = 'point';
    const chip = document.createElement('span');
    // Class carries the raw type so the per-type colour rules match;
    // a bad type just lands unstyled (still readable).
    chip.className = `point-type ${typeof p.type === 'string' ? p.type : 'note'}`;
    chip.textContent = formatPointType(p.type);
    const text = document.createElement('span');
    text.className = 'point-text';
    text.textContent = p.text;
    // E1 — promote a first-name match against the signed-in user to
    // their full backend display name ("Shubham" → "Shubham
    // Pilivkar"); drop synthetic "Speaker A/B/C" placeholders. The
    // resolver consolidates the rule with the popup's filter so the
    // two surfaces stay in lockstep.
    const resolved = resolveImportantPointSpeaker(p.speaker, speakerMap.selfName);
    if (resolved) {
      const sp = document.createElement('span');
      sp.className = 'point-speaker';
      sp.textContent = `— ${resolved}`;
      text.appendChild(sp);
    }
    row.appendChild(chip);
    row.appendChild(text);
    pointsListEl.appendChild(row);
  }
}

// Phase L1 — partial-render debouncing. Providers emit dozens of
// interim messages per second; without coalescing, the overlay
// re-renders for each and the panel flickers. We collect partial
// updates into a 150ms window then flush once. Finals NEVER touch
// this timer — they paint immediately so the user never waits the
// debounce window to see a finalised turn. When a final arrives we
// flush any pending partials first, then render the final, so the
// visible order matches the wire order.
const PARTIAL_RENDER_DEBOUNCE_MS = 150;
let partialFlushTimer = null;

function schedulePartialFlush() {
  if (partialFlushTimer !== null) return;
  partialFlushTimer = setTimeout(() => {
    partialFlushTimer = null;
    renderPartials();
  }, PARTIAL_RENDER_DEBOUNCE_MS);
}

function flushPartialsNow() {
  if (partialFlushTimer !== null) {
    clearTimeout(partialFlushTimer);
    partialFlushTimer = null;
  }
  renderPartials();
}

// Phase L1 — "Listening…" indicator. Between the WS opening and the
// first inbound provider event there's a 200-500ms cold-start beat
// while the backend lazily opens its upstream provider WS. The
// overlay shows a pulsing dot in the header during that window so
// the user reads it as "waiting for you to speak" rather than "is
// this broken?" Cleared on the first provider event (handleEvent
// below) and re-armed on every ``started`` lifecycle phase.
function setListeningIndicator(active) {
  if (!shadowRoot) return;
  const dot = shadowRoot.querySelector('.dot');
  const label = shadowRoot.querySelector('.header .header-title');
  if (!dot || !label) return;
  if (active) {
    dot.classList.add('listening');
    label.textContent = 'Listening…';
  } else {
    dot.classList.remove('listening');
    // Only revert label if no other indicator owns it. Paused /
    // reconnecting set their own text via dedicated functions and
    // run after the lifecycle 'started' that calls us, so we don't
    // need to coordinate explicitly — they'll overwrite if active.
    if (label.textContent === 'Listening…') {
      label.textContent = 'Live transcription';
    }
  }
}

function handleEvent(event, streamRole = null) {
  // Gate (#2): never mount/repaint the overlay from a transcript
  // event unless a transcription session was started in this tab.
  if (!transcribeSessionActive) return;
  // Mic muted in-meeting → drop the user's own speech (the offscreen
  // already stopped sending frames; this also blocks any trailing
  // final the provider flushes for pre-mute audio).
  if (micSuppressed && _isMicEvent(streamRole)) return;
  ensureOverlay();
  // First provider event of the session clears the "Listening…"
  // indicator. Done here (not in the SW's TRANSCRIBE_FIRST_EVENT
  // path) so the overlay reads its own signal — the SW message is
  // for the popup pill, this is for the in-tab UI.
  setListeningIndicator(false);
  if (event.type === 'partial') {
    if (!event.text) return;
    // Composite key so the mic substream's "Speaker 0" doesn't
    // overwrite the tab substream's "Speaker 0" entry in Mode 3.
    // Preserve the first-seen timestamp across partial revisions so
    // the bracketed time doesn't jump every time the provider revises
    // the same in-flight utterance.
    const _pk = _partialKey(streamRole, event.speaker);
    const isFirstPartialForKey = !partialBySpeaker.has(_pk);
    const _ts = partialBySpeaker.get(_pk)?.ts ?? Date.now();
    partialBySpeaker.set(
      _pk,
      { text: event.text, streamRole, speaker: event.speaker, ts: _ts },
    );
    // D10 — cross-pollinate on the FIRST partial per mic turn too, so
    // the tab substream can bind quickly even if its first event for
    // the same utterance arrives before our mic-substream final does
    // (different providers, different latencies). Subsequent partial
    // revisions for the same key are no-ops to keep the speakerMap
    // timeline from growing once per provider revise (~5/sec).
    if (
      isFirstPartialForKey
      && _isMicEvent(streamRole)
      && speakerMap.selfName
    ) {
      speakerMap.recordObservation(speakerMap.selfName, Date.now());
    }
    // Debounce — see schedulePartialFlush above.
    schedulePartialFlush();
  } else if (event.type === 'final') {
    if (!event.text) return;
    // Transcription recovered — allow a LATER distinct provider
    // error to surface again instead of being de-spammed forever.
    _lastProviderErrorDetail = null;
    // D10 — cross-pollinate the mic substream's "the user spoke" signal
    // into the speakerMap timeline so the TAB substream's
    // ``_resolveParticipant`` can bind its own (independent) numeric
    // speaker for the user to ``selfName``. Without this, the tab
    // substream of mode='both' renders the user as "Speaker A/B"
    // forever (Meet often hides the caption-author badge for the
    // local user, so the DOM scrape produces no observation for them).
    // The record is treated by the resolver as a fresh real-name
    // observation — exactly the evidence path that would have fired
    // had Meet rendered the caption author. Mode 'self' / 'participants'
    // are no-ops here (one substream, no need to cross-pollinate).
    if (_isMicEvent(streamRole) && speakerMap.selfName) {
      speakerMap.recordObservation(speakerMap.selfName, Date.now());
    }
    // Drain any pending partial-render so the visible order on
    // screen matches the wire order (partial → final).
    flushPartialsNow();
    renderFinal(event, streamRole);
  } else if (event.type === 'speaker_change') {
    // Pure label change without text — nothing to render directly;
    // the next partial/final will carry the new speaker number.
  } else if (event.type === 'provider_switch') {
    // Backend failed over to a fallback STT vendor mid-session.
    // Product policy: the user is NOT told which provider runs;
    // we silently re-bind the speaker map so numeric IDs from the
    // new provider don't latch onto the old provider's names, but
    // we don't render a banner in the panel naming either vendor.
    partialBySpeaker.clear();
    speakerMap.clearNumericBindings();
    // Drop the dedup ring too — text from the OLD provider may not
    // overlap with text from the NEW provider's tokenisation; keeping
    // stale entries risks both (a) false-positive dedup against an
    // unrelated future utterance and (b) ring-bloat with two
    // providers' outputs side-by-side.
    micEchoDedup.reset();
    // The new provider/session re-numbers turn_order from scratch, so
    // old turn→row bindings are stale (a fresh turn 1 must NOT
    // overwrite a committed line from the previous provider). Drop the
    // map; the already-rendered rows stay visible, just unmatched.
    finalRowByTurn.clear();
    renderPartials();
  } else if (event.type === 'error') {
    // The relay's _send_error control frame is forwarded verbatim as
    // ``{type:'error', code, message}`` (some providers instead put
    // the detail in ``text``/``extras``). Logging the OBJECT printed
    // "[object Object]" — useless for diagnosis and what the user
    // reported. Build a readable string and de-spam identical
    // consecutive errors (providers can emit the same transient
    // error many times a second).
    const detail = providerErrorDetail(event);
    if (detail !== _lastProviderErrorDetail) {
      _lastProviderErrorDetail = detail;
      // Non-fatal: the SW emits a separate TRANSCRIBE_LIFECYCLE
      // 'stopped' if the session actually ended; partials usually
      // resume after a transient provider hiccup.
      console.warn(`[transcribe-overlay] provider error — ${detail}`);
      flashProviderIssue();
    }
  }
}

// Extract a human-readable detail from a forwarded provider/relay
// error event. Never returns "[object Object]".
function providerErrorDetail(event) {
  try {
    const code = typeof event.code === 'string' ? event.code : '';
    const msg = typeof event.message === 'string' ? event.message
      : (typeof event.text === 'string' ? event.text : '');
    if (code || msg) return `${code || 'error'}${msg ? `: ${msg}` : ''}`;
    if (event.extras) return JSON.stringify(event.extras).slice(0, 200);
    return 'unknown provider error';
  } catch {
    return 'unknown provider error';
  }
}

// One identical error is logged once (reset when a real transcript
// event flows again so a LATER distinct error still surfaces).
let _lastProviderErrorDetail = null;
let _providerIssueTimer = null;

// Briefly tell the user transcription hit a provider hiccup, then
// quietly revert — non-alarming, auto-clearing, and never while the
// panel is showing a paused/reconnecting/stopped state (those own
// the label). Uses the (now-correct) .header-title selector.
function flashProviderIssue() {
  if (!shadowRoot || !transcribeSessionActive) return;
  const label = shadowRoot.querySelector('.header .header-title');
  const panel = shadowRoot.querySelector('.panel');
  if (!label || (panel && panel.classList.contains('stopped'))) return;
  if (/paused|reconnect/i.test(label.textContent || '')) return;
  label.textContent = 'Live transcription · provider issue';
  if (_providerIssueTimer !== null) clearTimeout(_providerIssueTimer);
  _providerIssueTimer = setTimeout(() => {
    _providerIssueTimer = null;
    const l = shadowRoot && shadowRoot.querySelector('.header .header-title');
    if (l && l.textContent === 'Live transcription · provider issue') {
      l.textContent = 'Live transcription';
    }
  }, 4000);
}

function setPausedIndicator(paused) {
  if (!shadowRoot) return;
  const dot = shadowRoot.querySelector('.dot');
  const label = shadowRoot.querySelector('.header .header-title');
  if (!dot || !label) return;
  if (paused) {
    dot.style.animation = 'none';
    dot.style.opacity = '0.35';
    dot.style.background = '#facc15';   // amber while paused
    label.textContent = 'Live transcription · paused';
  } else {
    dot.style.animation = '';
    dot.style.opacity = '';
    dot.style.background = '';
    label.textContent = 'Live transcription';
  }
}

function setReconnectIndicator(reconnecting, { attempt, maxAttempts } = {}) {
  if (!shadowRoot) return;
  const dot = shadowRoot.querySelector('.dot');
  const label = shadowRoot.querySelector('.header .header-title');
  if (!dot || !label) return;
  if (reconnecting) {
    // Distinct from paused (amber, static) — reconnecting is amber +
    // animated so a glance tells the user the panel is actively
    // trying to recover, not parked.
    dot.style.animation = 'mm-pulse 1.4s ease-in-out infinite';
    dot.style.opacity = '';
    dot.style.background = '#f59e0b';   // amber, slightly darker
    const suffix = attempt && maxAttempts ? ` (${attempt}/${maxAttempts})` : '';
    label.textContent = `Live transcription · reconnecting${suffix}`;
  } else {
    dot.style.animation = '';
    dot.style.opacity = '';
    dot.style.background = '';
    label.textContent = 'Live transcription';
  }
}

// Reasons that denote a CLEAN stop (vs a fatal/failed start). Kept
// inline rather than importing lib/error-messages so the content
// script stays a tiny standalone bundle.
const _BENIGN_STOP = new Set([
  'client_stop', 'tab_closed', 'user_stop', 'normal_closure', 'stopped',
]);
function _isBenignStop(reason) {
  if (!reason) return true;
  if (typeof reason !== 'string') return false;
  return _BENIGN_STOP.has(reason.split(/[\s—:]/, 1)[0]);
}

// Phase D — Copy transcript + important points to the clipboard.
// Plain text (textContent only) so nothing executable rides along.
async function copyTranscript(btn) {
  if (!shadowRoot) return;
  const lines = [];
  const fin = shadowRoot.querySelector('.finals');
  if (fin) {
    for (const turn of fin.children) {
      const t = (turn.textContent || '').trim();
      if (t) lines.push(t);
    }
  }
  if (importantPoints.length) {
    lines.push('', 'Important points:');
    for (const p of importantPoints) {
      if (p && typeof p.text === 'string') {
        // Same speaker normalisation as the in-overlay render so the
        // copied text matches what the user saw on screen (no
        // "Shubham" in copy vs "Shubham Pilivkar" in the panel).
        const resolved = resolveImportantPointSpeaker(p.speaker, speakerMap.selfName);
        lines.push(`• [${formatPointType(p.type)}] ${p.text}`
          + (resolved ? ` — ${resolved}` : ''));
      }
    }
  }
  const text = lines.join('\n').trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API can reject if the document isn't focused; fall
    // back to a hidden textarea + execCommand so Copy still works.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch { /* give up silently — nothing else we can do */ }
  }
  if (btn) {
    btn.classList.add('copied');
    btn.textContent = 'Copied';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = 'Copy';
    }, 1500);
  }
}

// Phase D — transition the panel into its STOPPED state instead of
// vanishing: the user keeps the transcript (and Copy) and dismisses
// it explicitly via Close. A fatal/failed start with nothing
// transcribed is the one case we still auto-remove (an empty error
// panel is just noise — Phase B relies on this).
function enterStoppedState(reason) {
  transcribeSessionActive = false;
  // Next session must re-run the one-time resets (Bug 1 guard).
  overlaySessionInitialized = false;
  if (!shadowRoot) return;
  const hasContent = !!(finalsEl && finalsEl.childElementCount > 0);
  if (!hasContent && !_isBenignStop(reason)) {
    removeOverlay();
    return;
  }
  const panel = shadowRoot.querySelector('.panel');
  const dot = shadowRoot.querySelector('.dot');
  const label = shadowRoot.querySelector('.header .header-title');
  const stopBtn = shadowRoot.querySelector('.stop-btn');
  const closeBtn = shadowRoot.querySelector('.close-btn');
  if (panel) panel.classList.add('stopped');
  if (dot) { dot.style.animation = 'none'; }
  if (label) {
    label.textContent = _isBenignStop(reason)
      ? 'Transcription stopped'
      : `Transcription stopped · ${reason}`;
  }
  if (stopBtn) stopBtn.classList.add('hidden');
  if (closeBtn) closeBtn.classList.remove('hidden');
  // Flush any in-flight partial so the final view is stable.
  flushPartialsNow();
}

// A brand-new (non-reconnect) session reusing a panel that's still
// showing the previous session's STOPPED state — restore the live
// chrome (Stop visible, Close hidden) and clear the old transcript.
function resetOverlayForNewSession() {
  // turn_order is session-scoped — drop the turn→row map so the new
  // session's turn 1 can't overwrite a committed line from the prior
  // one. Cleared BEFORE the shadowRoot guard so the map resets even if
  // the panel isn't mounted yet (the map outlives any single DOM tree).
  finalRowByTurn.clear();
  if (!shadowRoot) return;
  const panel = shadowRoot.querySelector('.panel');
  const stopBtn = shadowRoot.querySelector('.stop-btn');
  const closeBtn = shadowRoot.querySelector('.close-btn');
  if (panel) panel.classList.remove('stopped');
  if (stopBtn) stopBtn.classList.remove('hidden');
  if (closeBtn) closeBtn.classList.add('hidden');
  if (finalsEl) finalsEl.replaceChildren();
  if (partialEl) partialEl.replaceChildren();
  partialBySpeaker.clear();
}

// Defensive wrapper: a content-script onMessage handler that throws
// is otherwise SILENT (Chrome logs a generic "Error in event
// handler" and the overlay just never appears — exactly how the
// backtick-in-CSS-template bug stayed invisible for so long). Keep
// the guard so any future overlay error is at least diagnosable.
// Idempotency guard: the SW may PROGRAMMATICALLY (re)inject this
// content script (chrome.scripting.executeScript) into a tab that
// already has it — the fix for "tab predates the extension load, so
// the declared content script never ran". A second injection into a
// still-live isolated world must NOT bind a second onMessage listener
// (that would double-render every event). The marker lives on
// globalThis (shared across injections in the same isolated world);
// it's naturally absent after an extension reload, so a genuine
// re-inject still binds. The first/only listener answers OVERLAY_PING
// so the SW knows the script is present and skips re-injection.
if (!globalThis.__mmTranscribeOverlayBound) {
  globalThis.__mmTranscribeOverlayBound = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      return _onMessage(message, _sender, sendResponse);
    } catch (e) {
      console.error('[meetminutes] transcribe-overlay handler error:',
        e && e.name, e && e.message);
      return false;
    }
  });
}
function _onMessage(message, _sender, sendResponse) {
  if (!message || typeof message.type !== 'string') return false;
  // Liveness probe from the SW — answer so it knows the overlay
  // content script is present (and skips a redundant re-injection).
  if (message.type === MessageType.OVERLAY_PING) {
    sendResponse({ ok: true, overlay: true });
    return false;
  }
  if (message.type === MessageType.TRANSCRIBE_LIFECYCLE) {
    if (message.phase === 'started') {
      // The ONLY place the overlay is allowed to come alive.
      transcribeSessionActive = true;
      // Latch the test seam BEFORE any ensureOverlay() below so the
      // shadow root is created with the right mode on first attach.
      if (message.e2eOpenShadow === true) e2eOpenShadow = true;
      if (message.isReconnect) {
        // Reconnect — re-attach to the same overlay, drop numeric
        // bindings (provider speaker IDs may have re-numbered after
        // the fresh session) and any in-flight partials, but keep
        // mode + selfName + DOM observation timeline.
        speakerMap.clearNumericBindings();
        partialBySpeaker.clear();
        // Same reasoning as provider_switch above — fresh session's
        // tokenisation may differ; preventing stale dedup matches.
        micEchoDedup.reset();
        // Fresh reconnect session re-numbers turn_order — drop the
        // turn→row map so a new turn 1 doesn't overwrite a committed
        // pre-reconnect line.
        finalRowByTurn.clear();
        // Drop any pending debounce timer too — without this, a
        // partial that arrived just before the WS dropped would
        // schedule a flush that fires after the reconnect with an
        // empty map (visually a no-op, but the timer state belongs
        // to the OLD session; clearing it now keeps the debounce
        // window aligned with the fresh stream).
        if (partialFlushTimer !== null) {
          clearTimeout(partialFlushTimer);
          partialFlushTimer = null;
        }
        renderPartials();
        ensureOverlay();
        setReconnectIndicator(false);
        // Phase L1 — fresh WS opens after a reconnect re-enter the
        // cold-start window. The next provider event (handled in
        // handleEvent) clears this.
        setListeningIndicator(true);
      } else {
        // Destructive per-session resets — ONCE per session only
        // (Bug 1: a duplicate non-reconnect ``started`` for the same
        // session must not wipe the transcript that's accumulating).
        if (!overlaySessionInitialized) {
          overlaySessionInitialized = true;
          // Reset mapping state from a previous session — the same
          // overlay survives across consecutive sessions in
          // long-lived meeting tabs, but numeric→name mappings are
          // session-scoped.
          speakerMap.reset();
          // Dedup ring is also session-scoped — wiping ensures a new
          // meeting doesn't inherit yesterday's text fragments.
          micEchoDedup.reset();
          // turn→row map is dropped inside resetOverlayForNewSession()
          // below (called for this destructive branch), keeping the
          // session-scoped clear with the rest of the DOM reset.
          // Fresh session — start the points section empty so a new
          // meeting doesn't inherit the prior one's.
          importantPoints = [];
          speakerMap.setMode(message.mode || null);
          if (
            message.mode === TranscribeMode.SELF
            || message.mode === TranscribeMode.BOTH
          ) {
            // Mode 3 needs the self name too — the mic substream's
            // events resolve to ``selfName``. Fire-and-forget.
            void loadSelfNameFromStorage();
          }
          ensureOverlay();
          // If the panel survived a previous session in its STOPPED
          // state (user hadn't clicked Close), restore the live
          // chrome and clear the OLD transcript before the new one.
          resetOverlayForNewSession();
        } else {
          // Duplicate/late ``started`` for the SAME session — just
          // make sure the panel exists; do NOT clear the transcript.
          ensureOverlay();
        }
        setPausedIndicator(false);
        // Phase L1 — fresh session starts in the cold-start window.
        setListeningIndicator(true);
      }
    } else if (message.phase === 'paused') {
      if (!transcribeSessionActive) { sendResponse({ ok: true }); return false; }
      ensureOverlay();
      setPausedIndicator(true);
    } else if (message.phase === 'resumed') {
      // Gate like 'paused'/'reconnecting': a stray/late 'resumed'
      // after the session stopped must not un-grey the stopped dot.
      if (!transcribeSessionActive) { sendResponse({ ok: true }); return false; }
      setPausedIndicator(false);
    } else if (message.phase === 'reconnecting') {
      // Network drop — flip the indicator to amber but keep the panel
      // and all rendered finals. The user sees "Reconnecting (N/M)…"
      // until the next 'started' (isReconnect=true) or 'stopped'.
      if (!transcribeSessionActive) { sendResponse({ ok: true }); return false; }
      ensureOverlay();
      setReconnectIndicator(true, {
        attempt: message.attempt,
        maxAttempts: message.maxAttempts,
      });
    } else if (message.phase === 'stopped') {
      // Phase D — do NOT vanish. Switch to the stopped state so the
      // user can still read/copy the transcript and dismiss it via
      // Close. enterStoppedState() still auto-removes the one noisy
      // case: a failed start with nothing transcribed.
      enterStoppedState(message.reason);
      speakerMap.reset();
      micEchoDedup.reset();
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === MessageType.TRANSCRIPT_EVENT) {
    // ``streamRole`` ride-along (Mode 3) tells the handler whether
    // to label this event "You" (mic substream) or to resolve via
    // the participant name map (tab substream). Single-mode and
    // legacy offscreen builds pass null/undefined → existing
    // behaviour preserved.
    if (message.event) handleEvent(message.event, message.streamRole ?? null);
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === MessageType.IMPORTANT_POINTS_UPDATE) {
    // SW forwards the cumulative, de-duped points list (same data the
    // popup shows). Replace wholesale + repaint the lower section.
    // Gated on an active session (#2) so a stray/stale points batch
    // can't mount the panel during a recording-only session.
    if (transcribeSessionActive && Array.isArray(message.points)) {
      importantPoints = message.points;
      ensureOverlay();
      renderImportantPoints();
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === MessageType.SPEAKER_CHANGE) {
    // meet.js / teams.js detected an active-speaker change on the
    // meeting tiles. Record into the timeline so the next
    // ``speakerMap.resolve`` call can bind a numeric→name entry.
    if (typeof message.speaker_name === 'string' && message.speaker_name) {
      speakerMap.recordObservation(message.speaker_name, message.wall_clock_ms);
      // Retroactive relabel — walk back over recently-rendered rows
      // whose speaker chip is still a generic "Speaker A/B" letter
      // and patch them in place if the freshness-window resolver
      // would now produce a real name. Mode-2-critical: without
      // this, the first 1-2 finals that landed before the caption
      // observer fired stay as "Speaker A/B" for the whole session
      // even after captions catch up. Mode 3 benefits too (the tab
      // substream has the same cold-start race).
      _relabelPendingFinals();
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === MessageType.MIC_MUTE_STATE) {
    // User toggled their in-meeting mic. On mute: suppress further
    // mic-origin lines AND drop the user's currently-rendered mic
    // partial so a half-spoken sentence doesn't linger. On unmute:
    // resume (offscreen restarts the frame pump).
    micSuppressed = !!message.muted;
    if (micSuppressed) {
      let changed = false;
      for (const [k, entry] of partialBySpeaker) {
        if (entry && _isMicEvent(entry.streamRole)) {
          partialBySpeaker.delete(k);
          changed = true;
        }
      }
      if (changed) renderPartials();
    }
    sendResponse({ ok: true });
    return false;
  }
  return false;
}
