// Source-contract: meet.js / teams.js must drive caption visibility
// through the ownership policy, NOT the old unconditional hide.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const meet = readFileSync(resolve(here, '../src/content/meet.js'), 'utf8');
const teams = readFileSync(resolve(here, '../src/content/teams.js'), 'utf8');

function assertWired(src, isOnName) {
  // startDetector starts the policy with the platform adapters.
  expect(src).toContain("from '../lib/caption-policy.js'");
  expect(src).toContain('startCaptionPolicy({');
  expect(src).toContain(`isOn: ${isOnName}`);
  expect(src).toContain('hideUI: hideCaptionsUI');
  expect(src).toContain('unhideUI: unhideCaptionsUI');
  // The policy is the ONLY caller of hideCaptionsUI in the start
  // path — the bare unconditional `hideCaptionsUI();` at the top of
  // startDetector must be gone (it survives only as the
  // policy-failed fallback inside a catch).
  const sd = src.slice(
    src.indexOf('function startDetector()'),
    src.indexOf('function stopDetector()'),
  );
  expect(sd).toContain('startCaptionPolicy({');
  // No leading "hideCaptionsUI();" before the policy starts.
  const beforePolicy = sd.slice(0, sd.indexOf('startCaptionPolicy({'));
  expect(beforePolicy).not.toMatch(/\n\s*hideCaptionsUI\(\);/);
  // stopDetector disposes the policy AND asks it to restore (turn
  // extension-owned captions back off so the box doesn't linger).
  const st = src.slice(src.indexOf('function stopDetector()'));
  expect(st).toContain('captionPolicy.dispose({ restore: true })');
  // The platform supplies a disable adapter for that restore.
  expect(src).toMatch(/disable: disable(Meet|Teams)Captions/);
}

describe('meet.js — caption policy wiring', () => {
  it('drives visibility via startCaptionPolicy with a non-sticky isOn', () => {
    assertWired(meet, 'meetCaptionsCurrentlyOn');
    // The non-latched reader exists and is distinct from the sticky
    // meetCaptionsOn (used only to stop the enable-retry loop).
    expect(meet).toContain('function meetCaptionsCurrentlyOn()');
    expect(meet).toContain('"Turn off captions" i');
  });
});

describe('teams.js — caption policy wiring', () => {
  it('drives visibility via startCaptionPolicy (teamsCaptionsOn is live)', () => {
    assertWired(teams, 'teamsCaptionsOn');
  });
});
