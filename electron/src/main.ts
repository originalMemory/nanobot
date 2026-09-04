import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  screen,
  shell,
  Tray,
} from 'electron';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import started from 'electron-squirrel-startup';

const SCREENSHOT_ACCELERATOR = 'CmdOrCtrl+Shift+S';
const DEFAULT_RAISE_INBOX_ACCELERATOR = 'CmdOrCtrl+Shift+E';
const DEFAULT_WALLPAPER_URL =
  'https://nas.xuanniao.fun:49150/api/moneyAccounting/random-image?type=1,2,3&level=5,6,7,8&orientation=2&maxResolutionLevel=2';
const MIN_WALLPAPER_INTERVAL_MINUTES = 1;
const WINDOWS_TOAST_ACTIVATOR_CLSID = '{D405C197-DC97-4A6C-ACD8-3D10BCBD5365}';
import { DEFAULT_PSB_LOCAL_PREFS, type DeskPetLocalPrefs } from './psb/types';
import { cleanupPsbOnQuit, registerPsbIpcHandlers } from './main/psb-manager';
import { registerLivetalkingIpcHandlers } from './main/livetalking';
import { registerSystemMediaIpcHandlers } from './main/system-media';
import Store from 'electron-store';
import { APP_ID, APP_NAME } from '../app.meta';
import {
  clearTrayUnread,
  disposeTrayStatus,
  initTrayStatus,
  notifyTrayIncoming,
  refreshTrayStatus,
  setTrayStreaming,
  type TrayStatusIcons,
} from './tray-status';
import {
  notificationBody,
  type NativeNotificationPayload,
} from './notification-text';
import {
  listWallpaperImages,
  localWallpaperCandidateIndices,
  wallpaperDirectoryKey,
  wallpaperFileToDataUrl,
  type WallpaperConfig,
  type WallpaperLocalOrder,
  type WallpaperSource,
} from './wallpaper';
import {
  captureWindowsForegroundWindow,
  nativeWindowHandleValue,
  restoreWindowsForegroundWindow,
} from './windows-focus';

if (process.platform === 'win32') {
  app.setToastActivatorCLSID(WINDOWS_TOAST_ACTIVATOR_CLSID);
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// 开发模式使用独立的 userData 目录，避免与打包版共用单实例锁导致 npm start 唤起打包版窗口
if (!app.isPackaged) {
  app.setPath('userData', app.getPath('userData') + '-dev');
}

// 只允许单实例；再次启动时聚焦已有窗口（与托盘「显示」一致）
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // 第二实例尽快退出，避免残留 Chromium 子进程
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (app.isReady()) {
      showMainWindow();
      return;
    }
    void app.whenReady().then(showMainWindow);
  });
}

// ---------------------------------------------------------------------------
// Store schema (6.3)
// ---------------------------------------------------------------------------

interface LocalPreferences {
  density: 'comfortable' | 'compact';
  activityMode: 'auto' | 'expanded';
  codeWrap: boolean;
  brandLogos: boolean;
}

// Keep in sync with renderer: src/renderer/hooks/useTheme.ts → Theme
type Theme =
  | 'light' | 'dark' | 'midnight' | 'desert'
  | 'neon' | 'marshmallow' | 'ink' | 'party' | 'rainbow';

interface AppConfig {
  gateway: {
    url: string;
    token: string;
    chatId: string;
  };
  appearance: {
    theme: Theme;
    language: string;
    preferences: LocalPreferences;
    wallpaper: WallpaperConfig;
  };
  window: {
    x?: number;
    y?: number;
    width: number;
    height: number;
  };
  providers: Record<string, unknown>;
  models: Record<string, unknown>;
  shortcuts: {
    raiseInbox: string;
  };
  tts: {
    pauseSystemMedia: boolean;
  };
  deskPet: DeskPetLocalPrefs;
}

