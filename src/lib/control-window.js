// Service-worker helper that owns the lifecycle of the detached
// recording-control window — the small always-visible popup
// (chrome.windows type 'popup') that carries the mic+system level
// meters, pause-aware duration, and the pause/resume + stop controls
// while a recording runs.
//
// Why a separate window: the toolbar action popup is ephemeral (it
// closes the moment the user clicks anywhere else) and, per the
// product flow, the Record tab must reset to idle so a fresh
// recording can be set up. The live session therefore needs its own
// persistent surface. One window at a time (single-session product
// contract); the id is tracked in storage so the SW survives a
// restart and focuses the existing window instead of spawning
// duplicates.
//
// Best-effort throughout: a windowing failure must never break the
// recording itself (the offscreen MediaRecorder is independent).

import { StorageKey } from '../constants.js';

const CONTROL_URL = 'src/control/control.html';
// Short, wide pill (mirrors the in-page recording banner). Height
// covers the minimal popup-window chrome + the ~60px pill.
const WIN = Object.freeze({ width: 470, height: 96 });

async function readId() {
  try {
    const got = await chrome.storage.local.get(StorageKey.CONTROL_WINDOW_ID);
    const id = got[StorageKey.CONTROL_WINDOW_ID];
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

async function writeId(id) {
  try {
    if (id == null) {
      await chrome.storage.local.remove(StorageKey.CONTROL_WINDOW_ID);
    } else {
      await chrome.storage.local.set({ [StorageKey.CONTROL_WINDOW_ID]: id });
    }
  } catch { /* best-effort */ }
}

// Resolve true only if the tracked window still exists. chrome.windows
// .get rejects for an unknown id, which is our "it was closed" signal.
async function liveWindowId() {
  const id = await readId();
  if (id == null) return null;
  try {
    const w = await chrome.windows.get(id);
    return w && typeof w.id === 'number' ? w.id : null;
  } catch {
    await writeId(null);
    return null;
  }
}

/**
 * Ensure the control window is open and focused. Creates it if absent,
 * focuses the existing one otherwise (never duplicates). Never throws.
 */
export async function openControlWindow() {
  try {
    if (!chrome.windows || !chrome.windows.create) return;
    const existing = await liveWindowId();
    if (existing != null) {
      try { await chrome.windows.update(existing, { focused: true }); } catch { /* noop */ }
      return;
    }
    const w = await chrome.windows.create({
      url: chrome.runtime.getURL(CONTROL_URL),
      type: 'popup',
      focused: true,
      width: WIN.width,
      height: WIN.height,
    });
    if (w && typeof w.id === 'number') await writeId(w.id);
  } catch { /* best-effort — recording proceeds regardless */ }
}

/**
 * Close the control window if open and forget its id. Idempotent —
 * safe to call on every stop / IDLE transition. Never throws.
 */
export async function closeControlWindow() {
  try {
    const id = await liveWindowId();
    if (id != null) {
      try { await chrome.windows.remove(id); } catch { /* already gone */ }
    }
  } catch { /* noop */ } finally {
    await writeId(null);
  }
}

/**
 * SW ``chrome.windows.onRemoved`` hook — clears tracking when the user
 * closes the window manually so a later focus request re-creates it
 * instead of trying to focus a dead id.
 */
export async function handleWindowRemoved(windowId) {
  try {
    const id = await readId();
    if (id != null && id === windowId) await writeId(null);
  } catch { /* noop */ }
}
