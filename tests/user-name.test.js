// Tests for lib/user-name.js — the centralised "what should we call
// the signed-in user" resolver. Backend ``user.name`` (StorageKey.
// USER_NAME) wins; email local part is the fallback.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveNameFromEmail,
  loadDisplayName,
  resolveDisplayName,
  resolveImportantPointSpeaker,
} from '../src/lib/user-name.js';
import { StorageKey } from '../src/constants.js';

function mockStorageWith(values) {
  vi.mocked(chrome.storage.local.get).mockImplementation(async (keys) => {
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((k) => [k, values[k]]));
    }
    return { ...values };
  });
}

describe('deriveNameFromEmail', () => {
  it('title-cases dotted local parts', () => {
    expect(deriveNameFromEmail('shubham.pilivkar@meetminutes.in'))
      .toBe('Shubham Pilivkar');
  });

  it('handles underscores and dashes', () => {
    expect(deriveNameFromEmail('jane_doe-smith@x.com'))
      .toBe('Jane Doe Smith');
  });

  it('single-word local stays single', () => {
    expect(deriveNameFromEmail('shubham@example.com')).toBe('Shubham');
  });

  it('empty / dash returns empty', () => {
    expect(deriveNameFromEmail('')).toBe('');
    expect(deriveNameFromEmail('—')).toBe('');
    expect(deriveNameFromEmail(null)).toBe('');
    expect(deriveNameFromEmail(undefined)).toBe('');
  });
});

describe('resolveDisplayName (synchronous)', () => {
  it('USER_NAME wins over USER_EMAIL', () => {
    expect(resolveDisplayName({
      userName: 'Shubham Pilivkar',
      userEmail: 'shubhampilivkar@gmail.com',
    })).toBe('Shubham Pilivkar');
  });

  it('falls back to email-derived when name missing', () => {
    expect(resolveDisplayName({
      userName: null,
      userEmail: 'rishi.patel@meetminutes.in',
    })).toBe('Rishi Patel');
  });

  it('trims whitespace from stored name', () => {
    expect(resolveDisplayName({
      userName: '  Shubham Pilivkar  ',
      userEmail: 'x@y.com',
    })).toBe('Shubham Pilivkar');
  });

  it('blank name string falls through to email', () => {
    expect(resolveDisplayName({
      userName: '   ',
      userEmail: 'jane@x.com',
    })).toBe('Jane');
  });

  it('both missing returns empty', () => {
    expect(resolveDisplayName({})).toBe('');
    expect(resolveDisplayName({ userName: null, userEmail: null })).toBe('');
  });
});

describe('resolveImportantPointSpeaker (Bug 3E)', () => {
  const SELF = 'Shubham Pilivkar';

  it('promotes first-name match to the full backend display name', () => {
    expect(resolveImportantPointSpeaker('Shubham', SELF)).toBe(SELF);
  });

  it('promotes case-insensitively (lowercase Gemini output)', () => {
    expect(resolveImportantPointSpeaker('shubham', SELF)).toBe(SELF);
    expect(resolveImportantPointSpeaker('SHUBHAM', SELF)).toBe(SELF);
  });

  it('exact full-name match round-trips through the canonical casing', () => {
    expect(resolveImportantPointSpeaker('shubham pilivkar', SELF)).toBe(SELF);
  });

  it('leaves other participants untouched', () => {
    expect(resolveImportantPointSpeaker('Rishi', SELF)).toBe('Rishi');
    expect(resolveImportantPointSpeaker('Suparna Mehta', SELF)).toBe('Suparna Mehta');
  });

  it('drops synthetic "Speaker A/B/C" placeholders entirely', () => {
    expect(resolveImportantPointSpeaker('Speaker A', SELF)).toBeNull();
    expect(resolveImportantPointSpeaker('Speaker C', SELF)).toBeNull();
    // Case-insensitive — protect against lowercase variants.
    expect(resolveImportantPointSpeaker('speaker B', SELF)).toBeNull();
  });

  it('returns null for empty / non-string / whitespace inputs', () => {
    expect(resolveImportantPointSpeaker(null, SELF)).toBeNull();
    expect(resolveImportantPointSpeaker(undefined, SELF)).toBeNull();
    expect(resolveImportantPointSpeaker('', SELF)).toBeNull();
    expect(resolveImportantPointSpeaker('   ', SELF)).toBeNull();
    expect(resolveImportantPointSpeaker(0, SELF)).toBeNull();
  });

  it('without selfName, returns the raw value (other participants stay attributed)', () => {
    expect(resolveImportantPointSpeaker('Shubham', null)).toBe('Shubham');
    expect(resolveImportantPointSpeaker('Rishi', '')).toBe('Rishi');
  });

  it('does NOT promote on substring-only matches (only token boundaries)', () => {
    // "Sh" appears inside "Shubham" — must NOT promote, that would
    // misattribute every short fragment to the user.
    expect(resolveImportantPointSpeaker('Sh', SELF)).toBe('Sh');
    // "ham" appears inside "Shubham" — same protection.
    expect(resolveImportantPointSpeaker('ham', SELF)).toBe('ham');
    // "Pilivkar" alone is the last-name token — current rule only
    // promotes on first-name / exact match; documents the boundary.
    expect(resolveImportantPointSpeaker('Pilivkar', SELF)).toBe('Pilivkar');
  });

  it('trims whitespace before comparison', () => {
    expect(resolveImportantPointSpeaker('  Shubham  ', SELF)).toBe(SELF);
  });
});


describe('loadDisplayName (async, reads storage)', () => {
  beforeEach(() => {
    vi.mocked(chrome.storage.local.get).mockReset();
  });

  it('prefers stored mm_user_name over email derivation', async () => {
    mockStorageWith({
      [StorageKey.USER_NAME]: 'Shubham Pilivkar',
      [StorageKey.USER_EMAIL]: 'shubhampilivkar@gmail.com',
    });
    expect(await loadDisplayName()).toBe('Shubham Pilivkar');
  });

  it('falls back to email when mm_user_name absent', async () => {
    mockStorageWith({
      [StorageKey.USER_NAME]: undefined,
      [StorageKey.USER_EMAIL]: 'shubham.pilivkar@meetminutes.in',
    });
    expect(await loadDisplayName()).toBe('Shubham Pilivkar');
  });

  it('returns empty when signed out (no name + no email)', async () => {
    mockStorageWith({
      [StorageKey.USER_NAME]: undefined,
      [StorageKey.USER_EMAIL]: undefined,
    });
    expect(await loadDisplayName()).toBe('');
  });

  it('storage throwing returns empty (never blocks the caller)', async () => {
    vi.mocked(chrome.storage.local.get).mockImplementationOnce(async () => {
      throw new Error('storage unavailable');
    });
    expect(await loadDisplayName()).toBe('');
  });
});