const store = new Store<AppConfig>({
  defaults: {
    gateway: {
      url: 'http://127.0.0.1:8765',
      token: '',
      chatId: 'electron-main',
    },
    appearance: {
      theme: 'light',
      language: '',
      preferences: {
        density: 'comfortable',
        activityMode: 'auto',
        codeWrap: true,
        brandLogos: true,
      },
      wallpaper: {
        source: 'url',
        url: DEFAULT_WALLPAPER_URL,
        directory: '',
        localOrder: 'sequential',
        localIndex: -1,
        intervalMinutes: 1,
      },
    },
    window: {
      width: 1200,
      height: 800,
    },
    providers: {},
    models: {},
    shortcuts: {
      raiseInbox: DEFAULT_RAISE_INBOX_ACCELERATOR,
    },
    tts: {
      pauseSystemMedia: false,
    },
    deskPet: DEFAULT_PSB_LOCAL_PREFS,
  },
});

const preloadPath = path.join(__dirname, 'preload.js');

registerPsbIpcHandlers({
  store,
  preloadPath,
  getGateway: () => ({
    url: store.get('gateway.url') ?? '',
    token: '',
  }),
});

registerLivetalkingIpcHandlers({ store });
const systemMediaController = registerSystemMediaIpcHandlers(store);

// ---------------------------------------------------------------------------
// IPC handlers (6.4)
// ---------------------------------------------------------------------------

ipcMain.handle('config:get', (_event, key: string) => {
  return store.get(key);
});

ipcMain.handle('config:set', (_event, key: string, value: unknown) => {
  store.set(key, value);
});

function getWallpaperConfig(): WallpaperConfig {
  const stored = store.get('appearance').wallpaper;
  const source: WallpaperSource = stored?.source === 'directory' ? 'directory' : 'url';
  const url =
    typeof stored?.url === 'string' ? stored.url.trim() : DEFAULT_WALLPAPER_URL;
  const directory = typeof stored?.directory === 'string' ? stored.directory.trim() : '';
  const localOrder: WallpaperLocalOrder = stored?.localOrder === 'random'
    ? 'random'
    : 'sequential';
  const localIndex = typeof stored?.localIndex === 'number' && Number.isInteger(stored.localIndex)
    ? stored.localIndex
    : -1;
  const rawInterval =
    typeof stored?.intervalMinutes === 'number' ? stored.intervalMinutes : 1;
  const intervalMinutes = Math.max(
    MIN_WALLPAPER_INTERVAL_MINUTES,
    Math.floor(rawInterval) || MIN_WALLPAPER_INTERVAL_MINUTES,
  );
  return { source, url, directory, localOrder, localIndex, intervalMinutes };
}

ipcMain.handle('wallpaper:get-config', (): WallpaperConfig => getWallpaperConfig());

ipcMain.handle('wallpaper:set-config', (_event, config: WallpaperConfig): WallpaperConfig => {
  const previous = getWallpaperConfig();
  const source: WallpaperSource = config.source === 'directory' ? 'directory' : 'url';
  const url = typeof config.url === 'string' ? config.url.trim() : '';
  const directory = typeof config.directory === 'string' ? config.directory.trim() : '';
  const localOrder: WallpaperLocalOrder = config.localOrder === 'random'
    ? 'random'
    : 'sequential';
  const rawInterval =
    typeof config.intervalMinutes === 'number' ? config.intervalMinutes : 1;
  const intervalMinutes = Math.max(
    MIN_WALLPAPER_INTERVAL_MINUTES,
    Math.floor(rawInterval) || MIN_WALLPAPER_INTERVAL_MINUTES,
  );
  const localIndex = wallpaperDirectoryKey(directory) === wallpaperDirectoryKey(previous.directory)
    ? previous.localIndex
    : -1;
  const next = { source, url, directory, localOrder, localIndex, intervalMinutes };
  store.set('appearance.wallpaper', next);
  restartWallpaperScheduler();
  return next;
});

