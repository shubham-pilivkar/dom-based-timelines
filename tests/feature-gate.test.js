// Tests for src/lib/feature-gate.js — the reusable subscription
// feature-gate module that the popup uses to decide whether each
// gated control (Recording / Live transcription / Add bot) is
// enabled or should open the upgrade modal instead.
//
// Coverage:
//   * FeatureKey enum points at the wire-format snake_case names
//   * isFeatureEnabledIn — default-allow when missing, only explicit
//     false disables (per the spec — transient API blips shouldn't
//     block users)
//   * loadFeatureSnapshot reads StorageKey.FEATURES_INFO and pulls
//     the external_platform sub-object verbatim
//   * loadGate returns a working { enabled, all, refresh, dispose }
//     and the onChange subscription fires on storage.FEATURES_INFO
//     changes
//   * openPricingPage opens PRICING_PAGE_URL via chrome.tabs.create

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import {
  PRICING_PAGE_URL,
  StorageKey,
  SUPPORT_PAGE_URL,
} from '../src/constants.js';
import {
  FEATURE_LABEL,
  FeatureKey,
  isFeatureEnabled,
  isFeatureEnabledIn,
  loadFeatureSnapshot,
  loadGate,
  openPricingPage,
  openSupportPage,
} from '../src/lib/feature-gate.js';

function setSnapshot(snapshot) {
  vi.mocked(chrome.storage.local.get).mockImplementation(async (keys) => {
    const want = (key) => Array.isArray(keys)
      ? keys.includes(key)
      : keys === key || (keys && typeof keys === 'object' && key in keys);
    if (want(StorageKey.FEATURES_INFO)) {
      return { [StorageKey.FEATURES_INFO]: snapshot };
    }
    return {};
  });
}

beforeEach(() => {
  vi.mocked(chrome.storage.local.get).mockReset();
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({}));
  // Re-add onChanged on every test — loadGate installs a listener
  // and we want to spy on adds/removes.
  chrome.storage.onChanged.addListener = vi.fn();
  chrome.storage.onChanged.removeListener = vi.fn();
  chrome.tabs.create = vi.fn(async () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FeatureKey + FEATURE_LABEL', () => {
  it('exposes the three wire-format flag names', () => {
    expect(FeatureKey.RECORDING).toBe('recording_enabled');
    expect(FeatureKey.LIVE_TRANSCRIPTION).toBe('live_transcription_enabled');
    expect(FeatureKey.BOT).toBe('bot_enabled');
  });

  it('has friendly labels for every feature key', () => {
    for (const key of Object.values(FeatureKey)) {
      expect(typeof FEATURE_LABEL[key]).toBe('string');
      expect(FEATURE_LABEL[key].length).toBeGreaterThan(0);
    }
  });

  it('FeatureKey is frozen (no accidental mutation)', () => {
    expect(Object.isFrozen(FeatureKey)).toBe(true);
    expect(Object.isFrozen(FEATURE_LABEL)).toBe(true);
  });
});

describe('isFeatureEnabledIn — default-allow semantics', () => {
  it('returns true when snapshot is empty (fresh install / missing API)', () => {
    expect(isFeatureEnabledIn({}, FeatureKey.RECORDING)).toBe(true);
    expect(isFeatureEnabledIn(null, FeatureKey.RECORDING)).toBe(true);
    expect(isFeatureEnabledIn(undefined, FeatureKey.BOT)).toBe(true);
  });

  it('returns true when the key is missing (forward-compat)', () => {
    expect(isFeatureEnabledIn({ other_flag: false }, FeatureKey.RECORDING)).toBe(true);
  });

  it('returns false ONLY for an explicit false', () => {
    expect(isFeatureEnabledIn({ recording_enabled: false }, FeatureKey.RECORDING)).toBe(false);
    // Truthy values (true / strings / 1) should NOT disable.
    expect(isFeatureEnabledIn({ recording_enabled: true }, FeatureKey.RECORDING)).toBe(true);
    expect(isFeatureEnabledIn({ recording_enabled: 1 }, FeatureKey.RECORDING)).toBe(true);
    expect(isFeatureEnabledIn({ recording_enabled: 'yes' }, FeatureKey.RECORDING)).toBe(true);
  });

  it('isolates one feature from another (false on bot does not gate recording)', () => {
    const snap = { recording_enabled: true, bot_enabled: false };
    expect(isFeatureEnabledIn(snap, FeatureKey.RECORDING)).toBe(true);
    expect(isFeatureEnabledIn(snap, FeatureKey.BOT)).toBe(false);
    expect(isFeatureEnabledIn(snap, FeatureKey.LIVE_TRANSCRIPTION)).toBe(true);
  });
});

describe('loadFeatureSnapshot', () => {
  it('returns external_platform verbatim when stored', async () => {
    setSnapshot({
      external_platform: { recording_enabled: true, bot_enabled: false },
      other_top_level: 'ignored',
    });
    const snap = await loadFeatureSnapshot();
    expect(snap).toEqual({ recording_enabled: true, bot_enabled: false });
  });

  it('returns {} when storage has no FEATURES_INFO at all', async () => {
    setSnapshot(undefined);
    const snap = await loadFeatureSnapshot();
    expect(snap).toEqual({});
  });

  it('returns {} when FEATURES_INFO is malformed (no external_platform)', async () => {
    setSnapshot({ other_key: 1 });
    const snap = await loadFeatureSnapshot();
    expect(snap).toEqual({});
  });

  it('returns {} when storage.get throws (treat as missing)', async () => {
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => {
      throw new Error('storage unavailable');
    });
    const snap = await loadFeatureSnapshot();
    expect(snap).toEqual({});
  });
});

