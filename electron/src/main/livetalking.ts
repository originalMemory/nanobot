// LiveTalking 本地数字人服务客户端（主进程）
// 仅允许回环地址；渲染层经 preload IPC 调用，不得直连任意远程服务。
import { ipcMain } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { ElectronConfigStore } from '../psb/store';

export type AvatarCompanionPrefs = {
  enabled: boolean;
  /** LiveTalking 服务地址，必须为本机回环 */
  serverUrl: string;
  /** 音频提交/健康检查超时（毫秒） */
  timeoutMs: number;
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
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const AVATAR_VIDEOS = {
  idle: ['待机-呼吸.mp4', '待机-摸下巴.mp4', '待机-轻拂发丝.mp4', '待机-轻拂锁骨.mp4', '待机-整理衣领.mp4'],
  working: ['工作-翻阅文件.mp4', '工作-记录书写.mp4', '工作-敲键盘.mp4', '工作-思考中.mp4'],
} as const;

function avatarVideoUrls(): Record<keyof typeof AVATAR_VIDEOS, string[]> {
  const candidates = [
    path.join(process.resourcesPath, 'avatar-videos'),
    path.resolve(__dirname, '../../avatar-videos'),
  ];
  const root = candidates.find(existsSync) ?? candidates[0];
  return Object.fromEntries(
    Object.entries(AVATAR_VIDEOS).map(([mode, files]) => [
      mode,
      files.map((file) => pathToFileURL(path.join(root, file)).href),
    ]),
  ) as Record<keyof typeof AVATAR_VIDEOS, string[]>;
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