ipcMain.handle('wallpaper:choose-directory', async (): Promise<string | null> => {
  const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

type SetRaiseInboxResult =
  | { ok: true; accelerator: string }
  | { ok: false; error: 'empty' | 'register_failed' };

ipcMain.handle('shortcut:get-raise-inbox', (): string => {
  return getRaiseInboxAccelerator();
});

ipcMain.handle('shortcut:set-raise-inbox-recording', (_event, recording: boolean) => {
  setRaiseInboxRecordingPaused(recording);
});

ipcMain.handle(
  'shortcut:set-raise-inbox',
  (_event, accelerator: string): SetRaiseInboxResult => {
    const trimmed = accelerator.trim();
    if (!trimmed) return { ok: false, error: 'empty' };
    const previous = getRaiseInboxAccelerator();
    if (!registerRaiseInboxShortcut(trimmed)) {
      registerRaiseInboxShortcut(previous);
      return { ok: false, error: 'register_failed' };
    }
    store.set('shortcuts.raiseInbox', trimmed);
    return { ok: true, accelerator: trimmed };
  },
);

type WindowAction = 'show' | 'hide' | 'hide-and-restore-focus' | 'minimize' | 'maximize' | 'close';
type ThaWindowConfig = {
  url: string;
  token?: string;
  width?: number;
  height?: number;
};

ipcMain.handle('window:action', (_event, action: WindowAction) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  switch (action) {
    case 'show':
      mainWindow.show();
      break;
    case 'hide':
      mainWindow.hide();
      break;
    case 'hide-and-restore-focus':
      hideMainWindowAndRestorePreviousFocus();
      break;
    case 'minimize':
      mainWindow.minimize();
      break;
    case 'maximize':
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
      break;
    case 'close':
      mainWindow.close();
      break;
  }
});

ipcMain.handle('tha:open', (_event, config: ThaWindowConfig) => {
  const baseUrl = typeof config?.url === 'string' ? config.url.trim() : '';
  if (!baseUrl) return { ok: false, error: 'missing_url' };
  const width = Math.max(240, Math.min(2400, Math.floor(config.width ?? 540)));
  const height = Math.max(240, Math.min(2400, Math.floor(config.height ?? 540)));
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    width,
    height,
    x: Math.max(0, screenWidth - width - 32),
    y: Math.max(0, screenHeight - height - 32),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  const target = new URL('/tha.html', baseUrl);
  if (config.token) target.searchParams.set('token', config.token);
  void window.loadURL(target.toString());
  window.setIgnoreMouseEvents(false);
  thaWindows.push(window);
  window.on('closed', () => {
    thaWindows = thaWindows.filter((item) => item !== window);
  });
  return { ok: true, id: window.id };
});

ipcMain.handle('tha:close-all', () => {
  for (const window of thaWindows) {
    if (!window.isDestroyed()) window.close();
  }
  thaWindows = [];
});

ipcMain.handle(
  'tha:set-ignore-mouse-events',
  (event, ignore: boolean, options?: { forward?: boolean }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed() || !thaWindows.includes(window)) return;
    window.setIgnoreMouseEvents(ignore, options);
  },
);

ipcMain.handle('app:quit', () => {
  app.isQuitting = true;
  app.quit();
});

ipcMain.handle('app:open-settings', (_event, section?: string) => {
  showMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:open-settings', {
      section: typeof section === 'string' && section.trim() ? section.trim() : 'overview',
    });
  }
  return { ok: true };
});

type OpenAtLoginState = {
  available: boolean;
  enabled: boolean;
  status: 'not-registered' | 'enabled' | 'requires-approval' | 'not-found' | null;
};

function getOpenAtLoginState(): OpenAtLoginState {
  const available =
    app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32');
  if (!available) return { available: false, enabled: false, status: null };
  const settings = app.getLoginItemSettings();
  return {
    available: true,
    enabled: settings.openAtLogin,
    status: process.platform === 'darwin' ? settings.status : null,
  };
}

ipcMain.handle('app:get-open-at-login', (): OpenAtLoginState => {
  return getOpenAtLoginState();
});

