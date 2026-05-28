/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

// Extend Electron's App interface for custom quit flag
declare namespace Electron {
  interface App {
    isQuitting: boolean;
  }
}
