import { BrowserWindow, ipcMain, screen } from 'electron';

import { shouldAutoOpenPsb } from '../psb/auto-show';
import {
  MOUSE_TRACK_INTERVAL_MS,
  screenToContentPoint,
  shouldForwardMouse,
} from '../psb/mouse-tracker';
import {
  clearPsbSessionClose,
  readDeskPetPrefs,
  setPsbTemporarilyClosed,
  writePsbWindowState,
  type ElectronConfigStore,
} from '../psb/store';
import type {
  DeskPetLocalPrefs,
  PsbOpenConfig,
  PsbRuntimeAction,
} from '../psb/types';
import { validatePsbOpenConfig } from '../psb/validate';

type GatewayConfig = {
  url: string;
  token: string;
};

type PsbManagerDeps = {
  store: ElectronConfigStore;
  getGateway: () => GatewayConfig;
  preloadPath: string;
};

let psbWindow: BrowserWindow | null = null;
let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null;
let mouseTrackTimer: ReturnType<typeof setInterval> | null = null;
let followMouseEnabled = true;

function activePsbWindow(): BrowserWindow | null {
  if (!psbWindow || psbWindow.isDestroyed()) {
    psbWindow = null;
    return null;
  }
  return psbWindow;
}

function defaultPsbBounds(width: number, height: number) {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width,
    height,
    x: Math.max(0, screenWidth - width - 32),
    y: Math.max(0, screenHeight - height - 32),
  };
}

function buildPsbPageUrl(config: PsbOpenConfig): string {
  const target = new URL('/psb.html', config.url);
  if (config.token) target.searchParams.set('token', config.token);
  if (config.modelId) target.searchParams.set('modelId', config.modelId);
  return target.toString();
}

async function fetchDeskPetPsbSettings(
  gateway: GatewayConfig,
): Promise<Record<string, unknown> | null> {
  if (!gateway.url.trim() || !gateway.token.trim()) return null;
  try {
    const response = await fetch(new URL('/api/settings', gateway.url).toString(), {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { deskPet?: { psb?: Record<string, unknown> } };
    return payload.deskPet?.psb ?? null;
  } catch {
    return null;
  }
}

async function setServerAutoShow(gateway: GatewayConfig, autoShow: boolean): Promise<boolean> {
  if (!gateway.url.trim() || !gateway.token.trim()) return false;
  const url = new URL('/api/settings/desk-pet/psb/update', gateway.url);
  url.searchParams.set('autoShow', autoShow ? 'true' : 'false');
  try {
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

function scheduleSaveWindowBounds(store: ElectronConfigStore, window: BrowserWindow) {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (window.isDestroyed()) return;
    const { x, y, width, height } = window.getBounds();
    writePsbWindowState(store, { x, y, width, height });
  }, 500);
}

function stopMouseTracking(): void {
  if (mouseTrackTimer) {
    clearInterval(mouseTrackTimer);
    mouseTrackTimer = null;
  }
}

function startMouseTracking(window: BrowserWindow): void {
  stopMouseTracking();
  mouseTrackTimer = setInterval(() => {
    const active = activePsbWindow();
    if (!active || active.id !== window.id) return;
    if (
      !shouldForwardMouse({
        followMouse: followMouseEnabled,
        windowVisible: active.isVisible(),
        windowDestroyed: active.isDestroyed(),
      })
    ) {
      return;
    }
    const point = screen.getCursorScreenPoint();
    const bounds = active.getContentBounds();
    const pos = screenToContentPoint(point, bounds);
    active.webContents.send('psb:mouse', pos);
  }, MOUSE_TRACK_INTERVAL_MS);
}

async function syncFollowMouseFromServer(gateway: GatewayConfig): Promise<void> {
  const psb = await fetchDeskPetPsbSettings(gateway);
  if (psb && typeof psb.followMouse === 'boolean') {
    followMouseEnabled = psb.followMouse;
  }
}

function attachWindowPersistence(store: ElectronConfigStore, window: BrowserWindow) {
  const save = () => scheduleSaveWindowBounds(store, window);
  window.on('resize', save);
  window.on('move', save);
  window.on('closed', () => {
    psbWindow = null;
    stopMouseTracking();
  });
  window.on('hide', () => {
    window.webContents.send('psb:mouse', { leave: true });
  });
}

function createPsbBrowserWindow(
  store: ElectronConfigStore,
  preloadPath: string,
  config: PsbOpenConfig,
): BrowserWindow {
  const prefs = readDeskPetPrefs(store).psb.window;
  const width = config.width ?? prefs.width;
  const height = config.height ?? prefs.height;
  const bounds =
    prefs.x !== undefined && prefs.y !== undefined
      ? { x: prefs.x, y: prefs.y, width, height }
      : defaultPsbBounds(width, height);

  const window = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    acceptFirstMouse: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      preload: preloadPath,
    },
  });

  attachWindowPersistence(store, window);
  void window.loadURL(buildPsbPageUrl(config));
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show();
      window.webContents.send('psb:config', {
        scale: prefs.scale,
        followMouse: followMouseEnabled,
      });
      startMouseTracking(window);
    }
  });
  window.setIgnoreMouseEvents(false);
  psbWindow = window;
  setPsbTemporarilyClosed(store, false);
  return window;
}

