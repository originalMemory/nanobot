// ---------------------------------------------------------------------------
// Electron IPC bridge (injected by preload.ts via contextBridge)
// ---------------------------------------------------------------------------

type WindowAction = "show" | "hide" | "minimize" | "maximize" | "close";
type WindowState = "maximized" | "normal";

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
  app: {
    quit(): Promise<void>;
  };
  screenshot: {
    capture(): Promise<string | null>;
    /** 订阅全局快捷键触发的截图事件，返回取消监听的清理函数。 */
    onCapture(cb: (dataUrl: string) => void): () => void;
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
