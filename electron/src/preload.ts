import { contextBridge, ipcRenderer } from 'electron';

/** Electron 原生能力桥；业务 UI 由 gateway 的 WebUI 提供。 */
type WindowAction = 'show' | 'hide' | 'minimize' | 'maximize' | 'close';
type WindowState = 'maximized' | 'normal';
type SetRaiseInboxResult =
  | { ok: true; accelerator: string }
  | { ok: false; error: 'empty' | 'register_failed' };
type WallpaperConfig = {
  url: string;
  intervalMinutes: number;
};
type SetGatewayUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: 'empty' | 'invalid' | 'unsupported' | 'credentials' };

const nativeHostApi = {
  platform: {
    isMac: process.platform === 'darwin',
    isWindows: process.platform === 'win32',
  },

  gateway: {
    getUrl: (): Promise<string> => ipcRenderer.invoke('gateway:get-url'),

    setUrl: (url: string): Promise<SetGatewayUrlResult> =>
      ipcRenderer.invoke('gateway:set-url', url),

    setSecret: (secret: string): Promise<void> =>
      ipcRenderer.invoke('gateway:set-secret', secret),

    clearSecret: (): Promise<void> =>
      ipcRenderer.invoke('gateway:clear-secret'),

    setConnection: (url: string, secret: string): Promise<SetGatewayUrlResult> =>
      ipcRenderer.invoke('gateway:set-connection', url, secret),
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
    onChange: (
      cb: (payload: { focused?: boolean; locked?: boolean }) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { focused?: boolean; locked?: boolean },
      ) => cb(payload);
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
};

contextBridge.exposeInMainWorld('nanobotHost', nativeHostApi);
