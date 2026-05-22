// Bug 12.1 — Mode 3 echo dedup wiring (source-contract tests).
//
// In live-transcribe mode='both' the user's voice is captured TWICE:
// the mic substream gets it directly and the tab substream gets it
// echoed via meeting audio. Both substream finals reach the overlay;
// without dedup, every utterance is rendered twice — once labelled
// from the mic substream, once labelled the same from the tab
// substream (Phase 2D's cross-pollination correctly resolves the tab
// numeric to selfName).
//
// The dedup logic itself is unit-tested in mic-echo-dedup.test.js.
// THIS suite confirms overlay.js wires it into ``renderFinal`` and
// into every speakerMap reset site so a fresh session starts clean.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const o = readFileSync(
  resolve(here, '../src/transcribe/overlay.js'),
  'utf8',
);

describe('overlay imports + instantiates MicEchoDedup', () => {
  it('imports MicEchoDedup from the dedicated module', () => {
    expect(o).toMatch(
      /import\s+\{\s*MicEchoDedup\s*\}\s+from\s+['"]\.\/mic-echo-dedup\.js['"]/,
    );
  });

  it('has a single module-scoped ``micEchoDedup`` instance', () => {
    expect(o).toMatch(/const\s+micEchoDedup\s*=\s*new\s+MicEchoDedup\(/);
  });
});

describe('renderFinal drops tab-substream echoes of recent mic finals', () => {
  it('resolves the speaker name BEFORE checking dedup (so dedup compares the right label)', () => {
    // Slice the renderFinal body so the assertion is local to that
    // function (not just somewhere in the file).
    const start = o.indexOf('function renderFinal(');
    const end = o.indexOf('\nfunction renderPartials(', start);
    const fn = o.slice(start, end);
    expect(fn).toMatch(/const\s+resolvedName\s*=\s*speakerMap\.resolve\(/);
    // The dedup check must use resolvedName, not a separate call.
    expect(fn).toMatch(/micEchoDedup\.isEcho\(\s*resolvedName/);
  });

  it('only checks dedup on the TAB substream (mic finals must always render)', () => {
    const start = o.indexOf('function renderFinal(');
    const end = o.indexOf('\nfunction renderPartials(', start);
    const fn = o.slice(start, end);
    // Guard text — exact form: streamRole === 'tab' && micEchoDedup.isEcho(...)
    expect(fn).toMatch(
      /streamRole\s*===\s*'tab'[\s\S]{0,80}micEchoDedup\.isEcho/,
    );
  });

  it('records mic-origin finals into the dedup ring', () => {
    const start = o.indexOf('function renderFinal(');
    const end = o.indexOf('\nfunction renderPartials(', start);
    const fn = o.slice(start, end);
    expect(fn).toMatch(/_isMicEvent\(streamRole\)[\s\S]{0,80}micEchoDedup\.recordMicFinal\(/);
  });

  it('suppresses the partial when dropping an echo so no stale row lingers', () => {
    const start = o.indexOf('function renderFinal(');
    const end = o.indexOf('\nfunction renderPartials(', start);
    const fn = o.slice(start, end);
    // The early-return branch must clear the partial map entry for
    // the suppressed key and re-render partials. Without this, the
    // tab-substream partial that preceded the dropped final lingers
    // visually until the next partial arrives.
    expect(fn).toMatch(/partialBySpeaker\.delete\(\s*_suppressedKey\s*\)/);
  });
});

describe('dedup ring is reset on every session boundary', () => {
  it('resets on the first ``started`` of a new (non-reconnect) session', () => {
    // Bug 1's session-init path uses ``overlaySessionInitialized = true``
    // as a unique anchor — use that to land in the right neighbourhood
    // (indexOf 'speakerMap.reset()' would also match the JSDoc comment
    // at the top of the file).
    const idx = o.indexOf('overlaySessionInitialized = true');
    expect(idx).toBeGreaterThan(-1);
    const slice = o.slice(idx, idx + 800);
    expect(slice).toMatch(/speakerMap\.reset\(\)/);
    expect(slice).toMatch(/micEchoDedup\.reset\(\)/);
  });

  it('resets on isReconnect path (fresh provider session may re-tokenise text)', () => {
    const idx = o.indexOf('if (message.isReconnect)');
    expect(idx).toBeGreaterThan(-1);
    // Slice generously — the body has explanatory comments between
    // the two resets that push the second past a tight 600-char cap.
    const slice = o.slice(idx, idx + 1000);
    expect(slice).toMatch(/speakerMap\.clearNumericBindings\(\)/);
    expect(slice).toMatch(/micEchoDedup\.reset\(\)/);
  });

  it('resets on provider_switch event handling', () => {
    const idx = o.indexOf("event.type === 'provider_switch'");
    expect(idx).toBeGreaterThan(-1);
    // Comment about "drop the dedup ring too" sits between the two
    // resets — slice wide enough to include both lines.
    const slice = o.slice(idx, idx + 1000);
    expect(slice).toMatch(/speakerMap\.clearNumericBindings\(\)/);
    expect(slice).toMatch(/micEchoDedup\.reset\(\)/);
  });

  it('resets on stopped lifecycle (enterStoppedState path)', () => {
    const idx = o.indexOf('enterStoppedState(message.reason)');
    expect(idx).toBeGreaterThan(-1);
    const slice = o.slice(idx, idx + 200);
    expect(slice).toMatch(/speakerMap\.reset\(\)/);
    expect(slice).toMatch(/micEchoDedup\.reset\(\)/);
  });
});
