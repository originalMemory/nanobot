// LiveTalking 本地数字人服务客户端（主进程）
// 仅允许回环地址；渲染层经 preload IPC 调用，不得直连任意远程服务。
import { ipcMain } from 'electron';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { ElectronConfigStore } from '../psb/store';

export type AvatarCompanionPrefs = {
  enabled: boolean;
  /** LiveTalking 服务地址，必须为本机回环 */
  serverUrl: string;
  /** 音频提交/健康检查超时（毫秒） */
  timeoutMs: number;
  /** 新格式场景包根目录；为空时回退打包内旧素材目录。 */
  videoDirectory: string;
  /** 四个时间段的起始时间，格式 HH:mm。 */
  timeSchedule: Record<AvatarTimeSegment, string>;
};

export type AvatarTimeSegment = 'sunrise' | 'day' | 'sunset' | 'night';

export const DEFAULT_AVATAR_TIME_SCHEDULE: Record<AvatarTimeSegment, string> = {
  sunrise: '05:00',
  day: '10:00',
  sunset: '18:00',
  night: '22:00',
};

export type AvatarCompanionStatus = {
  reachable: boolean;
  lastCheckedAtMs: number | null;
  lastError: string | null;
};

export const DEFAULT_AVATAR_COMPANION_PREFS: AvatarCompanionPrefs = {
  enabled: false,
  serverUrl: 'http://127.0.0.1:8010',
  timeoutMs: 3000,
  videoDirectory: '',
  timeSchedule: DEFAULT_AVATAR_TIME_SCHEDULE,
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const LEGACY_AVATAR_VIDEOS = {
  idle: ['待机-呼吸.mp4', '待机-摸下巴.mp4', '待机-轻拂发丝.mp4', '待机-轻拂锁骨.mp4', '待机-整理衣领.mp4'],
  working: ['工作-翻阅文件.mp4', '工作-记录书写.mp4', '工作-敲键盘.mp4', '工作-思考中.mp4'],
} as const;

function parseTime(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return fallback;
  return value;
}

function normalizeTimeSchedule(value: unknown): Record<AvatarTimeSegment, string> {
  const raw = value && typeof value === 'object' ? value as Partial<Record<AvatarTimeSegment, unknown>> : {};
  return {
    sunrise: parseTime(raw.sunrise, DEFAULT_AVATAR_TIME_SCHEDULE.sunrise),
    day: parseTime(raw.day, DEFAULT_AVATAR_TIME_SCHEDULE.day),
    sunset: parseTime(raw.sunset, DEFAULT_AVATAR_TIME_SCHEDULE.sunset),
    night: parseTime(raw.night, DEFAULT_AVATAR_TIME_SCHEDULE.night),
  };
}

export function currentAvatarTimeSegment(
  now = new Date(),
  schedule: Record<AvatarTimeSegment, string> = DEFAULT_AVATAR_TIME_SCHEDULE,
): AvatarTimeSegment {
  const current = now.getHours() * 60 + now.getMinutes();
  const entries = (Object.entries(schedule) as [AvatarTimeSegment, string][])
    .map(([segment, value]) => {
      const [hours, minutes] = value.split(':').map(Number);
      return [segment, hours * 60 + minutes] as const;
    })
    .sort((a, b) => a[1] - b[1]);
  const active = entries.filter(([, start]) => start <= current).at(-1);
  return active?.[0] ?? entries.at(-1)?.[0] ?? 'night';
}

type VideoDirectoryError = 'not_found' | 'invalid_structure' | 'multiple_scene_packs' | null;

function isScenePack(directory: string): boolean {
  return existsSync(path.join(directory, 'idle')) && existsSync(path.join(directory, 'working'));
}

function videoRoot(configured: string): { root: string; error: VideoDirectoryError } {
  const bundledRoot = process.resourcesPath
    ? path.join(process.resourcesPath, 'avatar-videos')
    : path.resolve(__dirname, '../../avatar-videos');
  const fallback = [
    bundledRoot,
    path.resolve(__dirname, '../../avatar-videos'),
  ].find(existsSync) ?? path.join(process.resourcesPath, 'avatar-videos');
  const preferred = configured.trim();
  if (!preferred) return { root: fallback, error: null };
  if (!existsSync(preferred)) return { root: fallback, error: 'not_found' };
  if (isScenePack(preferred)) return { root: preferred, error: null };
  const scenePacks = readdirSync(preferred, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isScenePack(path.join(preferred, entry.name)))
    .map((entry) => path.join(preferred, entry.name));
  if (scenePacks.length === 1) return { root: scenePacks[0], error: null };
  return { root: fallback, error: scenePacks.length > 1 ? 'multiple_scene_packs' : 'invalid_structure' };
}

function legacyVideoRoot(preferred: string): string {
  const bundledRoot = process.resourcesPath
    ? path.join(process.resourcesPath, 'avatar-videos')
    : path.resolve(__dirname, '../../avatar-videos');
  const candidates = [
    preferred,
    bundledRoot,
    path.resolve(__dirname, '../../avatar-videos'),
  ];
  return candidates.find((candidate) =>
    Object.values(LEGACY_AVATAR_VIDEOS).flat().some((file) => existsSync(path.join(candidate, file))),
  ) ?? candidates[0];
}

function listVideos(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => /\.(mp4|webm|mov)$/i.test(file))
    .sort()
    .map((file) => pathToFileURL(path.join(directory, file)).href);
}

