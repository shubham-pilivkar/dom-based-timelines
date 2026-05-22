// Phase U6 contract tests. Four independent items, four small
// suites. Where possible we exercise the actual DOM (happy-dom is
// the vitest env); where running the real handler would need a
// full content-script context we read the source as a string and
// pin the wiring.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';


const here = dirname(fileURLToPath(import.meta.url));
const popupCss = readFileSync(resolve(here, '../src/popup/popup.css'), 'utf8');
const popupHtml = readFileSync(resolve(here, '../src/popup/popup.html'), 'utf8');
const overlayJs = readFileSync(resolve(here, '../src/transcribe/overlay.js'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(here, '../manifest.json'), 'utf8'));
const swJs = readFileSync(resolve(here, '../src/background/service-worker.js'), 'utf8');


describe('U6 theme — prefers-color-scheme', () => {
  it('declares the dark-mode palette as the default :root', () => {
    expect(popupCss).toMatch(/:root\s*{[^}]*--bg:\s*#0f1115/);
  });

  it('overrides palette in a prefers-color-scheme: light @media block', () => {
    expect(popupCss).toContain('@media (prefers-color-scheme: light)');
    // Light mode flips bg + text to lighter values. Verify the
    // contract by checking the override block carries an explicit
    // ``--bg:`` line that's NOT the dark default.
    const lightBlock = popupCss.match(
      /@media\s*\(prefers-color-scheme:\s*light\)\s*{([\s\S]*?)\n}/,
    );
    expect(lightBlock, 'light-mode @media block').toBeTruthy();
    expect(lightBlock[1]).toMatch(/--bg:\s*#[0-9a-f]/i);
    expect(lightBlock[1]).not.toMatch(/--bg:\s*#0f1115/);
  });

  it('routes status colors through CSS variables (no hard-coded hex in pills)', () => {
    // Phase U6 audit converted hardcoded hex in the pill / toast
    // classes to variables so light mode flips them too. Regression
    // would re-introduce dark-only hex values.
    const pillBlock = popupCss.match(/\.pill\s*{([^}]*)}/);
    expect(pillBlock, '.pill block').toBeTruthy();
    expect(pillBlock[1]).toMatch(/var\(--/);
    expect(pillBlock[1]).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it('exposes a --focus-ring variable + applies it on :focus-visible', () => {
    expect(popupCss).toMatch(/--focus-ring:/);
    expect(popupCss).toMatch(/:focus-visible[^{]*{[^}]*box-shadow:\s*var\(--focus-ring\)/);
  });
});


describe('U6 keyboard shortcut — toggle-transcribe', () => {
  it('manifest declares the new command with Ctrl+Shift+T default', () => {
    const cmd = manifest.commands?.['toggle-transcribe'];
    expect(cmd, 'toggle-transcribe command missing').toBeTruthy();
    expect(cmd.suggested_key?.default).toBe('Ctrl+Shift+T');
    expect(cmd.suggested_key?.mac).toBe('Command+Shift+T');
  });

  it('keeps toggle-recording intact (no accidental overwrite)', () => {
    expect(manifest.commands?.['toggle-recording']).toBeTruthy();
  });

  it('SW command handler covers both shortcut codes', () => {
    expect(swJs).toContain("command === 'toggle-recording'");
    expect(swJs).toContain("command === 'toggle-transcribe'");
  });

  it('toggle-transcribe falls back to last-used mode + language', () => {
    // The shortcut path must not block on a chooser; it uses last
    // saved values. Regression would either crash on undefined or
    // require the popup to be open.
    expect(swJs).toContain('TRANSCRIBE_LAST_MODE');
    expect(swJs).toContain('TRANSCRIBE_LAST_LANGUAGE');
  });
});


describe('U6 overlay drag + minimize', () => {
  it('imports the persisted-position storage keys', () => {
    expect(overlayJs).toContain('StorageKey.OVERLAY_POSITION');
    expect(overlayJs).toContain('StorageKey.OVERLAY_MINIMIZED');
  });

  it('exposes drag + minimize functions with the documented contract', () => {
    expect(overlayJs).toContain('attachDragHandlers');
    expect(overlayJs).toContain('detachDragHandlers');
    expect(overlayJs).toContain('loadOverlayPrefs');
    expect(overlayJs).toContain('saveOverlayPos');
    expect(overlayJs).toContain('saveOverlayMinimized');
  });

  it('header has cursor: move + minimize button has a focus ring', () => {
    expect(overlayJs).toMatch(/\.header\s*{[^}]*cursor:\s*move/);
    expect(overlayJs).toMatch(/\.minimize-btn:focus-visible/);
  });

  // The overlay shadow DOM is built via createElement/_mk (NOT an
  // innerHTML string) — Meet/Teams enforce Trusted Types and a
  // backtick-in-CSS bug made the old innerHTML template throw. ARIA
  // is now set through _mk's attribute map; assert that form.
  it('panel exposes role=region + aria-label for screen readers', () => {
    expect(overlayJs).toContain("'aria-label': 'Live transcription'");
    expect(overlayJs).toMatch(/_mk\('div', 'panel', \{ role: 'region'/);
  });

  it('uses aria-live=polite on the finals log so screen readers announce final turns', () => {
    expect(overlayJs).toMatch(/_mk\('div', 'finals', \{ role: 'log', 'aria-live': 'polite' \}\)/);
  });

  it('cleans up window event listeners in removeOverlay()', () => {
    // ``removeOverlay`` must call ``detachDragHandlers`` otherwise
    // stale mousemove listeners would keep firing after a session
    // ends — a slow leak that compounds across stop/start cycles.
    const removeIdx = overlayJs.indexOf('function removeOverlay');
    expect(removeIdx).toBeGreaterThan(0);
    const removeBody = overlayJs.slice(removeIdx, removeIdx + 400);
    expect(removeBody).toContain('detachDragHandlers');
  });
});


describe('U6 accessibility on popup HTML', () => {
  it('state pill has role=status + aria-live + aria-label', () => {
    expect(popupHtml).toMatch(/id="state-pill"[^>]*role="status"/);
    expect(popupHtml).toMatch(/id="state-pill"[^>]*aria-live="polite"/);
  });

  it('error row uses role=alert + assertive aria-live', () => {
    expect(popupHtml).toMatch(/id="error-row"[^>]*role="alert"/);
    expect(popupHtml).toMatch(/id="transcribe-error-row"[^>]*role="alert"/);
  });

  it('warn rows use role=status (polite) so they do not interrupt assistive tech', () => {
    expect(popupHtml).toMatch(/id="monitor-blocked-row"[^>]*role="status"/);
    expect(popupHtml).toMatch(/id="queue-warn-row"[^>]*role="status"/);
  });

  it('encryption indicator carries an aria-label (lock emoji is silent otherwise)', () => {
    expect(popupHtml).toMatch(/id="encrypt-indicator"[^>]*aria-label=/);
  });
});
