// Subscription-aware feature gate.
//
// Reads the ``external_platform`` sub-object of the backend's
// ``/subscription/get-features-info`` response (cached at
// ``StorageKey.FEATURES_INFO``) and exposes a small, reusable API
// for the popup / options / overlay surfaces to decide:
//
//   * Is feature X enabled? → ``isFeatureEnabled(FeatureKey.X)``
//   * Render gating decisions for many keys at once →
//     ``loadGate({ subscribe? })`` returns ``{ enabled(key), all() }``.
//
// Design goals (from the feature spec):
//
//   * **One source of truth**: the backend response, mirrored to
//     chrome.storage by ``refreshFeaturesInfo`` in api/client.js.
//   * **Reusable**: NO hardcoded UI logic per feature. The popup
//     iterates a registry of gated controls and the gate applies
//     the same enable/disable logic to each.
//   * **Future-proof**: new feature flags require ONLY a new entry in
//     ``FeatureKey`` + a new registry row in popup.js — no changes to
//     this module.
//   * **Default-allow on missing data**: if the snapshot is absent
//     (fresh install / API failure / signed out), gates default to
//     ALLOWED so a transient network blip doesn't block users.
//
// Wire-format contract (Backend → extension):
//
//   {
//     "external_platform": {
//       "recording_enabled": true,
//       "live_transcription_enabled": true,
//       "bot_enabled": false,
//       <future_feature>_enabled: <boolean>,
//       ...
//     },
//     ... (other top-level keys ignored by this module)
//   }

import {
  PRICING_PAGE_URL,
  StorageKey,
  SUPPORT_PAGE_URL,
} from '../constants.js';

/**
 * Canonical feature keys mapped to their wire-format ``*_enabled``
 * names. Add a new entry here when the backend ships a new
 * ``external_platform.<key>_enabled`` flag; the popup wires it via
 * the existing gate machinery without any per-feature branching.
 *
 * The values are the WIRE keys (snake_case) so a typo at a call
 * site fails fast against a static enum check instead of silently
 * defaulting to allowed.
 */
export const FeatureKey = Object.freeze({
  RECORDING: 'recording_enabled',
  LIVE_TRANSCRIPTION: 'live_transcription_enabled',
  BOT: 'bot_enabled',
});

// Friendly labels for the upgrade modal title bar. Keyed by the
// same wire keys so callers can resolve "feature key → user-facing
// name" without a separate switch.
export const FEATURE_LABEL = Object.freeze({
  [FeatureKey.RECORDING]: 'Recording',
  [FeatureKey.LIVE_TRANSCRIPTION]: 'Live transcription',
  [FeatureKey.BOT]: 'Add bot to meeting',
});

/**
 * Read the cached external_platform snapshot from storage.
 *
 * @returns {Promise<Record<string, unknown>>}
 *   The ``external_platform`` sub-object verbatim, or an empty
 *   object when the snapshot is absent / malformed. Caller code
 *   must default-allow on missing keys (see ``isFeatureEnabledIn``).
 */
export async function loadFeatureSnapshot() {
  try {
    const got = await chrome.storage.local.get(StorageKey.FEATURES_INFO);
    const info = got[StorageKey.FEATURES_INFO];
    if (!info || typeof info !== 'object') return {};
    const ext = info.external_platform;
    if (!ext || typeof ext !== 'object') return {};
    return ext;
  } catch {
    return {};
  }
}

/**
 * Synchronous, pure decision: is the named feature enabled in this
 * snapshot? **Default-allow when the key is missing** so a fresh
 * install (no snapshot yet) doesn't block users; a transient API
 * failure has the same fallback.
 *
 * Only an explicit ``false`` from the backend disables the feature.
 *
 * @param {Record<string, unknown>} snapshot
 * @param {string} featureKey  one of ``FeatureKey.*``
 */
export function isFeatureEnabledIn(snapshot, featureKey) {
  if (!snapshot || typeof snapshot !== 'object') return true;
  const v = snapshot[featureKey];
  if (v === false) return false;
  return true;
}

/**
 * Async convenience for a one-shot check. The popup uses
 * ``loadGate()`` instead so it can read multiple keys against one
 * snapshot and subscribe to live updates without re-reading storage
 * per key.
 */
export async function isFeatureEnabled(featureKey) {
  const snap = await loadFeatureSnapshot();
  return isFeatureEnabledIn(snap, featureKey);
}

/**
 * Load the snapshot and return a small gate object the caller can
 * use for multiple decisions without re-reading storage. Optionally
 * subscribe to ``chrome.storage.onChanged`` for ``FEATURES_INFO``
 * so the gate self-refreshes when the SW refreshes the snapshot
 * (alarm tick, post-login, etc.) and re-invokes the caller's
 * ``onChange`` handler.
 *
 * @param {{ onChange?: (gate: FeatureGate) => void }} [opts]
 * @returns {Promise<FeatureGate>}
 */
export async function loadGate(opts = {}) {
  let snapshot = await loadFeatureSnapshot();
  const gate = {
    /** @param {string} key */
    enabled: (key) => isFeatureEnabledIn(snapshot, key),
    all: () => ({ ...snapshot }),
    /** Force re-read from storage. Returns the new snapshot. */
    refresh: async () => {
      snapshot = await loadFeatureSnapshot();
      return snapshot;
    },
    /** Detach the storage listener installed by ``onChange``. */
    dispose: () => {},
  };
  if (typeof opts.onChange === 'function') {
    const handler = (changes, area) => {
      if (area !== 'local') return;
      if (!(StorageKey.FEATURES_INFO in changes)) return;
      // Re-read so the gate's view is consistent with what the
      // ``onChange`` handler observes immediately after.
      gate.refresh().then(() => opts.onChange(gate)).catch(() => {});
    };
    try {
      chrome.storage?.onChanged?.addListener(handler);
      gate.dispose = () => {
        try { chrome.storage?.onChanged?.removeListener(handler); }
        catch { /* idempotent */ }
      };
    } catch { /* storage unavailable */ }
  }
  return gate;
}

/**
 * Open a URL in a new browser tab. Tries chrome.tabs.create first
 * (the extension-owned path, opens a real new tab even when the
 * popup closes mid-click), then falls back to window.open for
 * non-extension contexts (e.g. tests). Wrapped in try/catch so a
 * denied permission or missing API doesn't bubble back to the
 * caller — the upgrade-modal flow stays alive either way.
 *
 * @param {string} url
 */
function _openExternal(url) {
  try {
    if (chrome?.tabs?.create) {
      chrome.tabs.create({ url });
    } else if (typeof window !== 'undefined' && window.open) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  } catch { /* best-effort */ }
}

/**
 * Open the pricing page in a new tab. Centralised here so the
 * upgrade CTA in every surface (popup modal, future settings link,
 * onboarding banner) goes to the same URL and can be re-targeted
 * by a single constant change.
 */
export function openPricingPage() {
  _openExternal(PRICING_PAGE_URL);
}

/**
 * Open the support page in a new tab. Symmetric with
 * openPricingPage so the upgrade modal's two CTAs ("Upgrade Plan"
 * and "Contact Support") both go through a one-line helper that
 * the rest of the extension can reuse from any surface.
 */
export function openSupportPage() {
  _openExternal(SUPPORT_PAGE_URL);
}

/**
 * @typedef {Object} FeatureGate
 * @property {(key: string) => boolean} enabled
 * @property {() => Record<string, unknown>} all
 * @property {() => Promise<Record<string, unknown>>} refresh
 * @property {() => void} dispose
 */
