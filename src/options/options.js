import {
  AUDIO_BITRATE_PRESETS,
  DEFAULT_API_BASE_URL,
  DEFAULT_AUDIO_BITRATE,
  DEFAULT_MIC_GAIN,
  DEFAULT_TAB_GAIN,
  DEFAULT_VIDEO_BITRATE,
  MessageType,
  StorageKey,
  VIDEO_BITRATE_PRESETS,
} from '../constants.js';
import { logout as apiLogout } from '../api/client.js';

const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

// ``api-base`` was removed from the visible Options form. We keep
// reads/writes of the storage key so any value already set by a
// developer via DevTools is preserved; new installs just default to
// DEFAULT_API_BASE_URL via api/client.js' resolveBaseUrl.
const apiBase = $('api-base');
const accountState = document.getElementById('account-state');
const signoutBtn = /** @type {HTMLButtonElement} */ (document.getElementById('signout-btn'));
const micGain = $('mic-gain');
const tabGain = $('tab-gain');
const videoBitrate = /** @type {HTMLSelectElement} */ (document.getElementById('video-bitrate'));
const audioBitrate = /** @type {HTMLSelectElement} */ (document.getElementById('audio-bitrate'));
const audioOnly = /** @type {HTMLInputElement} */ (document.getElementById('audio-only'));
const captureSource = /** @type {HTMLSelectElement} */ (document.getElementById('capture-source'));
const micDevice = /** @type {HTMLSelectElement} */ (document.getElementById('mic-device'));
const refreshDevicesBtn = /** @type {HTMLButtonElement} */ (document.getElementById('refresh-devices'));
const micGainValue = document.getElementById('mic-gain-value');
const tabGainValue = document.getElementById('tab-gain-value');
const saveBtn = document.getElementById('save-btn');
const status = document.getElementById('status');

function fmtGain(v) {
  return Number(v).toFixed(2);
}

async function load() {
  const got = await chrome.storage.local.get([
    StorageKey.AUTH_TOKEN,
    StorageKey.USER_EMAIL,
    StorageKey.API_BASE_URL,
    StorageKey.MIC_GAIN,
    StorageKey.TAB_GAIN,
    StorageKey.VIDEO_BITRATE,
    StorageKey.AUDIO_BITRATE,
    StorageKey.AUDIO_ONLY,
    StorageKey.CAPTURE_SOURCE,
    StorageKey.MIC_DEVICE_ID,
  ]);
  if (apiBase) apiBase.value = got[StorageKey.API_BASE_URL] ?? DEFAULT_API_BASE_URL;
  renderAccount(got[StorageKey.AUTH_TOKEN], got[StorageKey.USER_EMAIL]);
  micGain.value = String(got[StorageKey.MIC_GAIN] ?? DEFAULT_MIC_GAIN);
  tabGain.value = String(got[StorageKey.TAB_GAIN] ?? DEFAULT_TAB_GAIN);
  videoBitrate.value = String(got[StorageKey.VIDEO_BITRATE] ?? DEFAULT_VIDEO_BITRATE);
  // Phase 4 raised the audio presets from [64, 96, 128] → [96, 128,
  // 192] kbps. Users whose stored value is no longer in the preset
  // set (notably 64 kbps from a pre-Phase-4 install) would otherwise
  // silently land on the dropdown's first option (96), which lies
  // about what the recorder is actually using. Surface the new
  // default explicitly so what the user SEES matches what we'll
  // record when they next click Save.
  const storedAudio = got[StorageKey.AUDIO_BITRATE];
  audioBitrate.value = String(
    AUDIO_BITRATE_PRESETS.includes(storedAudio)
      ? storedAudio
      : DEFAULT_AUDIO_BITRATE,
  );
  audioOnly.checked = !!got[StorageKey.AUDIO_ONLY];
  captureSource.value = got[StorageKey.CAPTURE_SOURCE] === 'screen'
    ? 'screen'
    : 'tab';
  micGainValue.textContent = fmtGain(micGain.value);
  tabGainValue.textContent = fmtGain(tabGain.value);
  await populateMicDevices(got[StorageKey.MIC_DEVICE_ID] ?? '');
}

