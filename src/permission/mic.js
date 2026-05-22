// Top-level extension page (opened in its own window by the service
// worker via ensureMicPermission). The user clicks "Allow microphone"
// — that gesture lets getUserMedia() show Chrome's permission prompt.
// Granting it PERSISTS mic access for the extension origin, so the
// offscreen document's getUserMedia({audio:true}) then works (it
// can't prompt itself; nor can the popup or a meeting-page iframe —
// the latter is blocked by Meet/Teams' Permissions-Policy).
//
// We persist a sticky ``mm_mic_granted`` flag (so the SW only opens
// this page when needed), tell the SW the result, then auto-close.

import { StorageKey } from '../constants.js';

const btn = document.getElementById('allow');
const statusEl = document.getElementById('status');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls || ''}`;
}

async function report(granted, errName) {
  try {
    await chrome.storage.local.set({ [StorageKey.MIC_GRANTED]: granted });
  } catch { /* best-effort */ }
  try {
    chrome.runtime.sendMessage({
      type: 'MIC_PERMISSION_RESULT', granted, error: errName || null,
    });
  } catch { /* SW may be asleep — the storage flag is the source of truth */ }
}

async function requestMic() {
  btn.disabled = true;
  setStatus('Waiting for your permission…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    await report(true);
    setStatus('Microphone enabled. You can close this window.', 'ok');
    setTimeout(() => { try { window.close(); } catch { /* noop */ } }, 1200);
  } catch (err) {
    const name = err && err.name ? err.name : String(err);
    await report(false, name);
    setStatus(
      `Microphone blocked (${name}). Click to try again, or allow it `
      + 'in the address-bar site settings.',
      'err',
    );
    btn.disabled = false;
  }
}

btn.addEventListener('click', requestMic);