describe('isFeatureEnabled (async one-shot)', () => {
  it('combines load + decision (true path)', async () => {
    setSnapshot({ external_platform: { recording_enabled: true } });
    expect(await isFeatureEnabled(FeatureKey.RECORDING)).toBe(true);
  });

  it('combines load + decision (false path)', async () => {
    setSnapshot({ external_platform: { recording_enabled: false } });
    expect(await isFeatureEnabled(FeatureKey.RECORDING)).toBe(false);
  });

  it('default-allows when storage is empty', async () => {
    setSnapshot(undefined);
    expect(await isFeatureEnabled(FeatureKey.BOT)).toBe(true);
  });
});

describe('loadGate', () => {
  it('returns a gate that answers per-key from one snapshot read', async () => {
    setSnapshot({
      external_platform: {
        recording_enabled: true,
        live_transcription_enabled: false,
        bot_enabled: false,
      },
    });

    const gate = await loadGate();

    expect(gate.enabled(FeatureKey.RECORDING)).toBe(true);
    expect(gate.enabled(FeatureKey.LIVE_TRANSCRIPTION)).toBe(false);
    expect(gate.enabled(FeatureKey.BOT)).toBe(false);
    expect(gate.all()).toEqual({
      recording_enabled: true,
      live_transcription_enabled: false,
      bot_enabled: false,
    });
  });

  it('default-allows every key when snapshot is empty', async () => {
    setSnapshot(undefined);
    const gate = await loadGate();
    expect(gate.enabled(FeatureKey.RECORDING)).toBe(true);
    expect(gate.enabled(FeatureKey.LIVE_TRANSCRIPTION)).toBe(true);
    expect(gate.enabled(FeatureKey.BOT)).toBe(true);
  });

  it('refresh() re-reads storage so the next enabled() call sees the change', async () => {
    setSnapshot({ external_platform: { recording_enabled: true } });
    const gate = await loadGate();
    expect(gate.enabled(FeatureKey.RECORDING)).toBe(true);

    setSnapshot({ external_platform: { recording_enabled: false } });
    await gate.refresh();
    expect(gate.enabled(FeatureKey.RECORDING)).toBe(false);
  });

  it('installs a storage listener only when onChange is provided', async () => {
    setSnapshot({ external_platform: {} });
    await loadGate();
    expect(chrome.storage.onChanged.addListener).not.toHaveBeenCalled();

    await loadGate({ onChange: () => {} });
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
  });

  it('onChange fires after storage.FEATURES_INFO changes — gate sees new values', async () => {
    setSnapshot({ external_platform: { recording_enabled: true } });

    const seen = [];
    const gate = await loadGate({
      onChange: (g) => seen.push(g.enabled(FeatureKey.RECORDING)),
    });
    const handler = chrome.storage.onChanged.addListener.mock.calls[0][0];

    // Simulate the SW refreshing FEATURES_INFO → false.
    setSnapshot({ external_platform: { recording_enabled: false } });
    await handler({ [StorageKey.FEATURES_INFO]: { newValue: {} } }, 'local');
    // Yield a microtask for the refresh+notify chain.
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toContain(false);
    expect(gate.enabled(FeatureKey.RECORDING)).toBe(false);
  });

  it('onChange ignores changes from other storage areas / unrelated keys', async () => {
    setSnapshot({ external_platform: { recording_enabled: true } });
    const onChange = vi.fn();
    await loadGate({ onChange });
    const handler = chrome.storage.onChanged.addListener.mock.calls[0][0];

    // Different area — ignored.
    await handler({ [StorageKey.FEATURES_INFO]: { newValue: {} } }, 'session');
    // Unrelated key — ignored.
    await handler({ other_key: { newValue: 1 } }, 'local');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('dispose() removes the storage listener', async () => {
    setSnapshot({ external_platform: {} });
    const gate = await loadGate({ onChange: () => {} });
    expect(chrome.storage.onChanged.removeListener).not.toHaveBeenCalled();
    gate.dispose();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);
  });
});

describe('openPricingPage', () => {
  it('opens PRICING_PAGE_URL in a new tab via chrome.tabs.create', () => {
    openPricingPage();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: PRICING_PAGE_URL });
  });

  it('PRICING_PAGE_URL points at the production pricing page (sanity check)', () => {
    expect(PRICING_PAGE_URL).toBe('https://www.meetminutes.in/pricing');
  });

  it('does not throw when chrome.tabs.create is unavailable', () => {
    delete chrome.tabs.create;
    expect(() => openPricingPage()).not.toThrow();
  });
});

describe('openSupportPage', () => {
  it('opens SUPPORT_PAGE_URL in a new tab via chrome.tabs.create', () => {
    openSupportPage();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: SUPPORT_PAGE_URL });
  });

  it('SUPPORT_PAGE_URL points at the production support page (sanity check)', () => {
    expect(SUPPORT_PAGE_URL).toBe('https://www.meetminutes.in/Support');
  });

  it('does not throw when chrome.tabs.create is unavailable', () => {
    delete chrome.tabs.create;
    expect(() => openSupportPage()).not.toThrow();
  });
});