ipcMain.handle('app:set-open-at-login', (_event, enabled: boolean): OpenAtLoginState => {
  const current = getOpenAtLoginState();
  if (!current.available) return current;
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return getOpenAtLoginState();
});

// ---------------------------------------------------------------------------
// Screenshot (8.1)
// ---------------------------------------------------------------------------

async function captureScreen(): Promise<string | null> {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });

    const primary =
      sources.find((s) => s.display_id === String(primaryDisplay.id)) ??
      sources[0];

    // 固定输出 JPEG（quality=80）以压缩体积，比 PNG 小 5-10 倍。
    const buf = primary?.thumbnail.toJPEG(80);
    if (!buf) return null;
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (err) {
    console.error('[screenshot] captureScreen failed:', err);
    return null;
  }
}

ipcMain.handle('screenshot:capture', () => captureScreen());

function showNativeNotification(payload: Partial<NativeNotificationPayload>): void {
  if ((process.platform !== 'darwin' && process.platform !== 'win32')
      || !Notification.isSupported()) {
    return;
  }
  const configuredLanguage = store.get('appearance.language');
  const locale = typeof configuredLanguage === 'string' && configuredLanguage
    ? configuredLanguage
    : app.getLocale();
  const notification = new Notification({
    title: 'Nanobot',
    body: notificationBody(payload, locale),
  });
  notification.on('click', showMainWindow);
  notification.on('failed', (_event, error) => {
    console.error('[notification] native notification failed:', error);
  });
  notification.show();
}

function ensureWindowsNotificationShortcut(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const programsDir = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
  );
  const shortcutPath = path.join(programsDir, `${APP_NAME}.lnk`);
  try {
    mkdirSync(programsDir, { recursive: true });
    const written = shell.writeShortcutLink(shortcutPath, 'create', {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      description: APP_NAME,
      icon: process.execPath,
      iconIndex: 0,
      appUserModelId: APP_ID,
      toastActivatorClsid: WINDOWS_TOAST_ACTIVATOR_CLSID,
    });
    if (!written) {
      console.error('[notification] failed to create Windows Start Menu shortcut');
    }
  } catch (error) {
    console.error('[notification] failed to create Windows Start Menu shortcut:', error);
  }
}

ipcMain.handle('tray:notify-incoming', (
  _event,
  payload: Partial<NativeNotificationPayload> = {},
) => {
  const isFocused = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
  if (isFocused) return;
  notifyTrayIncoming();
  showNativeNotification(payload);
});

ipcMain.handle('tray:set-streaming', (_event, active: unknown) => {
  setTrayStreaming(active === true);
});

// ---------------------------------------------------------------------------
// App icons (sourced from webui/public/brand/)
// ---------------------------------------------------------------------------