function legacyVideoUrls(mode: keyof typeof LEGACY_AVATAR_VIDEOS, preferred: string): string[] {
  const root = legacyVideoRoot(preferred);
  return LEGACY_AVATAR_VIDEOS[mode]
    .filter((file) => existsSync(path.join(root, file)))
    .map((file) => pathToFileURL(path.join(root, file)).href);
}

export function avatarVideoUrls(now = new Date()): {
  idle: string[];
  working: string[];
  segment: AvatarTimeSegment;
  directoryError: VideoDirectoryError;
} {
  const prefs = readAvatarCompanionPrefs(requireDeps().store);
  const { root, error: directoryError } = videoRoot(prefs.videoDirectory);
  const segment = currentAvatarTimeSegment(now, prefs.timeSchedule);
  const idle = listVideos(path.join(root, 'idle', segment));
  const working = listVideos(path.join(root, 'working', segment));
  return {
    idle: idle.length ? idle : legacyVideoUrls('idle', root),
    working: working.length ? working : legacyVideoUrls('working', root),
    segment,
    directoryError,
  };
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function readAvatarCompanionPrefs(store: ElectronConfigStore): AvatarCompanionPrefs {
  const stored = store.get('avatarCompanion') as Partial<AvatarCompanionPrefs> | undefined;
  return {
    enabled: stored?.enabled ?? DEFAULT_AVATAR_COMPANION_PREFS.enabled,
    serverUrl: stored?.serverUrl ?? DEFAULT_AVATAR_COMPANION_PREFS.serverUrl,
    timeoutMs: stored?.timeoutMs ?? DEFAULT_AVATAR_COMPANION_PREFS.timeoutMs,
    videoDirectory: typeof stored?.videoDirectory === 'string' ? stored.videoDirectory : '',
    timeSchedule: normalizeTimeSchedule(stored?.timeSchedule),
  };
}

export function writeAvatarCompanionPrefs(
  store: ElectronConfigStore,
  patch: Partial<AvatarCompanionPrefs>,
): AvatarCompanionPrefs {
  const current = readAvatarCompanionPrefs(store);
  const next = { ...current, ...patch };
  if (!isLoopbackUrl(next.serverUrl)) next.serverUrl = current.serverUrl;
  next.timeoutMs = Math.min(30_000, Math.max(500, Math.floor(next.timeoutMs)));
  store.set('avatarCompanion', next);
  return next;
}

type LiveTalkingDeps = {
  store: ElectronConfigStore;
};

const status: AvatarCompanionStatus = {
  reachable: false,
  lastCheckedAtMs: null,
  lastError: null,
};

function baseUrl(): string {
  const prefs = readAvatarCompanionPrefs(requireDeps().store);
  return prefs.serverUrl.replace(/\/+$/, '');
}

let deps: LiveTalkingDeps | null = null;

function requireDeps(): LiveTalkingDeps {
  if (!deps) throw new Error('livetalking ipc not registered');
  return deps;
}

async function fetchJson(path: string, init?: RequestInit, timeoutOverrideMs?: number): Promise<unknown> {
  const prefs = readAvatarCompanionPrefs(requireDeps().store);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutOverrideMs ?? prefs.timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${path}`, { ...init, signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function registerLivetalkingIpcHandlers(depsIn: LiveTalkingDeps): void {
  deps = depsIn;

  ipcMain.handle('livetalking:local-videos', () => avatarVideoUrls());

  ipcMain.handle('livetalking:check-health', async () => {
    const prefs = readAvatarCompanionPrefs(requireDeps().store);
    if (!isLoopbackUrl(prefs.serverUrl)) {
      status.reachable = false;
      status.lastError = 'disabled or non-loopback url';
      return { ...status };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), prefs.timeoutMs);
    try {
      const res = await fetch(baseUrl(), { signal: controller.signal });
      status.reachable = res.ok;
      status.lastError = res.ok ? null : `HTTP ${res.status}`;
    } catch (err) {
      status.reachable = false;
      status.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
      status.lastCheckedAtMs = Date.now();
    }
    return { ...status };
  });

  ipcMain.handle('livetalking:set-audiotype', (_event, sessionid: string, audiotype: number) => {
    return fetchJson('/set_audiotype', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionid, audiotype }),
    });
  });

  ipcMain.handle('livetalking:interrupt', (_event, sessionid: string) => {
    return fetchJson('/interrupt_talk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionid }),
    });
  });

  ipcMain.handle('livetalking:audiostream-start', (_event, sessionid: string, sampleRate: number) => {
    return fetchJson('/audiostream/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionid, sample_rate: sampleRate }),
    });
  });

  // PCM 二进制块转发：渲染层传 ArrayBuffer(s16le 原始采样率)
  ipcMain.handle('livetalking:audiostream-chunk', (_event, sessionid: string, data: ArrayBuffer) => {
    return fetchJson(`/audiostream/${encodeURIComponent(sessionid)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(data),
    });
  });

  ipcMain.handle('livetalking:audiostream-finish', (_event, sessionid: string) => {
    return fetchJson('/audiostream/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionid }),
    });
  });

  ipcMain.handle('livetalking:is-speaking', (_event, sessionid: string) => {
    return fetchJson('/is_speaking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionid }),
    });
  });

  ipcMain.handle('livetalking:offer', async (_event, sdp: string, avatar?: string) => {
    // SDP 协商含 ICE 候选收集，服务端耗时可达 5-10s，不吃全局短超时
    return fetchJson('/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp, type: 'offer', ...(avatar ? { avatar } : {}) }),
    }, 20_000);
  });
}

export function getLivetalkingStatus(): AvatarCompanionStatus {
  return { ...status };
}
