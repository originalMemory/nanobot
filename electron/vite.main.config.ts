import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** 将 assets 复制进 main 构建产物，打包后位于 app.asar/.vite/build/assets/ */
function copyAppAssets(): Plugin {
  const assetsDir = path.resolve(__dirname, 'assets');

  return {
    name: 'copy-app-assets',
    closeBundle() {
      const outAssets = path.resolve(__dirname, '.vite/build/assets');
      mkdirSync(outAssets, { recursive: true });
      if (!existsSync(assetsDir)) {
        console.warn('[copy-app-assets] 未找到 assets 目录:', assetsDir);
        return;
      }
      cpSync(assetsDir, outAssets, { recursive: true, force: true });
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  plugins: [copyAppAssets()],
});