function resolveAsset(...segments: string[]): string {
  const candidates = [
    // 打包后：app.asar/.vite/build/assets/（vite.main 构建时复制）
    path.join(__dirname, 'assets', ...segments),
    // extraResource 兜底：resources/assets/
    path.join(process.resourcesPath, 'assets', ...segments),
    // 开发时源码目录
    path.join(__dirname, '../../assets', ...segments),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function loadAppIcon(): Electron.NativeImage {
  const png = nativeImage.createFromPath(resolveAsset('icon.png'));
  if (!png.isEmpty()) return png;
  return nativeImage.createFromPath(resolveAsset('icon.ico'));
}

function loadTrayIcon(): Electron.NativeImage {
  const assetName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  let icon = nativeImage.createFromPath(resolveAsset(assetName));
  if (icon.isEmpty() && process.platform === 'darwin') {
    icon = nativeImage.createFromPath(resolveAsset('tray.png'));
  }
  if (icon.isEmpty()) {
    icon = loadAppIcon();
  }
  if (icon.isEmpty()) {
    console.error('[tray] 无法加载托盘图标，尝试路径:', resolveAsset(assetName));
    return icon;
  }
  if (process.platform === 'darwin') {
    // macOS 菜单栏：Template Image，系统随深浅模式自动反色
    icon.setTemplateImage(true);
  } else if (process.platform === 'win32') {
    // Windows 托盘建议使用 16×16，过大或路径异常时可能显示空白
    const { width, height } = icon.getSize();
    if (width !== 16 || height !== 16) {
      icon = icon.resize({ width: 16, height: 16, quality: 'best' });
    }
  }
  return icon;
}

function loadTrayStatusIcon(
  assetName: string,
  fallback: Electron.NativeImage,
  template = false,
): Electron.NativeImage {
  let icon = nativeImage.createFromPath(resolveAsset(assetName));
  if (icon.isEmpty()) return fallback;
  if (template) {
    icon.setTemplateImage(true);
  } else if (process.platform === 'win32') {
    const { width, height } = icon.getSize();
    if (width !== 16 || height !== 16) {
      icon = icon.resize({ width: 16, height: 16, quality: 'best' });
    }
  }
  return icon;
}

function loadTrayStatusIcons(idle: Electron.NativeImage): TrayStatusIcons {
  const isMac = process.platform === 'darwin';
  const emptyOverlay = nativeImage.createEmpty();
  return {
    idle,
    streaming: loadTrayStatusIcon(
      isMac ? 'trayStreamingTemplate.png' : 'trayStreaming.png',
      idle,
      isMac,
    ),
    streamingAlt: loadTrayStatusIcon(
      isMac ? 'trayStreamingAltTemplate.png' : 'trayStreamingAlt.png',
      idle,
      isMac,
    ),
    unread: loadTrayStatusIcon(
      isMac ? 'trayUnreadTemplate.png' : 'trayUnread.png',
      idle,
      isMac,
    ),
    unreadOverlay: loadTrayStatusIcon('trayUnreadOverlay.png', emptyOverlay),
  };
}

// ---------------------------------------------------------------------------
// Window factory (6.1)
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let thaWindows: BrowserWindow[] = [];
let registeredRaiseInboxAccelerator: string | null = null;
let pendingRaiseInboxEvent = false;
let previousWindowsForegroundHandle: string | null = null;
/** 设置页录制快捷键时暂停全局注册，避免按下当前组合键触发跳转。 */
let raiseInboxRecordingPaused = false;

// ---------------------------------------------------------------------------
// Dynamic wallpaper
// ---------------------------------------------------------------------------

let wallpaperInterval: ReturnType<typeof setInterval> | null = null;
let wallpaperGeneration = 0;
let wallpaperFetchingGeneration: number | null = null;
let lastWallpaperDataUrl: string | null = null;

function isMainWindowWallpaperVisible(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isVisible() && !mainWindow.isMinimized();
}

function sendWallpaperUpdate(dataUrl: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('wallpaper:update', dataUrl);
}

function sendWallpaperDisabled(): void {
  lastWallpaperDataUrl = null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('wallpaper:disabled');
}

async function fetchWallpaperAsDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error('[wallpaper] fetch failed:', response.status, response.statusText);
      return null;
    }
    const contentType = response.headers.get('content-type') ?? 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.error('[wallpaper] fetch failed:', err);
    return null;
  }
}

async function loadLocalWallpaper(
  config: WallpaperConfig,
): Promise<{ dataUrl: string; index: number } | null> {
  try {
    const files = await listWallpaperImages(config.directory);
    const candidates = localWallpaperCandidateIndices(
      files.length,
      config.localIndex,
      config.localOrder,
    );
    for (const index of candidates) {
      try {
        const dataUrl = await wallpaperFileToDataUrl(files[index]);
        if (nativeImage.createFromDataURL(dataUrl).isEmpty()) {
          throw new Error('invalid image data');
        }
        return { dataUrl, index };
      } catch (error) {
        console.error('[wallpaper] failed to read local image:', files[index], error);
      }
    }
    if (files.length === 0) {
      console.error('[wallpaper] no supported images in directory:', config.directory);
    }
  } catch (error) {
    console.error('[wallpaper] failed to read directory:', config.directory, error);
  }
  return null;
}

