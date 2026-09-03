import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import {
  DEFAULT_AVATAR_COMPANION_PREFS,
  avatarVideoUrls,
  currentAvatarTimeSegment,
  isLoopbackUrl,
  readAvatarCompanionPrefs,
  registerLivetalkingIpcHandlers,
  writeAvatarCompanionPrefs,
} from './livetalking';
import type { ElectronConfigStore } from '../psb/store';

const tempDirectories: string[] = [];

afterEach(() => {
  tempDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

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

  it('selects the latest configured time segment and wraps after midnight', () => {
    const schedule = { sunrise: '05:00', day: '10:00', sunset: '18:00', night: '22:00' } as const;
    expect(currentAvatarTimeSegment(new Date(2026, 0, 1, 6, 0), schedule)).toBe('sunrise');
    expect(currentAvatarTimeSegment(new Date(2026, 0, 1, 12, 0), schedule)).toBe('day');
    expect(currentAvatarTimeSegment(new Date(2026, 0, 1, 20, 0), schedule)).toBe('sunset');
    expect(currentAvatarTimeSegment(new Date(2026, 0, 1, 23, 0), schedule)).toBe('night');
    expect(currentAvatarTimeSegment(new Date(2026, 0, 1, 2, 0), schedule)).toBe('night');
  });

  it('normalizes invalid time schedule values to defaults', () => {
    const store = memoryStore({ avatarCompanion: { timeSchedule: { sunrise: 'invalid', day: '09:30' } } });
    expect(readAvatarCompanionPrefs(store).timeSchedule).toEqual({
      sunrise: '05:00',
      day: '09:30',
      sunset: '18:00',
      night: '22:00',
    });
  });
});

describe('avatar companion video directory', () => {
  it('loads a unique scene pack selected through its parent directory', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'nanobot-avatar-'));
    tempDirectories.push(parent);
    const scene = path.join(parent, 'scene');
    mkdirSync(path.join(scene, 'idle', 'day'), { recursive: true });
    mkdirSync(path.join(scene, 'working', 'day'), { recursive: true });
    writeFileSync(path.join(scene, 'idle', 'day', 'idle.mp4'), '');
    writeFileSync(path.join(scene, 'working', 'day', 'work.mp4'), '');
    const store = memoryStore({ avatarCompanion: { videoDirectory: parent } });
    registerLivetalkingIpcHandlers({ store });

    const videos = avatarVideoUrls(new Date(2026, 0, 1, 12, 0));
    expect(videos.directoryError).toBeNull();
    expect(videos.idle[0]).toContain('/scene/idle/day/idle.mp4');
    expect(videos.working[0]).toContain('/scene/working/day/work.mp4');
  });

  it('falls back per mode when one new-format directory is empty', () => {
    const scene = mkdtempSync(path.join(tmpdir(), 'nanobot-avatar-'));
    tempDirectories.push(scene);
    mkdirSync(path.join(scene, 'idle', 'day'), { recursive: true });
    mkdirSync(path.join(scene, 'working', 'day'), { recursive: true });
    writeFileSync(path.join(scene, 'idle', 'day', 'idle.mp4'), '');
    writeFileSync(path.join(scene, '工作-思考中.mp4'), '');
    const store = memoryStore({ avatarCompanion: { videoDirectory: scene } });
    registerLivetalkingIpcHandlers({ store });

    const videos = avatarVideoUrls(new Date(2026, 0, 1, 12, 0));
    expect(videos.idle[0]).toContain('/idle/day/idle.mp4');
    expect(videos.working[0]).toContain(encodeURIComponent('工作-思考中.mp4'));
  });
});
