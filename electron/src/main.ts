import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  screen,
  Tray,
} from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import started from 'electron-squirrel-startup';

const SCREENSHOT_ACCELERATOR = 'CmdOrCtrl+Shift+S';
import Store from 'electron-store';
import { APP_ID } from '../app.meta';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
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
  };
  window: {
    x?: number;
    y?: number;
    width: number;
    height: number;
  };
  providers: Record<string, unknown>;
  models: Record<string, unknown>;
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
    },
    window: {
      width: 1200,
      height: 800,
    },
    providers: {},
    models: {},
  },
});

// ---------------------------------------------------------------------------
// IPC handlers (6.4)
// ---------------------------------------------------------------------------

ipcMain.handle('config:get', (_event, key: string) => {
  return store.get(key);
});

ipcMain.handle('config:set', (_event, key: string, value: unknown) => {
  store.set(key, value);
});

type WindowAction = 'show' | 'hide' | 'minimize' | 'maximize' | 'close';

ipcMain.handle('window:action', (_event, action: WindowAction) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  switch (action) {
    case 'show':
      mainWindow.show();
      break;
    case 'hide':
      mainWindow.hide();
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

ipcMain.handle('app:quit', () => {
  app.isQuitting = true;
  app.quit();
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
    const { width, height } = icon.getSize();
    if (width !== 36 || height !== 36) {
      icon = icon.resize({ width: 36, height: 36, quality: 'best' });
      icon.setTemplateImage(true);
    }
  } else if (process.platform === 'win32') {
    // Windows 托盘建议使用 16×16，过大或路径异常时可能显示空白
    const { width, height } = icon.getSize();
    if (width !== 16 || height !== 16) {
      icon = icon.resize({ width: 16, height: 16, quality: 'best' });
    }
  }
  return icon;
}

// ---------------------------------------------------------------------------
// Window factory (6.1)
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

function showMainWindow(): void {
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
    mainWindow = null;
  });

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
    globalShortcut.register(SCREENSHOT_ACCELERATOR, screenshotHandler);
    sendPresence({ focused: true });
  });
  mainWindow.on('blur', () => {
    globalShortcut.unregister(SCREENSHOT_ACCELERATOR);
    sendPresence({ focused: false });
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

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId(APP_ID);
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

  app.on('before-quit', () => {
    app.isQuitting = true;
  });
}
