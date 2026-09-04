// ---------------------------------------------------------------------------
// Electron IPC bridge (injected by preload.ts via contextBridge)
// ---------------------------------------------------------------------------

type WindowAction = "show" | "hide" | "hide-and-restore-focus" | "minimize" | "maximize" | "close";
type WindowState = "maximized" | "normal";
type WallpaperConfig = {
  source: "url" | "directory";
  url: string;
  directory: string;
  localOrder: "sequential" | "random";
  localIndex: number;
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
type OpenAtLoginState = {
  available: boolean;
  enabled: boolean;
  status: "not-registered" | "enabled" | "requires-approval" | "not-found" | null;
};

interface ElectronAPI {
  platform: {
    isMac: boolean;
    isWindows: boolean;
  };
  window: {
    action(action: WindowAction): Promise<void>;
    onStateChange(cb: (state: WindowState) => void): () => void;
  };
  config: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  systemMedia: {
    getEnabled(): Promise<boolean>;
    getSupport(): Promise<"system" | "limited" | "unavailable">;
    setEnabled(enabled: boolean): Promise<boolean>;
    setTtsActive(active: boolean): Promise<void>;
  };
  app: {
    quit(): Promise<void>;
    openSettings(section?: string): Promise<{ ok: boolean }>;
    onOpenSettings(cb: (section: string) => void): () => void;
    getOpenAtLogin(): Promise<OpenAtLoginState>;
    setOpenAtLogin(enabled: boolean): Promise<OpenAtLoginState>;
  };
  tha: {
    open(config: ThaWindowConfig): Promise<{ ok: true; id: number } | { ok: false; error: string }>;
    closeAll(): Promise<void>;
  };
  psb: {
    open(
      config: PsbOpenConfig,
    ): Promise<{ ok: true; id: number; reused?: boolean } | { ok: false; error: string }>;
    close(): Promise<void>;
    closePermanent(): Promise<{ ok: boolean }>;
    closeAll(): Promise<void>;
    getWindowState(): Promise<PsbWindowStatePatch>;
    startWindowDrag(screenX: number, screenY: number): void;
    stopWindowDrag(): void;
    saveWindowState(
      patch: PsbWindowStatePatch,
    ): Promise<{ ok: boolean; state?: PsbWindowStatePatch; error?: string }>;
    sendAction(action: PsbRuntimeAction): Promise<{ ok: boolean }>;
    setRuntimeAudioReady(ready: boolean): void;
    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): Promise<void>;
    onAction(cb: (action: PsbRuntimeAction) => void): () => void;
    onConfig(cb: (config: { scale?: number; opacity?: number; followMouse?: boolean }) => void): () => void;
    onMouse(cb: (point: { x?: number; y?: number; leave?: boolean }) => void): () => void;
    updateFollowMouse(enabled: boolean): Promise<{ ok: boolean; followMouse?: boolean }>;
    tryAutoOpen(token?: string, url?: string): Promise<void>;
  };
  livetalking: {
    localVideos(): Promise<{
      idle: string[];
      working: string[];
      segment: "sunrise" | "day" | "sunset" | "night";
      directoryError: "not_found" | "invalid_structure" | "multiple_scene_packs" | null;
    }>;
    checkHealth(): Promise<{
      reachable: boolean;
      lastCheckedAtMs: number | null;
      lastError: string | null;
    }>;
    offer(
      sdp: string,
      avatar?: string,
    ): Promise<{ sdp?: string; type?: string; sessionid?: string; code?: number; msg?: string }>;
    setAudiotype(sessionid: string, audiotype: number): Promise<unknown>;
    interrupt(sessionid: string): Promise<unknown>;
    audiostreamStart(sessionid: string, sampleRate: number): Promise<unknown>;
    audiostreamChunk(sessionid: string, data: ArrayBuffer): Promise<unknown>;
    audiostreamFinish(sessionid: string): Promise<unknown>;
    isSpeaking(sessionid: string): Promise<unknown>;
  };
  /** THA 透明窗口鼠标穿透 */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): Promise<void>;
  screenshot: {
    capture(): Promise<string | null>;
    /** 订阅全局快捷键触发的截图事件，返回取消监听的清理函数。 */
    onCapture(cb: (dataUrl: string) => void): () => void;
  };
  presence: {
    /** 订阅窗口焦点变更事件（focused=true 获焦，false 失焦），返回取消监听的清理函数。 */
    onChange(cb: (focused: boolean) => void): () => void;
  };
  wallpaper: {
    getConfig(): Promise<WallpaperConfig>;
    setConfig(config: WallpaperConfig): Promise<WallpaperConfig>;
    chooseDirectory(): Promise<string | null>;
    onUpdate(cb: (dataUrl: string) => void): () => void;
    onDisabled(cb: () => void): () => void;
  };
  shortcut: {
    getRaiseInbox(): Promise<string>;
    setRaiseInbox(
      accelerator: string,
    ): Promise<
      | { ok: true; accelerator: string }
      | { ok: false; error: "empty" | "register_failed" }
    >;
    /** 设置页录制时暂停/恢复全局「唤起收件箱」快捷键。 */
    setRaiseInboxRecording(recording: boolean): Promise<void>;
    /** 全局快捷键唤起/切换统一收件箱；toggle=true 时若已在收件箱则隐藏窗口。 */
    onRaiseInbox(cb: (payload: { toggle: boolean }) => void): () => void;
  };
  tray: {
    /** 后台收到实时 inbox 消息时发送系统通知；Windows 同时闪烁托盘。 */
    notifyIncoming(payload: {
      kind: "user" | "assistant";
      text?: string;
      hasMedia?: boolean;
    }): Promise<void>;
    /** 同步统一收件箱是否仍有 active turn。 */
    setStreaming(active: boolean): Promise<void>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

// ---------------------------------------------------------------------------
// react-syntax-highlighter sub-module declarations
// ---------------------------------------------------------------------------

declare module "react-syntax-highlighter/dist/esm/prism-async-light" {
  import { ComponentType } from "react";
  interface SyntaxHighlighterProps {
    language?: string;
    style?: Record<string, unknown>;
    PreTag?: string | ComponentType;
    CodeTag?: string | ComponentType;
    children?: string;
    [key: string]: unknown;
  }
  const SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
  export default SyntaxHighlighter;
  export function registerLanguage(name: string, language: unknown): void;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism/one-dark" {
  const style: Record<string, unknown>;
  export default style;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism/one-light" {
  const style: Record<string, unknown>;
  export default style;
}

export {};
