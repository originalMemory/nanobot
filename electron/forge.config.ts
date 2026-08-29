import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { APP_EXECUTABLE, APP_ID, APP_NAME } from './app.meta';

const LOCAL_MAC_SIGN_IDENTITY = 'Nanobot Local Code Signing';

function macSignIdentity(): string {
  const configured = process.env.NANOBOT_MAC_SIGN_IDENTITY?.trim();
  if (configured) return configured;
  if (process.platform !== 'darwin') return '-';
  try {
    const identities = execFileSync(
      '/usr/bin/security',
      ['find-identity', '-v', '-p', 'codesigning'],
      { encoding: 'utf8' },
    );
    if (identities.includes(`"${LOCAL_MAC_SIGN_IDENTITY}"`)) {
      return LOCAL_MAC_SIGN_IDENTITY;
    }
  } catch {
    // 钥匙串不可用时保留原有 ad-hoc 打包能力。
  }
  return '-';
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId: APP_ID,
    executableName: APP_EXECUTABLE,
    // 优先使用独立的本地证书，保持钥匙串访问身份跨构建稳定；
    // 其他机器找不到证书时回退 ad-hoc，避免阻断开发打包。
    osxSign: {
      identity: macSignIdentity(),
      identityValidation: false,
      optionsForFile: () => ({
        hardenedRuntime: false,
        timestamp: 'none',
      }),
    },
    // 不带后缀：Forge 按平台自动选 .icns(macOS) / .ico(Windows) / .png(Linux)
    // 对应文件需预先放在 assets/ 目录下
    icon: path.resolve(__dirname, 'assets', 'icon'),
    extraResource: [path.resolve(__dirname, 'assets'), path.resolve(__dirname, 'avatar-videos')],
    win32metadata: {
      CompanyName: APP_NAME,
      FileDescription: APP_NAME,
      ProductName: APP_NAME,
      InternalName: APP_EXECUTABLE,
    },
    // 默认从 GitHub 解析 Electron 下载地址，国内网络可能长时间无响应；改用镜像
    download: {
      mirrorOptions: {
        mirror: 'https://npmmirror.com/mirrors/electron/',
      },
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: APP_NAME,
      setupIcon: path.resolve(__dirname, 'assets', 'icon.ico'),
    }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      // 登录信息由 electron-store / localStorage 管理；关闭 Chromium Cookie 加密，
      // 避免打包应用启动时访问 macOS 的「Nanobot Safe Storage」钥匙串。
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
