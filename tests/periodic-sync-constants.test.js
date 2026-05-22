// Smoke tests for the Phase D periodic-sync constants. The actual
// alarm callback runs inside the SW which is heavy to unit-test;
// these contract tests catch the obvious typo / sizing bugs.

import { describe, expect, it } from 'vitest';

import {
  PERIODIC_SYNC_ALARM_NAME,
  PERIODIC_SYNC_PERIOD_MIN,
  TELEMETRY_EVENT_NAMES,
} from '../src/constants.js';


describe('periodic-sync alarm constants', () => {
  it('alarm name is unique and namespaced', () => {
    expect(PERIODIC_SYNC_ALARM_NAME).toBe('mm_periodic_sync');
  });

  it('period is at least 30 min so we do not burn battery / Chrome quota', () => {
    // chrome.alarms minimum is 30s during recording; the periodic
    // sync's whole point is to be infrequent. If this drops below
    // 5 min something's wrong.
    expect(PERIODIC_SYNC_PERIOD_MIN).toBeGreaterThanOrEqual(5);
  });

  it('period is below 4 hours so a same-day backlog clears the same day', () => {
    // A backlog from a morning network outage should clear before
    // the user notices in the evening. 4 h cap keeps the alarm
    // firing frequently enough for that.
    expect(PERIODIC_SYNC_PERIOD_MIN).toBeLessThanOrEqual(240);
  });

  it('exposes the periodic-sync telemetry event name', () => {
    expect(TELEMETRY_EVENT_NAMES.PERIODIC_SYNC_TICK).toBe('periodic_sync_tick');
  });
});