export async function openPsbWindow(
  store: ElectronConfigStore,
  preloadPath: string,
  config: PsbOpenConfig,
): Promise<{ ok: true; id: number; reused: boolean } | { ok: false; error: string }> {
  const validated = validatePsbOpenConfig(config);
  if ('error' in validated) {
    return { ok: false, error: validated.error };
  }

  const openConfig = validated.value;
  const gateway = { url: openConfig.url, token: openConfig.token || '' };
  const existing = activePsbWindow();
  if (existing) {
    await syncFollowMouseFromServer(gateway);
    await existing.loadURL(buildPsbPageUrl(openConfig));
    existing.show();
    existing.focus();
    existing.webContents.send('psb:config', { followMouse: followMouseEnabled });
    startMouseTracking(existing);
    setPsbTemporarilyClosed(store, false);
    return { ok: true, id: existing.id, reused: true };
  }

  await syncFollowMouseFromServer(gateway);
  const window = createPsbBrowserWindow(store, preloadPath, openConfig);
  return { ok: true, id: window.id, reused: false };
}

export function closePsbWindow(store: ElectronConfigStore, permanent: boolean): void {
  const window = activePsbWindow();
  if (window) {
    window.close();
    psbWindow = null;
  }
  if (permanent) {
    setPsbTemporarilyClosed(store, false);
    return;
  }
  setPsbTemporarilyClosed(store, true);
}

export function closeAllPsbWindows(): void {
  const window = activePsbWindow();
  if (window) {
    window.close();
    psbWindow = null;
  }
}

export function sendPsbRuntimeAction(action: PsbRuntimeAction): boolean {
  const window = activePsbWindow();
  if (!window) return false;
  window.webContents.send('psb:action', action);
  return true;
}

const AUTO_OPEN_MAX_ATTEMPTS = 15;
const AUTO_OPEN_RETRY_MS = 2000;

let autoOpenCompleted = false;
let autoOpenInFlight: Promise<void> | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 启动时尝试自动打开 PSB；gateway 未就绪时会重试，renderer 连上后也会再触发一次。 */
export async function scheduleAutoOpenPsb(
  store: ElectronConfigStore,
  preloadPath: string,
  gateway: GatewayConfig,
): Promise<void> {
  if (autoOpenCompleted || activePsbWindow()) return;
  if (autoOpenInFlight) return autoOpenInFlight;

  autoOpenInFlight = (async () => {
    clearPsbSessionClose(store);
    if (activePsbWindow()) return;

    if (!gateway.url.trim()) return;

    for (let attempt = 0; attempt < AUTO_OPEN_MAX_ATTEMPTS; attempt += 1) {
      if (autoOpenCompleted || activePsbWindow()) return;

      const psb = await fetchDeskPetPsbSettings(gateway);
      if (psb) {
        if (!psb.autoShow) return;
        const prefs = readDeskPetPrefs(store);
        if (!shouldAutoOpenPsb(psb, prefs.psb.temporarilyClosed)) return;

        const selected = String(psb.selectedModelId || '');
        const result = await openPsbWindow(store, preloadPath, {
          url: gateway.url,
          token: gateway.token,
          modelId: selected,
        });
        if (result.ok) autoOpenCompleted = true;
        return;
      }

      if (!gateway.token.trim() && attempt === 0) {
        // token 可能尚未由 renderer bootstrap 写入，继续重试
      }
      await delay(AUTO_OPEN_RETRY_MS);
    }
  })().finally(() => {
    autoOpenInFlight = null;
  });

  return autoOpenInFlight;
}

