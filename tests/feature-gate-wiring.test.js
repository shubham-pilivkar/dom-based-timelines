// Contract tests for popup.js / popup.html / popup.css feature-gate
// wiring. We don't spin up the full popup in jsdom; we pin the
// surface area:
//
//   * popup.html has the upgrade-modal scaffolding and every ID the
//     popup.js code references
//   * popup.css carries the .feature-disabled + .upgrade-modal* rules
//     so a disabled control reads as locked
//   * popup.js boots loadGate with onChange (live updates) and the
//     gate intercepts clicks via a capture-phase listener so existing
//     handlePrimary / setView / botSubmit handlers don't need to
//     learn about gating
//   * the gated-features registry covers all three flags
//   * the upgrade modal's CTA opens the pricing page (openPricingPage)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const popupHtml = readFileSync(resolve(here, '../src/popup/popup.html'), 'utf8');
const popupJs = readFileSync(resolve(here, '../src/popup/popup.js'), 'utf8');
const popupCss = readFileSync(resolve(here, '../src/popup/popup.css'), 'utf8');
const swJs = readFileSync(
  resolve(here, '../src/background/service-worker.js'),
  'utf8',
);
const apiJs = readFileSync(resolve(here, '../src/api/client.js'), 'utf8');


describe('popup.html — upgrade modal scaffolding', () => {
  const ids = [
    'upgrade-modal',
    'upgrade-modal-backdrop',
    'upgrade-modal-close',
    'upgrade-modal-title',
    'upgrade-modal-message',
    'upgrade-modal-cta',
    'upgrade-modal-support',
  ];

  for (const id of ids) {
    it(`includes #${id}`, () => {
      expect(popupHtml).toContain(`id="${id}"`);
    });
  }

  it('modal carries dialog semantics (role + aria-modal)', () => {
    expect(popupHtml).toMatch(/id="upgrade-modal"[^>]*role="dialog"/);
    expect(popupHtml).toMatch(/id="upgrade-modal"[^>]*aria-modal="true"/);
  });

  it('starts hidden — only the gated-click path opens it', () => {
    expect(popupHtml).toMatch(/id="upgrade-modal"[^>]*class="upgrade-modal hidden"/);
  });
});


