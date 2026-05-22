// Three UI-sync fixes (reported by screenshots):
//
//   1. The state pill ("Idle"/"Recording"/"Stopping") in the popup
//      header must stay HIDDEN while the user is on the sign-in
//      view. Previously a STATE_UPDATE broadcast from the SW (which
//      fires regardless of which view the popup has mounted) rebuilt
//      ``className`` wholesale and dropped the ``hidden`` class,
//      surfacing a stray "Idle" pill in the auth header.
//
//   2. The Speaker row must show the signed-in user's display name
//      when ``state.currentSpeaker`` is the GENERIC_SPEAKER
//      placeholder emitted by the caption observer (literal
//      "Speaker", "Speaker A", "Speaker B", …). Otherwise the recap
//      sticks "Speaker" or a letter label on every meeting where the
//      observer couldn't resolve a participant badge.
//
//   3. The Stop click flips the SW state to STOPPING — at that
//      moment the popup must mirror that in ALL three surfaces it
//      paints (top-right pill + control-active-row label + primary
//      button), not just the pill. Two of three lagging at
//      "Recording" was the user-reported bug.
//
// All three pin SOURCE-CONTRACT — we don't spin up the full popup
// DOM in vitest, but we do grep the render path for the exact
// constants + branches that the bug requires.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const popupJs = readFileSync(resolve(here, '../src/popup/popup.js'), 'utf8');
const popupHtml = readFileSync(resolve(here, '../src/popup/popup.html'), 'utf8');


describe('Fix 1 — state pill stays hidden on the auth view', () => {
  it('render() checks main-view visibility before repainting the pill', () => {
    // The render path must not unconditionally write
    // ``els.pill.className = \`pill state-...\``` — that would drop
    // the .hidden class set by showAuthView().
    const renderIdx = popupJs.indexOf('function render(');
    expect(renderIdx).toBeGreaterThan(0);
    // Find the pill-update block specifically.
    const pillUpdate = popupJs.slice(renderIdx);
    expect(pillUpdate).toMatch(/mainVisible\s*=\s*!els\.mainView\.classList\.contains\(['"]hidden['"]\)/);
    // The unconditional write must now sit INSIDE an if-mainVisible.
    expect(pillUpdate).toMatch(
      /if \(mainVisible\) \{[\s\S]{0,400}els\.pill\.className/,
    );
    // And when the main view isn't visible we MUST re-hide the pill
    // (defensive — a previous render may have shown it then user
    // signed out).
    expect(pillUpdate).toMatch(/else \{[\s\S]{0,200}els\.pill\.classList\.add\(['"]hidden['"]\)/);
  });

  it('HTML default is `hidden` (defence in depth)', () => {
    // First paint must not flash the pill even before render runs.
    expect(popupHtml).toMatch(
      /id="state-pill"[^>]*class="pill state-idle hidden"/,
    );
  });
});


describe('Fix 2 — Speaker row promotes "Speaker"/"Speaker A" to the signed-in user name', () => {
  it('treats /^Speaker(?: [A-Z]| \\d+)?$/ as a generic placeholder', () => {
    // Same regex the overlay's _GENERIC_SPEAKER_LABEL uses (kept
    // local in popup.js so the two surfaces evolve together without
    // a shared import — the regex is one line and unlikely to drift).
    expect(popupJs).toMatch(
      /\/\^Speaker\(\?:\s*\[A-Z\]\s*\|\s*\\d\+\)\?\$\//,
    );
  });

  it('renderFinal fallback fires when currentSpeaker is generic', () => {
    // Pull the speaker-render block + assert it routes through
    // signedInDisplayName() when (a) currentSpeaker is missing OR
    // (b) currentSpeaker matches the generic placeholder shape.
    const idx = popupJs.indexOf('els.speaker.textContent');
    expect(idx).toBeGreaterThan(0);
    const block = popupJs.slice(idx, idx + 500);
    expect(block).toContain('speakerLooksGeneric');
    expect(block).toContain('signedInDisplayName()');
  });
});


describe('Fix 3 — Stop click syncs ALL three live-session surfaces', () => {
  it('control-active-row carries an updatable label element (#control-active-label)', () => {
    // The HTML row label used to be a static "Recording" text node.
    // For the label to flip to "Stopping" during teardown, the JS
    // needs a stable hook — give it an ID.
    expect(popupHtml).toMatch(/id="control-active-label"/);
  });

  it('applyControlOwnedView mirrors state in the row label + primary button', () => {
    const fnIdx = popupJs.indexOf('function applyControlOwnedView(');
    expect(fnIdx).toBeGreaterThan(0);
    const fn = popupJs.slice(fnIdx, fnIdx + 1800);
    // Both the button label and the row label must vary per state.
    expect(fn).toMatch(/state\.state === RecordingState\.STOPPING/);
    expect(fn).toMatch(/state\.state === RecordingState\.STARTING/);
    // Concrete copy expected on the three branches.
    expect(fn).toContain("'Stopping…'");
    expect(fn).toContain("'Starting…'");
    expect(fn).toContain("'Recording…'");
    expect(fn).toContain("'Stopping'");
    expect(fn).toContain("'Starting'");
    expect(fn).toContain("'Recording'");
    // …and the row label is actually written from the chosen value.
    expect(fn).toMatch(/els\.controlActiveLabel(?:\.textContent\s*=|.+rowLabel)/);
  });

  it('els.controlActiveLabel is registered in the els map', () => {
    expect(popupJs).toContain("controlActiveLabel: $('control-active-label')");
  });
});
