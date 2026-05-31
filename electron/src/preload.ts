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
});