describe('popup.css — feature-disabled + upgrade modal styles', () => {
  it('defines the .feature-disabled visual lock state', () => {
    expect(popupCss).toMatch(/\.feature-disabled\s*\{[^}]*opacity[^}]*cursor[^}]*not-allowed/s);
  });

  it('puts a lock glyph on disabled tabs (subtle subscription cue)', () => {
    expect(popupCss).toMatch(/\.view-tab\.feature-disabled::after\s*\{/);
  });

  it('defines a centered upgrade modal overlay', () => {
    expect(popupCss).toMatch(/\.upgrade-modal\s*\{[^}]*position:\s*fixed/s);
    expect(popupCss).toMatch(/\.upgrade-modal-backdrop\s*\{/);
    expect(popupCss).toMatch(/\.upgrade-modal-card\s*\{/);
  });

  it('styles the CTA + secondary support buttons', () => {
    expect(popupCss).toMatch(/button\.upgrade-modal-cta\s*\{/);
    expect(popupCss).toMatch(/button\.upgrade-modal-support\s*\{/);
  });
});


describe('popup.js — feature gate wiring', () => {
  it('imports feature-gate module (FeatureKey + loadGate + openPricingPage)', () => {
    expect(popupJs).toMatch(/from\s+['"]\.\.\/lib\/feature-gate\.js['"]/);
    expect(popupJs).toContain('FeatureKey');
    expect(popupJs).toContain('loadGate');
    expect(popupJs).toContain('openPricingPage');
    expect(popupJs).toContain('FEATURE_LABEL');
  });

  it('registers every gated control in GATED_FEATURES (one row per flag)', () => {
    // Single source of truth for "which surface is gated by which
    // backend flag" — adding a new flag = adding one row, not
    // rewriting popup.js. Pin the three rows we shipped.
    expect(popupJs).toContain('FeatureKey.RECORDING');
    expect(popupJs).toContain('FeatureKey.LIVE_TRANSCRIPTION');
    expect(popupJs).toContain('FeatureKey.BOT');
    // The registry primary buttons must match the existing wiring.
    const registrySlice = popupJs.slice(
      popupJs.indexOf('GATED_FEATURES'),
      popupJs.indexOf('let _featureGate'),
    );
    expect(registrySlice).toContain('els.tabRecord');
    expect(registrySlice).toContain('els.primary');
    expect(registrySlice).toContain('els.tabTranscribe');
    expect(registrySlice).toContain('els.transcribeBtn');
    expect(registrySlice).toContain('els.tabBot');
    expect(registrySlice).toContain('els.botSubmit');
  });

  it('applyGates intercepts clicks on the capture phase (runs before user handlers)', () => {
    // Capture-phase is the key trick — handlePrimary etc. don't need
    // to learn about gating; the gate runs first and
    // stopImmediatePropagation()s when disabled.
    expect(popupJs).toMatch(/addEventListener\('click',[^,]*,\s*true\)/);
    expect(popupJs).toContain('stopImmediatePropagation');
  });

  it('upgrade modal opens with the friendly feature label, not the wire key', () => {
    expect(popupJs).toContain('openUpgradeModal');
    expect(popupJs).toContain('FEATURE_LABEL[featureKey]');
  });

  it('CTA opens the pricing page via openPricingPage (chrome.tabs.create)', () => {
    const ctaSlice = popupJs.slice(popupJs.indexOf('upgradeModalCta'));
    expect(ctaSlice).toContain('openPricingPage()');
  });

  it('Contact Support opens the support page via openSupportPage', () => {
    // Single helper for the support URL so the modal CTA and any
    // future surface (banners, settings page) share one constant.
    expect(popupJs).toContain('openSupportPage');
    const supportSlice = popupJs.slice(popupJs.indexOf('upgradeModalSupport'));
    expect(supportSlice).toContain('openSupportPage()');
  });

  it('subscribes to onChange so a SW refresh live-updates the popup', () => {
    expect(popupJs).toMatch(/loadGate\(\{\s*onChange:/);
  });

  it('Escape key closes the modal (a11y)', () => {
    expect(popupJs).toMatch(/ev\.key !== 'Escape'/);
  });

  it('initFeatureGates is invoked at boot', () => {
    // Same line that calls initAuthGate / restoreTranscribePickers.
    expect(popupJs).toMatch(/initFeatureGates\(\)/);
  });
});


describe('service-worker.js — features refresh wiring', () => {
  it('imports refreshFeaturesInfo from the API client', () => {
    expect(swJs).toMatch(/refreshFeaturesInfo/);
  });

  it('arms the periodic features-refresh alarm', () => {
    expect(swJs).toContain('FEATURES_REFRESH_ALARM_NAME');
    expect(swJs).toContain('FEATURES_REFRESH_PERIOD_MIN');
  });
});


describe('api/client.js — features endpoint wiring', () => {
  it('exports getFeaturesInfo + refreshFeaturesInfo', () => {
    expect(apiJs).toMatch(/export\s+(async\s+)?function\s+getFeaturesInfo/);
    expect(apiJs).toMatch(/export\s+(async\s+)?function\s+refreshFeaturesInfo/);
  });

  it('refreshes features after login + register + oauth (best-effort)', () => {
    // Each auth entry point should kick the refresh, otherwise a
    // freshly signed-in user sees stale gates from the previous
    // account until the next alarm tick.
    const sliceCount = (apiJs.match(/refreshFeaturesInfo\(\)/g) || []).length;
    // Imports + the function definition + at least three call sites
    // (login, register, authenticateWithProvider).
    expect(sliceCount).toBeGreaterThanOrEqual(3);
  });

  it('clears FEATURES_INFO + FEATURES_FETCHED_AT on logout', () => {
    // Avoid stale feature snapshot from leaking from user A to user B
    // when they sign in on the same browser profile.
    const logoutIdx = apiJs.indexOf('export async function logout');
    const logoutBody = logoutIdx >= 0 ? apiJs.slice(logoutIdx, logoutIdx + 2000) : '';
    expect(logoutBody).toContain('FEATURES_INFO');
    expect(logoutBody).toContain('FEATURES_FETCHED_AT');
  });

  it('endpoints map carries /subscription/get-features-info', () => {
    expect(apiJs).toContain('/subscription/get-features-info');
  });
});
