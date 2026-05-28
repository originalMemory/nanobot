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
contextBridge.exposeInMainWorld('electronAPI', {
  config: {
    /** Read a value from electron-store. Supports dot-notation keys, e.g.
     *  "gateway.url", "appearance.theme". */
    get: (key: string): Promise<unknown> =>
      ipcRenderer.invoke('config:get', key),

    /** Write a value to electron-store. */
    set: (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke('config:set', key, value),
  },

  screenshot: {
    /** Trigger a screen capture. Returns a data URL string or null.
     *  Full implementation in task 8.1 (desktopCapturer). */
    capture: (): Promise<string | null> =>
      ipcRenderer.invoke('screenshot:capture'),
  },
});
