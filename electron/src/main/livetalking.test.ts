import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import {
  DEFAULT_AVATAR_COMPANION_PREFS,
  isLoopbackUrl,
  readAvatarCompanionPrefs,
  writeAvatarCompanionPrefs,
} from './livetalking';
import type { ElectronConfigStore } from '../psb/store';

function memoryStore(initial?: Record<string, unknown>): ElectronConfigStore {
  const data = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    get: (key: string) => data.get(key),
    set: (key: string, value: unknown) => {
      data.set(key, value);
    },
  } as ElectronConfigStore;
}

describe('isLoopbackUrl', () => {
  it('accepts loopback http urls', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8010')).toBe(true);
    expect(isLoopbackUrl('http://localhost:8010/')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8010')).toBe(true);
  });

  it('rejects remote urls and invalid input', () => {
    expect(isLoopbackUrl('http://192.168.1.5:8010')).toBe(false);
    expect(isLoopbackUrl('https://example.com')).toBe(false);
    expect(isLoopbackUrl('file:///etc/passwd')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
    expect(isLoopbackUrl('')).toBe(false);
  });
});

describe('avatar companion prefs', () => {
  it('returns defaults when store is empty', () => {
    const store = memoryStore();
    expect(readAvatarCompanionPrefs(store)).toEqual(DEFAULT_AVATAR_COMPANION_PREFS);
  });

  it('persists patches and merges with current values', () => {
    const store = memoryStore();
    const next = writeAvatarCompanionPrefs(store, { enabled: true });
    expect(next.enabled).toBe(true);
    expect(readAvatarCompanionPrefs(store).enabled).toBe(true);
  });

  it('rejects non-loopback server url by keeping the previous value', () => {
    const store = memoryStore();
    writeAvatarCompanionPrefs(store, { serverUrl: 'http://127.0.0.1:8010' });
    const next = writeAvatarCompanionPrefs(store, { serverUrl: 'http://10.0.0.1:8010' });
    expect(next.serverUrl).toBe('http://127.0.0.1:8010');
  });

  it('clamps timeout into a sane range', () => {
    const store = memoryStore();
    expect(writeAvatarCompanionPrefs(store, { timeoutMs: 1 }).timeoutMs).toBe(500);
    expect(writeAvatarCompanionPrefs(store, { timeoutMs: 999_999 }).timeoutMs).toBe(30_000);
  });
});