async function fetchAndSendWallpaper(): Promise<void> {
  const generation = wallpaperGeneration;
  const config = getWallpaperConfig();
  const sourceValue = config.source === 'directory' ? config.directory : config.url;
  if (!sourceValue) {
    sendWallpaperDisabled();
    return;
  }
  if (wallpaperFetchingGeneration === generation) return;
  wallpaperFetchingGeneration = generation;
  try {
    const local = config.source === 'directory'
      ? await loadLocalWallpaper(config)
      : null;
    const dataUrl = config.source === 'directory'
      ? local?.dataUrl ?? null
      : await fetchWallpaperAsDataUrl(config.url);
    if (generation !== wallpaperGeneration) return;
    if (dataUrl) {
      if (local) store.set('appearance.wallpaper.localIndex', local.index);
      lastWallpaperDataUrl = dataUrl;
      sendWallpaperUpdate(dataUrl);
    }
  } finally {
    if (wallpaperFetchingGeneration === generation) {
      wallpaperFetchingGeneration = null;
    }
  }
}

function stopWallpaperScheduler(): void {
  if (wallpaperInterval) {
    clearInterval(wallpaperInterval);
    wallpaperInterval = null;
  }
}

function startWallpaperScheduler(): void {
  stopWallpaperScheduler();
  const config = getWallpaperConfig();
  const sourceValue = config.source === 'directory' ? config.directory : config.url;
  if (!sourceValue || !isMainWindowWallpaperVisible()) return;

  void fetchAndSendWallpaper();
  wallpaperInterval = setInterval(() => {
    if (isMainWindowWallpaperVisible()) {
      void fetchAndSendWallpaper();
    }
  }, config.intervalMinutes * 60_000);
}

function restartWallpaperScheduler(): void {
  wallpaperGeneration += 1;
  const config = getWallpaperConfig();
  const sourceValue = config.source === 'directory' ? config.directory : config.url;
  if (!sourceValue) {
    stopWallpaperScheduler();
    sendWallpaperDisabled();
    return;
  }
  if (isMainWindowWallpaperVisible()) {
    startWallpaperScheduler();
  } else {
    stopWallpaperScheduler();
  }
}

function onWallpaperVisibilityChange(): void {
  if (isMainWindowWallpaperVisible()) {
    startWallpaperScheduler();
  } else {
    stopWallpaperScheduler();
  }
}

function getRaiseInboxAccelerator(): string {
  const stored = store.get('shortcuts.raiseInbox');
  if (typeof stored === 'string' && stored.trim()) return stored.trim();
  return DEFAULT_RAISE_INBOX_ACCELERATOR;
}

function isMainWindowRaisedAndFocused(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused();
}

function sendRaiseInboxToRenderer(toggle = false): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) {
    pendingRaiseInboxEvent = true;
    return;
  }
  mainWindow.webContents.send('shortcut:raise-inbox', { toggle });
}

async function handleRaiseInboxShortcut(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (process.platform === 'win32') {
      previousWindowsForegroundHandle = await captureWindowsForegroundWindow();
    }
    pendingRaiseInboxEvent = true;
    showMainWindow();
    return;
  }
  if (isMainWindowRaisedAndFocused()) {
    sendRaiseInboxToRenderer(true);
    return;
  }
  if (process.platform === 'win32') {
    const ownHandle = nativeWindowHandleValue(mainWindow.getNativeWindowHandle());
    previousWindowsForegroundHandle = await captureWindowsForegroundWindow(ownHandle);
  }
  showMainWindow();
  sendRaiseInboxToRenderer(false);
}

function unregisterRaiseInboxShortcut(): void {
  if (registeredRaiseInboxAccelerator) {
    globalShortcut.unregister(registeredRaiseInboxAccelerator);
    registeredRaiseInboxAccelerator = null;
  }
}

function setRaiseInboxRecordingPaused(recording: boolean): void {
  if (recording === raiseInboxRecordingPaused) return;
  raiseInboxRecordingPaused = recording;
  if (recording) {
    unregisterRaiseInboxShortcut();
  } else {
    registerRaiseInboxShortcut();
  }
}