/** @deprecated 使用 scheduleAutoOpenPsb */
export async function maybeAutoOpenPsb(
  store: ElectronConfigStore,
  preloadPath: string,
  gateway: GatewayConfig,
): Promise<void> {
  return scheduleAutoOpenPsb(store, preloadPath, gateway);
}

export function cleanupPsbOnQuit(): void {
  closeAllPsbWindows();
  stopMouseTracking();
  if (saveBoundsTimer) {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = null;
  }
}

export function registerPsbIpcHandlers(deps: PsbManagerDeps): void {
  const { store, getGateway, preloadPath } = deps;

  ipcMain.handle('psb:open', (_event, config: PsbOpenConfig) =>
    openPsbWindow(store, preloadPath, config),
  );

  ipcMain.handle('psb:close', () => {
    closePsbWindow(store, false);
  });

  ipcMain.handle('psb:close-permanent', async () => {
    const gateway = getGateway();
    await setServerAutoShow(gateway, false);
    closePsbWindow(store, true);
    return { ok: true };
  });

  ipcMain.handle('psb:close-all', () => {
    closeAllPsbWindows();
    setPsbTemporarilyClosed(store, true);
  });

  ipcMain.handle(
    'psb:save-window-state',
    (_event, patch: { x?: number; y?: number; width?: number; height?: number; scale?: number }) => {
      if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid_state' };
      const next = writePsbWindowState(store, patch);
      const window = activePsbWindow();
      if (window && (patch.x !== undefined || patch.y !== undefined || patch.width !== undefined || patch.height !== undefined)) {
        window.setBounds({
          x: patch.x ?? window.getBounds().x,
          y: patch.y ?? window.getBounds().y,
          width: patch.width ?? window.getBounds().width,
          height: patch.height ?? window.getBounds().height,
        });
      }
      if (window && patch.scale !== undefined) {
        window.webContents.send('psb:config', { scale: patch.scale });
      }
      return { ok: true, state: next };
    },
  );

  ipcMain.handle('psb:send-action', (_event, action: PsbRuntimeAction) => ({
    ok: sendPsbRuntimeAction(action),
  }));

  ipcMain.handle('psb:update-follow-mouse', async (_event, enabled: unknown) => {
    const next = !!enabled;
    followMouseEnabled = next;
    const gateway = getGateway();
    if (gateway.url.trim() && gateway.token.trim()) {
      const url = new URL('/api/settings/desk-pet/psb/update', gateway.url);
      url.searchParams.set('followMouse', next ? 'true' : 'false');
      try {
        await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${gateway.token}` },
        });
      } catch {
        return { ok: false };
      }
    }
    const window = activePsbWindow();
    if (window) {
      window.webContents.send('psb:config', { followMouse: next });
    }
    return { ok: true, followMouse: next };
  });

  ipcMain.handle(
    'psb:set-ignore-mouse-events',
    (event, ignore: boolean, options?: { forward?: boolean }) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed() || window !== activePsbWindow()) return;
      window.setIgnoreMouseEvents(ignore, options);
    },
  );

  ipcMain.handle('psb:try-auto-open', () => {
    const gateway = getGateway();
    return scheduleAutoOpenPsb(store, preloadPath, gateway);
  });
}

export type { DeskPetLocalPrefs };
