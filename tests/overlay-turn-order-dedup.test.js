// turn_order replace-in-place dedup (issue 5.1/5.3).
//
// AssemblyAI v3 re-emits a final for the SAME ``turn_order`` when it
// formats / refines a turn. Without dedup the overlay stacked each as
// a new line → the duplicated, superset, out-of-order transcript the
// user reported:
//
//   [13:04:21] Hello.
//   [13:04:21] Hello, my name is— I am doing test.   ← same turn, superset
//
// The fix keys committed final rows by (streamRole, turn_order) and
// REPLACES the row's text in place when a later final carries a
// turn_order we've already committed. Source-contract tests (the
// overlay needs a Shadow-DOM mount to exercise end-to-end, which the
// other overlay suites also avoid).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const overlay = readFileSync(
  resolve(here, '../src/transcribe/overlay.js'),
  'utf8',
);

describe('overlay turn_order dedup — plumbing', () => {
  it('keeps a turn→row map keyed per substream (mic turn 1 != tab turn 1)', () => {
    expect(overlay).toContain('const finalRowByTurn = new Map();');
    expect(overlay).toMatch(/function _turnKey\(streamRole, turnOrder\)/);
    // Composite key includes the streamRole so substreams don't collide.
    expect(overlay).toMatch(/\$\{streamRole \?\? 'default'\}:\$\{turnOrder\}/);
  });

  it('renderFinal replaces in place when the turn was already committed', () => {
    const start = overlay.indexOf('function renderFinal(');
    const end = overlay.indexOf('\nfunction renderPartials(', start);
    const fn = overlay.slice(start, end);
    // Reads turn_order off the event (snake_case from the backend wire).
    expect(fn).toMatch(/event\.turn_order !== null/);
    // Looks up the existing row by turn key, and only replaces when it's
    // still attached to the DOM.
    expect(fn).toMatch(/finalRowByTurn\.get\(_turnKey\(streamRole, event\.turn_order\)\)/);
    expect(fn).toContain('existing.isConnected');
    // Updates the speaker + text spans in place, then returns WITHOUT
    // appending a duplicate row.
    expect(fn).toMatch(/existing\.querySelector\('\.speaker'\)/);
    expect(fn).toMatch(/existing\.querySelector\('\.text'\)/);
    // Stores newly-appended rows so the NEXT final for the turn matches.
    expect(fn).toMatch(/finalRowByTurn\.set\(_turnKey\(streamRole, event\.turn_order\), row\)/);
    // The body span carries a ``.text`` class so replace-in-place can
    // target it.
    expect(fn).toMatch(/textSpan\.className = 'text'/);
  });

  it('clears the turn map on every session-scope reset (no cross-session collisions)', () => {
    // Counts: session-end teardown, provider-switch, reconnect started,
    // and destructive new-session — all must drop the map so a fresh
    // turn 1 never overwrites a prior session's committed line.
    const clears = (overlay.match(/finalRowByTurn\.clear\(\)/g) || []).length;
    expect(clears).toBeGreaterThanOrEqual(4);
  });
});
