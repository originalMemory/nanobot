import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';

const SCREENSHOT_ACCELERATOR = 'CmdOrCtrl+Shift+S';
import Store from 'electron-store';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
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
      language: 'en',
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

    return primary?.thumbnail.toDataURL() ?? null;
  } catch (err) {
    console.error('[screenshot] captureScreen failed:', err);
    return null;
  }
}

ipcMain.handle('screenshot:capture', () => captureScreen());

// ---------------------------------------------------------------------------
// Window factory (6.1)
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

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

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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
  mainWindow.on('focus', () => {
    globalShortcut.register(SCREENSHOT_ACCELERATOR, screenshotHandler);
  });
  mainWindow.on('blur', () => {
    globalShortcut.unregister(SCREENSHOT_ACCELERATOR);
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
  // Minimal 16×16 monochrome template icon (placeholder; replace with a
  // proper @2x asset in the assets/ directory when branding is finalised).
  const icon = nativeImage.createFromDataURL(
    // 16×16 transparent PNG with a simple filled circle
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
    'MElEQVQ4T2NkYGD4z8BAAoxqoBIGRgMYGBj+k+2FUQ1QwQCyDR8VZMKoJhIGAABkBAMB' +
    'H/3XHQAAAABJRU5ErkJggg==',
  );
  icon.setTemplateImage(true); // macOS: auto-adjusts for light/dark menu bar

  tray = new Tray(icon);
  tray.setToolTip('Nanobot');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
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
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    } else {
      createWindow();
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.isQuitting = false;

app.whenReady().then(() => {
  // BrowserWindow 的 webSecurity: false 已关闭 renderer 的 CORS 检查，
  // 无需在 session 层面额外处理 CORS。

  createTray();
  createWindow();

  app.on('activate', () => {
    // macOS: re-create window when dock icon is clicked and no windows exist
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
    }
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
