// Spec UI-format contract: the live transcript overlay must render
// each line as ``[Start Time] Speaker Name: Content``. Before this
// change the overlay rendered only ``Speaker: Content`` with no
// bracketed time. Same source-text contract style as
// `transcribe-mode-3-both.test.js` — we pin the wiring so a refactor
// that drops the time prefix fails here first.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const overlayJs = readFileSync(
  resolve(here, '../src/transcribe/overlay.js'),
  'utf8',
);

describe('overlay — [Start Time] prefix (spec UI format)', () => {
  it('builds a bracketed clock string', () => {
    expect(overlayJs).toContain('function _formatClock(ms)');
    expect(overlayJs).toContain('`[${_formatClock(ms)}]`');
    // 24h zero-padded HH:MM:SS so the bracket is locale-stable.
    expect(overlayJs).toContain("padStart(2, '0')");
  });

  it('prepends the time span to both final and partial rows', () => {
    // Two append sites: renderFinal (finals) + renderPartials.
    const appends = overlayJs.match(/_makeTimeSpan\(/g) || [];
    // one definition call + one in renderFinal + one in renderPartials
    expect(appends.length).toBeGreaterThanOrEqual(2);
    expect(overlayJs).toContain('row.appendChild(_makeTimeSpan(_startMs));');
    expect(overlayJs).toContain(
      'row.appendChild(_makeTimeSpan(entry.ts ?? Date.now()));',
    );
  });

  it('keeps the per-utterance start time stable across revisions', () => {
    // Partial revisions must reuse the first-seen ts; finals inherit
    // the partial's ts so the bracket shows utterance START, not the
    // finalize moment.
    expect(overlayJs).toContain(
      'const _ts = partialBySpeaker.get(_pk)?.ts ?? Date.now();',
    );
    // Bug 12.1 added a single ``nowMs = Date.now()`` cache at the top
    // of renderFinal so the dedup guard, partial-clear, and start-ms
    // fallback all use the same value. The contract (final inherits
    // partial's ts; falls back to "now" when no partial) is
    // unchanged — only the literal moved.
    expect(overlayJs).toContain(
      'const _startMs = partialBySpeaker.get(_pkey)?.ts ?? nowMs;',
    );
  });
});