function registerRaiseInboxShortcut(accelerator?: string): boolean {
  if (raiseInboxRecordingPaused) return false;
  const next = (accelerator ?? getRaiseInboxAccelerator()).trim();
  if (!next) return false;
  unregisterRaiseInboxShortcut();
  const ok = globalShortcut.register(next, () => {
    void handleRaiseInboxShortcut();
  });
  if (ok) {
    registeredRaiseInboxAccelerator = next;
  }
  return ok;
}

function showMainWindow(): void {
  clearTrayUnread();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow();
}

function hideMainWindowAndRestorePreviousFocus(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (process.platform === 'darwin') {
    const auxiliaryWindows = BrowserWindow.getAllWindows().filter(
      (window) => window !== mainWindow && !window.isDestroyed() && window.isVisible(),
    );
    mainWindow.hide();
    app.hide();
    setImmediate(() => {
      for (const window of auxiliaryWindows) {
        if (!window.isDestroyed()) window.showInactive();
      }
    });
    return;
  }
  if (process.platform === 'win32') {
    const handle = previousWindowsForegroundHandle;
    previousWindowsForegroundHandle = null;
    mainWindow.hide();
    if (handle) void restoreWindowsForegroundWindow(handle);
    return;
  }
  mainWindow.hide();
}

function ensureWindowOnScreen(bounds: {
  x?: number;
  y?: number;
  width: number;
  height: number;
}): { x?: number; y?: number; width: number; height: number } {
  if (bounds.x === undefined || bounds.y === undefined) return bounds;
  const displays = screen.getAllDisplays();
  const onScreen = displays.some((d) => {
    const { x, y, width, height } = d.workArea;
    return (
      (bounds.x as number) >= x &&
      (bounds.y as number) >= y &&
      (bounds.x as number) < x + width &&
      (bounds.y as number) < y + height
    );
  });
  if (!onScreen) {
    // Reset to primary display center
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    return {
      width: bounds.width,
      height: bounds.height,
      x: Math.round((width - bounds.width) / 2),
      y: Math.round((height - bounds.height) / 2),
    };
  }
  return bounds;
}

