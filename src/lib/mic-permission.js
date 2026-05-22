// Service-worker helper: make sure the extension origin has been
// granted microphone access BEFORE we spin up the offscreen recorder.
//
// Why this exists: getUserMedia() cannot prompt from an offscreen
// document, the popup, or a cross-origin iframe injected into the
// meeting tab (Meet/Teams Permissions-Policy blocks the iframe). The
// only reliable MV3 path is a TOP-LEVEL extension page that the user
// interacts with. So, when not already granted, we open
// src/permission/mic.html in its own small window; the user clicks
// "Allow", Chrome persists the grant for the extension origin, and
// the offscreen doc's getUserMedia({audio:true}) then succeeds.
//
// Sticky `mm_mic_granted` keeps this a ONE-TIME prompt: skipped once
// granted, re-armed if the offscreen later finds the mic denied
// (user revoked). Always best-effort — never blocks recording; the
// offscreen path still falls back to tab-audio-only on denial.

import { StorageKey } from '../constants.js';

let _inFlight = null;

async function _readGranted() {
  try {
    const got = await chrome.storage.local.get(StorageKey.MIC_GRANTED);
    return !!got[StorageKey.MIC_GRANTED];
  } catch {
    return false;
  }
}

/**
 * Resolve true once mic access is (or becomes) granted for the
 * extension origin. Opens the one-time permission window if needed.
 * Never rejects. `timeoutMs` caps how long we wait for the user.
 *
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export function ensureMicPermission({ timeoutMs = 90_000 } = {}) {
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      if (await _readGranted()) return true;
      if (!chrome.windows || !chrome.windows.create) return false;

      return await new Promise((resolve) => {
        let settled = false;
        const finish = (granted) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { chrome.runtime.onMessage.removeListener(onMsg); } catch { /* noop */ }
          try { chrome.storage.onChanged.removeListener(onStore); } catch { /* noop */ }
          resolve(granted);
        };

        // The page reports back two ways (runtime message + the
        // sticky storage flag); whichever lands first wins. Storage
        // is the durable fallback if the SW was asleep for the msg.
        const onMsg = (m) => {
          if (m && m.type === 'MIC_PERMISSION_RESULT') finish(!!m.granted);
        };
        const onStore = (changes, area) => {
          if (area === 'local' && changes[StorageKey.MIC_GRANTED]
              && changes[StorageKey.MIC_GRANTED].newValue === true) {
            finish(true);
          }
        };
        try { chrome.runtime.onMessage.addListener(onMsg); } catch { /* noop */ }
        try { chrome.storage.onChanged.addListener(onStore); } catch { /* noop */ }

        const timer = setTimeout(() => finish(false), timeoutMs);

        chrome.windows.create({
          url: chrome.runtime.getURL('src/permission/mic.html'),
          type: 'popup',
          focused: true,
          width: 460,
          height: 320,
        }).catch(() => finish(false));
      });
    } catch {
      return false;
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}
