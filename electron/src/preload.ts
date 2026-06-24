import { contextBridge, ipcRenderer } from 'electron';

/**
 * IPC bridge exposed to the renderer via window.electronAPI.
 *
 * Namespace design (6.4):
 *   - config.*     — electron-store read / write (extensible for settings page)
 *   - screenshot.* — desktopCapturer integration (wired up in 8.1)
 *
 * All handlers live in main.ts ipcMain.handle() calls.
 */
type WindowAction = 'show' | 'hide' | 'minimize' | 'maximize' | 'close';
type WindowState = 'maximized' | 'normal';
type SetRaiseInboxResult =
  | { ok: true; accelerator: string }
  | { ok: false; error: 'empty' | 'register_failed' };
type WallpaperConfig = {
  url: string;
  intervalMinutes: number;
};
type ThaWindowConfig = {
  url: string;
  token?: string;
  width?: number;
  height?: number;
};
type PsbOpenConfig = {
  url: string;
  token?: string;
  modelId?: string;
  width?: number;
  height?: number;
};
type PsbWindowStatePatch = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scale?: number;
  opacity?: number;
};
type PsbRuntimeAction = {
  type: string;
  payload?: Record<string, unknown>;
};

contextBridge.exposeInMainWorld('electronAPI', {
  platform: {
    isMac: process.platform === 'darwin',
    isWindows: process.platform === 'win32',
  },

  window: {
    action: (action: WindowAction): Promise<void> =>
      ipcRenderer.invoke('window:action', action),

    onStateChange: (cb: (state: WindowState) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: WindowState) =>
        cb(state);
      ipcRenderer.on('window:state', handler);
      return () => ipcRenderer.removeListener('window:state', handler);
    },
  },

  config: {
    /** Read a value from electron-store. Supports dot-notation keys, e.g.
     *  "gateway.url", "appearance.theme". */
    get: (key: string): Promise<unknown> =>
      ipcRenderer.invoke('config:get', key),

    /** Write a value to electron-store. */
    set: (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke('config:set', key, value),
  },

  app: {
    /** 完全退出应用（与托盘菜单「退出」一致） */
    quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
    /** 打开主窗口设置页，可选分区（如 deskPet） */
    openSettings: (section?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('app:open-settings', section),
    onOpenSettings: (cb: (section: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { section?: string }) =>
        cb(payload?.section ?? 'overview');
      ipcRenderer.on('app:open-settings', handler);
      return () => ipcRenderer.removeListener('app:open-settings', handler);
    },
  },

  tha: {
    open: (config: ThaWindowConfig): Promise<{ ok: true; id: number } | { ok: false; error: string }> =>
      ipcRenderer.invoke('tha:open', config),
    closeAll: (): Promise<void> => ipcRenderer.invoke('tha:close-all'),
  },

  psb: {
    open: (
      config: PsbOpenConfig,
    ): Promise<{ ok: true; id: number; reused?: boolean } | { ok: false; error: string }> =>
      ipcRenderer.invoke('psb:open', config),
    close: (): Promise<void> => ipcRenderer.invoke('psb:close'),
    closePermanent: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('psb:close-permanent'),
    closeAll: (): Promise<void> => ipcRenderer.invoke('psb:close-all'),
    getWindowState: (): Promise<PsbWindowStatePatch> => ipcRenderer.invoke('psb:get-window-state'),
    startWindowDrag: (screenX: number, screenY: number): void =>
      ipcRenderer.send('psb:drag-start', { screenX, screenY }),
    stopWindowDrag: (): void => ipcRenderer.send('psb:drag-end'),
    saveWindowState: (
      patch: PsbWindowStatePatch,
    ): Promise<{ ok: boolean; state?: PsbWindowStatePatch; error?: string }> =>
      ipcRenderer.invoke('psb:save-window-state', patch),
    sendAction: (action: PsbRuntimeAction): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('psb:send-action', action),
    setIgnoreMouseEvents: (
      ignore: boolean,
      options?: { forward?: boolean },
    ): Promise<void> => ipcRenderer.invoke('psb:set-ignore-mouse-events', ignore, options),
    onAction: (cb: (action: PsbRuntimeAction) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, action: PsbRuntimeAction) => cb(action);
      ipcRenderer.on('psb:action', handler);
      return () => ipcRenderer.removeListener('psb:action', handler);
    },
    onConfig: (cb: (config: { scale?: number; opacity?: number; followMouse?: boolean }) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, config: { scale?: number; opacity?: number; followMouse?: boolean }) => cb(config);
      ipcRenderer.on('psb:config', handler);
      return () => ipcRenderer.removeListener('psb:config', handler);
    },
    onMouse: (cb: (point: { x?: number; y?: number; leave?: boolean }) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, point: { x?: number; y?: number; leave?: boolean }) =>
        cb(point);
      ipcRenderer.on('psb:mouse', handler);
      return () => ipcRenderer.removeListener('psb:mouse', handler);
    },
    updateFollowMouse: (enabled: boolean): Promise<{ ok: boolean; followMouse?: boolean }> =>
      ipcRenderer.invoke('psb:update-follow-mouse', enabled),
    tryAutoOpen: (token?: string, url?: string): Promise<void> =>
      ipcRenderer.invoke('psb:try-auto-open', token, url),
  },

  /** THA 透明窗口鼠标穿透（与 SAP electronAPI 对齐） */
  setIgnoreMouseEvents: (
    ignore: boolean,
    options?: { forward?: boolean },
  ): Promise<void> => ipcRenderer.invoke('tha:set-ignore-mouse-events', ignore, options),

  screenshot: {
    /** 主动触发一次截屏，返回 data URL 或 null。 */
    capture: (): Promise<string | null> =>
      ipcRenderer.invoke('screenshot:capture'),

    /** 订阅主进程通过全局快捷键推送的截图事件，返回取消监听的清理函数。 */
    onCapture: (cb: (dataUrl: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, dataUrl: string) =>
        cb(dataUrl);
      ipcRenderer.on('screenshot:captured', handler);
      return () => ipcRenderer.removeListener('screenshot:captured', handler);
    },
  },

  presence: {
    /** 订阅主进程推送的窗口焦点变更事件（focused=true 获焦，false 失焦）。
     *  返回取消监听的清理函数。连接建立后由 renderer 主动同步当前状态。 */
    onChange: (cb: (focused: boolean) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { focused: boolean }) =>
        cb(payload.focused);
      ipcRenderer.on('window:presence', handler);
      return () => ipcRenderer.removeListener('window:presence', handler);
    },
  },

  wallpaper: {
    getConfig: (): Promise<WallpaperConfig> =>
      ipcRenderer.invoke('wallpaper:get-config'),

    setConfig: (config: WallpaperConfig): Promise<WallpaperConfig> =>
      ipcRenderer.invoke('wallpaper:set-config', config),

    onUpdate: (cb: (dataUrl: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, dataUrl: string) =>
        cb(dataUrl);
      ipcRenderer.on('wallpaper:update', handler);
      return () => ipcRenderer.removeListener('wallpaper:update', handler);
    },

    onDisabled: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('wallpaper:disabled', handler);
      return () => ipcRenderer.removeListener('wallpaper:disabled', handler);
    },
  },

  shortcut: {
    getRaiseInbox: (): Promise<string> =>
      ipcRenderer.invoke('shortcut:get-raise-inbox'),

    setRaiseInbox: (accelerator: string): Promise<SetRaiseInboxResult> =>
      ipcRenderer.invoke('shortcut:set-raise-inbox', accelerator),

    /** 设置页录制时暂停/恢复全局「唤起收件箱」快捷键。 */
    setRaiseInboxRecording: (recording: boolean): Promise<void> =>
      ipcRenderer.invoke('shortcut:set-raise-inbox-recording', recording),

    /** 全局快捷键唤起/切换统一收件箱；toggle=true 时若已在收件箱则隐藏窗口。 */
    onRaiseInbox: (cb: (payload: { toggle: boolean }) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload?: { toggle?: boolean }) =>
        cb({ toggle: payload?.toggle ?? false });
      ipcRenderer.on('shortcut:raise-inbox', handler);
      return () => ipcRenderer.removeListener('shortcut:raise-inbox', handler);
    },
  },

  tray: {
    notifyIncoming: (): Promise<void> => ipcRenderer.invoke('tray:notify-incoming'),
  },
});
