// Bug 5.2 — DEFAULTS.badgeSelectors must scope Teams' [data-tid="author"]
// to caption parents so a side-panel chat author cell (which also has
// data-tid="author" on Teams) can't be picked up as a caption badge.
//
// The Teams content script passes its OWN badgeSelectors + a
// blockSelector that scopes the querySelector to the caption block,
// so the previously-bare ``[data-tid="author"]`` is safe THERE.
// But the DEFAULTS (which Meet uses, with no blockSelector) observe
// at document.body root → an unscoped match could fire on any
// non-caption author cell. The new scoped variants are added so
// DEFAULTS resolve only against real caption-container parents.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, '../src/lib/caption-speaker-observer.js'),
  'utf8',
);

describe('DEFAULTS.badgeSelectors — Teams author scoped to caption parents (Bug 5.2)', () => {
  it('includes the scoped closed-caption-v2-window-wrapper variant', () => {
    expect(src).toMatch(
      /\[data-tid='closed-caption-v2-window-wrapper'\]\s+\[data-tid='author'\]/,
    );
  });

  it('includes the scoped closed-captions-renderer variant', () => {
    expect(src).toMatch(
      /\[data-tid='closed-captions-renderer'\]\s+\[data-tid='author'\]/,
    );
  });

  it('includes a generic closed-caption-*-i wildcard scope (forward-compat for new wrapper names)', () => {
    expect(src).toMatch(
      /\[data-tid\*="closed-caption" i\]\s+\[data-tid="author"\]/,
    );
  });

  it('preserves Meet selectors (.NWpY1d / .xoMHSc) — Bug 5.2 must not regress Meet', () => {
    expect(src).toMatch(/\.NWpY1d/);
    expect(src).toMatch(/\.xoMHSc/);
  });

  it('preserves the [data-self-name] / [data-speaker-name] generic fallbacks', () => {
    expect(src).toMatch(/\[data-self-name\]/);
    expect(src).toMatch(/\[data-speaker-name\]/);
  });
});

describe('DEFAULTS.badgeSelectors — runtime behaviour (querySelectorAll wiring)', () => {
  // Drive the selector string through the browser's matches/closest
  // machinery to confirm the scoping actually works against a real
  // DOM. Doesn't import the observer — we extract the selector string
  // from source and test it in isolation so the assertion is about
  // selector semantics, not observer state.
  function extractDefaultBadgeSelectors() {
    // Re-build the selector by reading the actual exported defaults
    // via a regex against the source (avoids depending on a runtime
    // export that doesn't exist).
    const match = src.match(
      /badgeSelectors:\s*([\s\S]+?),\s*\/\/ Caption region anchors/,
    );
    if (!match) throw new Error('badgeSelectors block not found in source');
    // Evaluate the JS string-concat expression carefully — the source
    // uses string-concat with template-like newlines. Strip JS
    // string-concat tokens and collapse to one CSS selector list.
    const concatenated = match[1]
      .replace(/['"]/g, '')
      .replace(/\+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/,$/, '');
    return concatenated;
  }

  it('scoped Teams author DOES match a caption-author cell', () => {
    const sel = extractDefaultBadgeSelectors();
    const root = document.createElement('div');
    root.innerHTML = `
      <div data-tid="closed-caption-v2-window-wrapper">
        <span data-tid="author">Rishi Patel</span>
        <span>Hello team</span>
      </div>
    `;
    document.body.appendChild(root);
    const match = root.querySelector(sel);
    expect(match?.textContent?.trim()).toBe('Rishi Patel');
    root.remove();
  });

  it('scoped Teams author does NOT match an out-of-caption author cell', () => {
    const sel = extractDefaultBadgeSelectors();
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="side-chat-panel">
        <span data-tid="author">SidePanelAuthor</span>
        <span>random chat text</span>
      </div>
    `;
    document.body.appendChild(root);
    const match = root.querySelector(sel);
    expect(match).toBeNull();
    root.remove();
  });

  it('still matches a Meet .NWpY1d badge (no Teams-only regression)', () => {
    const sel = extractDefaultBadgeSelectors();
    const root = document.createElement('div');
    root.innerHTML = `
      <div aria-live="polite">
        <span class="NWpY1d">Shubham Pilivkar</span>
        <span>hi all</span>
      </div>
    `;
    document.body.appendChild(root);
    const match = root.querySelector(sel);
    expect(match?.textContent?.trim()).toBe('Shubham Pilivkar');
    root.remove();
  });
});
