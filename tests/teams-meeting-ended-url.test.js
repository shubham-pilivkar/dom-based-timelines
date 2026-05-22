// Fix 5 — Teams URL-based meeting-ended detector (Meet/Teams parity).
//
// meet.js fires MEETING_ENDED on a locale-independent URL transition
// (leaving the meeting-room path). teams.js previously had ONLY a
// text-based detector, so a non-English Teams end panel never fired
// MEETING_ENDED → the recording relied on the slow stop-force fallback
// instead of prompt finalize. This adds a URL detector to teams.js.
//
// Content scripts can't run live under vitest, so the wiring is pinned
// by source contract (same style as the other content-script suites);
// the room-URL regex is also exercised behaviorally with a local copy.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const teams = readFileSync(resolve(here, '../src/content/teams.js'), 'utf8');
const meet = readFileSync(resolve(here, '../src/content/meet.js'), 'utf8');

describe('Fix 5 — Teams URL meeting-ended detector', () => {
  it('defines isInTeamsMeetingRoom + checkTeamsUrlEnded', () => {
    expect(teams).toMatch(/function isInTeamsMeetingRoom\(\)/);
    expect(teams).toMatch(/function checkTeamsUrlEnded\(\)/);
    expect(teams).toMatch(/_TEAMS_ROOM_RE/);
  });

  it('only fires on a genuine in-room → not-in-room transition (conservative)', () => {
    const fnIdx = teams.indexOf('function checkTeamsUrlEnded()');
    const fn = teams.slice(fnIdx, fnIdx + 600);
    // Recording-gated + latched.
    expect(fn).toMatch(/if \(!recordingActive \|\| meetingEndedFired\) return;/);
    // Requires we WERE in a room and now are NOT.
    expect(fn).toMatch(/if \(lastTeamsInRoom && !nowInRoom\)/);
    expect(fn).toMatch(/reason: 'teams_url_left_room'/);
    expect(fn).toMatch(/meetingEndedFired = true;/);
  });

  it('catches SPA route changes via popstate + hashchange (not just DOM mutations)', () => {
    expect(teams).toMatch(/window\.addEventListener\('popstate', checkTeamsUrlEnded\)/);
    expect(teams).toMatch(/window\.addEventListener\('hashchange', checkTeamsUrlEnded\)/);
  });

  it('also runs the URL check from the endObserver before the text check', () => {
    const obsIdx = teams.indexOf('const endObserver = new MutationObserver(');
    const obs = teams.slice(obsIdx, obsIdx + 700);
    expect(obs).toMatch(/checkTeamsUrlEnded\(\)/);
    // text fallback still present.
    expect(obs).toMatch(/looksLikeMeetingEnded\(text\)/);
  });

  it('re-baselines lastTeamsInRoom when a fresh recording starts', () => {
    expect(teams).toMatch(/lastTeamsInRoom = isInTeamsMeetingRoom\(\);/);
    // …inside the RECORDING_LIFECYCLE started branch (anchored on the
    // recordingActive flip, which only appears in that branch).
    const startIdx = teams.indexOf('recordingActive = true;');
    const near = teams.slice(startIdx, startIdx + 250);
    expect(near).toMatch(/lastTeamsInRoom = isInTeamsMeetingRoom\(\)/);
  });

  it('Meet still has its URL detector (parity sanity)', () => {
    expect(meet).toMatch(/function isOnMeetingRoomPath\(\)/);
    expect(meet).toMatch(/reason: 'meet_url_left_room'/);
  });
});

describe('Fix 5 — Teams room-URL regex behavior', () => {
  // Local copy of _TEAMS_ROOM_RE (content-script-local, not exported).
  // Keep in sync with teams.js.
  const RE =
    /https:\/\/(?:teams\.microsoft\.com|teams\.live\.com)\/(?:_#\/)?(?:l\/meetup-join\/|meetup-join\/|pre-join-calling\/|calling\/)/;

  it('matches v2 path-routed + v1 hash-routed + calling surfaces', () => {
    expect(RE.test('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x')).toBe(true);
    expect(RE.test('https://teams.microsoft.com/_#/l/meetup-join/19%3ameeting_x')).toBe(true);
    expect(RE.test('https://teams.live.com/meetup-join/abc')).toBe(true);
    expect(RE.test('https://teams.microsoft.com/pre-join-calling/19%3a')).toBe(true);
    expect(RE.test('https://teams.microsoft.com/calling/abc')).toBe(true);
  });

  it('does NOT match the post-meeting / home surfaces (→ "left room")', () => {
    expect(RE.test('https://teams.microsoft.com/_#/conversations')).toBe(false);
    expect(RE.test('https://teams.microsoft.com/v2/')).toBe(false);
    expect(RE.test('https://teams.live.com/_#/calendar')).toBe(false);
  });
});