function createWindow(): void {
  const saved = store.get('window');
  const bounds = ensureWindowOnScreen(saved);

  const appIcon = loadAppIcon();

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 600,
    icon: appIcon.isEmpty() ? undefined : appIcon,
    // 全平台无边框；macOS 通过 hiddenInset 保留原生红绿灯
    frame: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 10, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 关闭同源策略：renderer 是 file:// origin，需要向本地 gateway 发送请求。
      // 这是纯本地桌面应用的有意选择，风险面等同于直接在浏览器中打开 localhost webui。
      webSecurity: false,
    },
  });

  // Persist window bounds on resize / move (debounced to avoid excessive disk writes)
  let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null;
  const saveBounds = () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
      const { x, y, width, height } = mainWindow.getBounds();
      store.set('window', { x, y, width, height });
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  const notifyWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(
      'window:state',
      mainWindow.isMaximized() ? 'maximized' : 'normal',
    );
  };
  mainWindow.on('maximize', notifyWindowState);
  mainWindow.on('unmaximize', notifyWindowState);

  // Minimize to tray on close (6.2); actual quit goes through tray → 退出
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    setTrayStreaming(false);
    clearTrayUnread();
    stopWallpaperScheduler();
    mainWindow = null;
  });

  mainWindow.on('show', onWallpaperVisibilityChange);
  mainWindow.on('show', refreshTrayStatus);
  mainWindow.on('hide', onWallpaperVisibilityChange);
  mainWindow.on('minimize', onWallpaperVisibilityChange);
  mainWindow.on('restore', onWallpaperVisibilityChange);

  // 截屏快捷键：仅窗口获焦时生效（8.1）
  const screenshotHandler = async () => {
    const dataUrl = await captureScreen();
    if (dataUrl && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('screenshot:captured', dataUrl);
    }
  };
  let screenLocked = false;

  const sendPresence = (patch: { focused?: boolean; locked?: boolean }) => {
    mainWindow?.webContents.send('window:presence', patch);
  };

  mainWindow.on('focus', () => {
    clearTrayUnread();
    globalShortcut.register(SCREENSHOT_ACCELERATOR, screenshotHandler);
    sendPresence({ focused: true });
  });
  mainWindow.on('blur', () => {
    globalShortcut.unregister(SCREENSHOT_ACCELERATOR);
    sendPresence({ focused: false });
    // 该句柄只对同一次快捷键唤起有效；中途切换应用后交由 Windows Z-order 恢复，
    // 避免再次进入 Electron 时激活更早的陈旧窗口。
    if (process.platform === 'win32') previousWindowsForegroundHandle = null;
  });

  // powerMonitor 必须在 app.whenReady() 后使用（此处已在 createWindow 内，满足条件）
  powerMonitor.on('lock-screen', () => {
    screenLocked = true;
    sendPresence({ locked: true });
  });
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false;
    sendPresence({ locked: false });
  });

  // 新窗口建立时补发一次当前锁屏状态，避免 renderer 连接后状态不同步
  mainWindow.webContents.on('did-finish-load', () => {
    if (screenLocked) sendPresence({ locked: true });
    if (pendingRaiseInboxEvent) {
      pendingRaiseInboxEvent = false;
      sendRaiseInboxToRenderer(false);
    }
    const wallpaper = getWallpaperConfig();
    const sourceValue = wallpaper.source === 'directory' ? wallpaper.directory : wallpaper.url;
    if (sourceValue && lastWallpaperDataUrl) {
      sendWallpaperUpdate(lastWallpaperDataUrl);
    } else if (!sourceValue) {
      sendWallpaperDisabled();
    }
    onWallpaperVisibilityChange();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Open DevTools in development
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools();
  }
}

// ---------------------------------------------------------------------------
// System tray (6.2)
// ---------------------------------------------------------------------------

let tray: Tray | null = null;

function createTray(): void {
  const icon = loadTrayIcon();
  if (icon.isEmpty()) return;

  tray = new Tray(icon);
  tray.setToolTip('Nanobot');
  initTrayStatus(tray, loadTrayStatusIcons(icon), () => mainWindow);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示',
      click: () => {
        showMainWindow();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    showMainWindow();
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.isQuitting = false;
let quitCleanupStarted = false;
let quitCleanupFinished = false;

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId(APP_ID);
      ensureWindowsNotificationShortcut();
    }

    // BrowserWindow 的 webSecurity: false 已关闭 renderer 的 CORS 检查，
    // 无需在 session 层面额外处理 CORS。
    // Windows/Linux 默认会显示 File/Edit/View 菜单栏，无边框窗口需移除；
    // macOS 保留原生应用菜单，避免影响状态栏菜单和 Cmd+Q/C/V 等快捷键。
    if (process.platform !== 'darwin') {
      Menu.setApplicationMenu(null);
    }

    createTray();
    createWindow();
    registerRaiseInboxShortcut();

    app.on('activate', () => {
      // macOS: 点击 Dock 图标时恢复主窗口
      showMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS: keep app running in tray; other platforms: quit
    // TODO: Windows 上需要区分「最小化到托盘」和「真正退出」的行为，当前 close 被
    //       preventDefault 后此事件不会触发，需要在 Windows 环境上验证并调整。
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    app.isQuitting = true;
    if (!quitCleanupFinished) {
      event.preventDefault();
      if (!quitCleanupStarted) {
        quitCleanupStarted = true;
        void systemMediaController.dispose().finally(() => {
          quitCleanupFinished = true;
          app.quit();
        });
      }
      return;
    }
    disposeTrayStatus();
    stopWallpaperScheduler();
    unregisterRaiseInboxShortcut();
    cleanupPsbOnQuit();
  });
}