/**
 * Populate the mic <select> with available audio inputs. Until the user
 * grants mic permission once, device labels come back blank — only the
 * deviceId is visible. We trigger a getUserMedia() probe when the user
 * clicks "Refresh devices" so the labels populate after consent.
 *
 * @param {string} selectedId
 */
async function populateMicDevices(selectedId) {
  // Reset to just the default option.
  while (micDevice.options.length > 1) micDevice.remove(1);
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    for (const d of inputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone (${d.deviceId.slice(0, 8)}…)`;
      micDevice.appendChild(opt);
    }
    micDevice.value = selectedId;
  } catch (err) {
    console.warn('[options] enumerateDevices failed', err);
  }
}

refreshDevicesBtn.addEventListener('click', async () => {
  // Probe getUserMedia briefly so the browser unlocks device labels.
  // Stop the stream immediately — we don't want to hold the mic open.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    status.classList.add('error');
    status.textContent = 'Could not access microphone — labels may stay hidden.';
    setTimeout(() => { status.textContent = ''; status.classList.remove('error'); }, 3000);
  }
  await populateMicDevices(micDevice.value);
});

micGain.addEventListener('input', () => {
  micGainValue.textContent = fmtGain(micGain.value);
});
tabGain.addEventListener('input', () => {
  tabGainValue.textContent = fmtGain(tabGain.value);
});

function renderAccount(token, email) {
  if (token) {
    accountState.textContent = email ? `Signed in as ${email}` : 'Signed in';
    accountState.classList.remove('signed-out');
    accountState.classList.add('signed-in');
    signoutBtn.classList.remove('hidden');
    signoutBtn.disabled = false;
  } else {
    accountState.textContent = 'Signed out — open the popup to sign in';
    accountState.classList.add('signed-out');
    accountState.classList.remove('signed-in');
    signoutBtn.classList.add('hidden');
  }
}

// Token / email can change behind our back (popup signs in, SW clears
// on 401). Keep the account row in sync without forcing a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (StorageKey.AUTH_TOKEN in changes || StorageKey.USER_EMAIL in changes) {
    chrome.storage.local
      .get([StorageKey.AUTH_TOKEN, StorageKey.USER_EMAIL])
      .then((g) => renderAccount(g[StorageKey.AUTH_TOKEN], g[StorageKey.USER_EMAIL]));
  }
});

signoutBtn.addEventListener('click', async () => {
  signoutBtn.disabled = true;
  signoutBtn.textContent = 'Signing out…';
  try {
    // Stop any active recording first — uploads will start 401'ing
    // the moment the token is revoked. The SW handles
    // stop-while-idle gracefully (no-op), so this is safe to always
    // send. Matches the popup's sign-out flow.
    try {
      await chrome.runtime.sendMessage({ type: MessageType.STOP_RECORDING });
    } catch {
      // SW may not respond if it's asleep — that's fine, no recording
      // is active. apiLogout below clears local state either way.
    }
    await apiLogout();
    // storage.onChanged re-renders the account row, but call directly
    // for instant feedback even if the listener is slow.
    renderAccount(null, null);
    status.classList.remove('error');
    status.textContent = 'Signed out.';
    setTimeout(() => { status.textContent = ''; }, 2000);
  } finally {
    signoutBtn.textContent = 'Sign out';
    signoutBtn.disabled = false;
  }
});

saveBtn.addEventListener('click', async () => {
  // Backend URL is no longer user-editable from the visible form. If a
  // DevTools-edited value is present on the input element, honor it;
  // otherwise leave the storage key alone so resolveBaseUrl falls back
  // to DEFAULT_API_BASE_URL.
  const url = apiBase ? apiBase.value.trim().replace(/\/$/, '') : '';
  const mic = Number(micGain.value);
  const tab = Number(tabGain.value);
  const videoBps = Number(videoBitrate.value);
  const audioBps = Number(audioBitrate.value);

  if (url && !/^https:\/\//.test(url)) {
    // HTTPS-only — matches the manifest CSP (connect-src 'self' https:)
    // and avoids leaking auth tokens over plaintext.
    status.textContent = 'Backend URL must start with https://';
    status.classList.add('error');
    return;
  }
  if (Number.isNaN(mic) || Number.isNaN(tab)) {
    status.textContent = 'Gain values must be numbers';
    status.classList.add('error');
    return;
  }
  if (!VIDEO_BITRATE_PRESETS.includes(videoBps) || !AUDIO_BITRATE_PRESETS.includes(audioBps)) {
    // Defensive: <select> values come from the same constants, so this
    // only trips if the HTML has been tampered with.
    status.textContent = 'Bitrate values are out of allowed range';
    status.classList.add('error');
    return;
  }

  await chrome.storage.local.set({
    ...(url ? { [StorageKey.API_BASE_URL]: url } : {}),
    [StorageKey.MIC_GAIN]: mic,
    [StorageKey.TAB_GAIN]: tab,
    [StorageKey.VIDEO_BITRATE]: videoBps,
    [StorageKey.AUDIO_BITRATE]: audioBps,
    [StorageKey.AUDIO_ONLY]: audioOnly.checked,
    [StorageKey.CAPTURE_SOURCE]:
      captureSource.value === 'screen' ? 'screen' : 'tab',
    [StorageKey.MIC_DEVICE_ID]: micDevice.value,
  });
  status.classList.remove('error');
  status.textContent = 'Saved.';
  setTimeout(() => {
    status.textContent = '';
  }, 2000);
});

load();

// ---------------------------------------------------------------- bridge
//
// Optional pairing with MeetMinutes Desktop. The desktop app exposes
// a localhost WebSocket bridge that this extension can forward
// SPEAKER_CHANGE events to so the desktop transcript can label
// speakers by real name instead of "Speaker A/B/C". Off by default;
// the SW only attempts a connection after the user enables the
// toggle and pastes a token here.

const bridgeEnabledEl = /** @type {HTMLInputElement} */ (document.getElementById('bridge-enabled'));
const bridgeTokenEl = /** @type {HTMLInputElement} */ (document.getElementById('bridge-token'));
const bridgeTestBtn = /** @type {HTMLButtonElement} */ (document.getElementById('bridge-test-btn'));
const bridgeSaveBtn = /** @type {HTMLButtonElement} */ (document.getElementById('bridge-save-btn'));
const bridgeStatusPill = document.getElementById('bridge-status');
const bridgeStatusLine = document.getElementById('bridge-status-line');
const bridgeErrorLine = document.getElementById('bridge-error');

function setBridgePill(statusText, klass) {
  bridgeStatusPill.textContent = statusText;
  bridgeStatusPill.className = `pill ${klass || ''}`.trim();
}

function setBridgeError(text) {
  if (!text) {
    bridgeErrorLine.style.display = 'none';
    bridgeErrorLine.textContent = '';
    return;
  }
  bridgeErrorLine.style.display = 'block';
  bridgeErrorLine.textContent = text;
}

async function loadBridge() {
  const got = await chrome.storage.local.get([
    StorageKey.BRIDGE_ENABLED,
    StorageKey.BRIDGE_TOKEN,
  ]);
  bridgeEnabledEl.checked = !!got[StorageKey.BRIDGE_ENABLED];
  bridgeTokenEl.value = got[StorageKey.BRIDGE_TOKEN] || '';
  await refreshBridgeStatus();
}

async function refreshBridgeStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MessageType.GET_BRIDGE_STATUS,
    });
    if (!response || !response.ok || !response.data) {
      setBridgePill('off');
      return;
    }
    const { enabled, paired, port, status, lastError } = response.data;
    if (!enabled) {
      setBridgePill('off');
      setBridgeError('');
      return;
    }
    if (paired) {
      setBridgePill(`paired · :${port ?? '?'}`, 'paired');
      setBridgeError('');
    } else if (status === 'connecting') {
      setBridgePill('connecting…', 'connecting');
      setBridgeError('');
    } else {
      setBridgePill('not connected', 'failed');
      // Surface the last failure so users see "desktop not running" vs
      // "invalid token" vs "ports busy".
      setBridgeError(lastError || 'no connection');
    }
  } catch {
    setBridgePill('unknown');
  }
}

// Loopback hosts (127.0.0.1 + localhost) are declared in
// ``host_permissions`` (granted at install), so the bridge can dial
// localhost without a runtime permission request. (They were briefly
// moved to optional_host_permissions for a CWS-prep pass, which broke
// the desktop bridge — reverted.)

bridgeSaveBtn.addEventListener('click', async () => {
  const enabled = bridgeEnabledEl.checked;
  const token = bridgeTokenEl.value.trim();
  if (enabled && !token) {
    bridgeStatusLine.textContent = 'Paste the bridge token from the desktop Settings dialog first.';
    bridgeStatusLine.classList.add('error');
    return;
  }
  await chrome.storage.local.set({
    [StorageKey.BRIDGE_ENABLED]: enabled,
    [StorageKey.BRIDGE_TOKEN]: token,
  });
  // Ask the SW to reload its config + (re)connect. The SW also reads
  // chrome.storage on its own cold boot, so this message is a fast
  // path — refresh happens within a couple hundred ms either way.
  await chrome.runtime.sendMessage({ type: MessageType.BRIDGE_CONFIG_CHANGED });
  bridgeStatusLine.classList.remove('error');
  bridgeStatusLine.textContent = 'Pairing saved.';
  setTimeout(() => { bridgeStatusLine.textContent = ''; }, 2000);
  await refreshBridgeStatus();
});

bridgeTestBtn.addEventListener('click', async () => {
  // Apply current form values + force a reconnect. Lets the user
  // try a token without first hitting Save.
  await chrome.storage.local.set({
    [StorageKey.BRIDGE_ENABLED]: bridgeEnabledEl.checked,
    [StorageKey.BRIDGE_TOKEN]: bridgeTokenEl.value.trim(),
  });
  await chrome.runtime.sendMessage({ type: MessageType.BRIDGE_CONFIG_CHANGED });
  // Poll status a few times — the SW typically settles within ~3s
  // (worst case: it tries all 9 ports before failing).
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 800));
    await refreshBridgeStatus();
  }
});

loadBridge();

// --------------------------------------------------------- privacy / advanced
//
// Phase U1 — surface the three feature flags that were previously
// only reachable via DevTools storage editing:
//
//   * Client-side encryption (Phase F v1)
//   * WebCodecs recorder (Phase E v1)

const e2eeEnabledEl = /** @type {HTMLInputElement} */ (document.getElementById('e2ee-enabled'));
const webcodecsRecorderEnabledEl = /** @type {HTMLInputElement} */ (
  document.getElementById('webcodecs-recorder-enabled')
);
const privacySaveBtn = /** @type {HTMLButtonElement} */ (document.getElementById('privacy-save-btn'));
const privacyStatus = document.getElementById('privacy-status');

async function loadPrivacy() {
  const got = await chrome.storage.local.get([
    StorageKey.E2EE_ENABLED,
    StorageKey.WEBCODECS_RECORDER_ENABLED,
  ]);
  e2eeEnabledEl.checked = !!got[StorageKey.E2EE_ENABLED];
  webcodecsRecorderEnabledEl.checked = !!got[StorageKey.WEBCODECS_RECORDER_ENABLED];
}

privacySaveBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({
    [StorageKey.E2EE_ENABLED]: !!e2eeEnabledEl.checked,
    [StorageKey.WEBCODECS_RECORDER_ENABLED]: !!webcodecsRecorderEnabledEl.checked,
  });
  privacyStatus.classList.remove('error');
  privacyStatus.textContent = 'Saved.';
  setTimeout(() => { privacyStatus.textContent = ''; }, 2000);
});

loadPrivacy();
