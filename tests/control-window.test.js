import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  openControlWindow, closeControlWindow, handleWindowRemoved,
} from '../src/lib/control-window.js';
import { StorageKey } from '../src/constants.js';

const KEY = StorageKey.CONTROL_WINDOW_ID;

function mockChrome({ windows = true } = {}) {
  const store = new Map();
  let nextId = 100;
  const live = new Set();
  const chrome = {
    runtime: { getURL: (p) => `chrome-extension://x/${p}` },
    storage: {
      local: {
        get: vi.fn(async (k) => (store.has(k) ? { [k]: store.get(k) } : {})),
        set: vi.fn(async (o) => { for (const [k, v] of Object.entries(o)) store.set(k, v); }),
        remove: vi.fn(async (k) => { store.delete(k); }),
      },
    },
  };
  if (windows) {
    chrome.windows = {
      create: vi.fn(async () => { const id = nextId++; live.add(id); return { id }; }),
      get: vi.fn(async (id) => {
        if (!live.has(id)) throw new Error('No window with id');
        return { id };
      }),
      update: vi.fn(async () => {}),
      remove: vi.fn(async (id) => { live.delete(id); }),
    };
  }
  chrome.__store = store;
  chrome.__live = live;
  return chrome;
}

describe('control-window', () => {
  let prev;
  beforeEach(() => { prev = globalThis.chrome; });
  afterEach(() => { globalThis.chrome = prev; });

  it('opens once and tracks the window id', async () => {
    const c = mockChrome();
    globalThis.chrome = c;
    await openControlWindow();
    expect(c.windows.create).toHaveBeenCalledTimes(1);
    expect(c.__store.get(KEY)).toBe(100);
  });

  it('focuses the existing window instead of duplicating', async () => {
    const c = mockChrome();
    globalThis.chrome = c;
    await openControlWindow();
    await openControlWindow();
    expect(c.windows.create).toHaveBeenCalledTimes(1);
    expect(c.windows.update).toHaveBeenCalledWith(100, { focused: true });
  });

  it('re-creates if the tracked window was closed', async () => {
    const c = mockChrome();
    globalThis.chrome = c;
    await openControlWindow();
    c.__live.delete(100); // user closed it
    await openControlWindow();
    expect(c.windows.create).toHaveBeenCalledTimes(2);
    expect(c.__store.get(KEY)).toBe(101);
  });

  it('closeControlWindow removes the window and clears tracking', async () => {
    const c = mockChrome();
    globalThis.chrome = c;
    await openControlWindow();
    await closeControlWindow();
    expect(c.windows.remove).toHaveBeenCalledWith(100);
    expect(c.__store.has(KEY)).toBe(false);
  });

  it('closeControlWindow is a safe no-op when nothing is open', async () => {
    const c = mockChrome();
    globalThis.chrome = c;
    await expect(closeControlWindow()).resolves.toBeUndefined();
    expect(c.windows.remove).not.toHaveBeenCalled();
  });

  it('handleWindowRemoved clears only the matching id', async () => {
    const c = mockChrome();
    globalThis.chrome = c;
    await openControlWindow(); // id 100
    await handleWindowRemoved(999);
    expect(c.__store.get(KEY)).toBe(100); // unrelated window
    await handleWindowRemoved(100);
    expect(c.__store.has(KEY)).toBe(false);
  });

  it('never throws when chrome.windows is unavailable', async () => {
    const c = mockChrome({ windows: false });
    globalThis.chrome = c;
    await expect(openControlWindow()).resolves.toBeUndefined();
    await expect(closeControlWindow()).resolves.toBeUndefined();
  });
});
