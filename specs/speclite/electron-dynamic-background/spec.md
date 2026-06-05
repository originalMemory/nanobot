# Spec: electron-dynamic-background

## Why
- Electron 主界面纯色背景单调，希望有定时轮换的全局壁纸增强氛围。
- 壁纸从可配置 URL 拉取；窗口隐藏到托盘时不浪费请求；页面表层背景半透明以透出壁纸。

## Scope
- 本次要做：主进程定时从 URL 拉取图片，经 IPC 推给 renderer；仅 `mainWindow.isVisible() && !mainWindow.isMinimized()` 时轮换。
- 本次要做：`electron-store` 持久化 `appearance.wallpaper.url`（默认见下）与 `appearance.wallpaper.intervalMinutes`（默认 `1`）。
- 本次要做：renderer 根层固定全屏壁纸层；启用壁纸时 `--background` / `--card` / `--sidebar` / `--popover` / `--muted` / `--secondary` / `--accent` 等表层 token 改为带 alpha 的 HSL，透出壁纸。
- 本次要做：设置页「外观」增加壁纸 URL、更新间隔（分钟）编辑与保存；preload + `declarations.d.ts` 补 API；中英文 i18n。
- 本次不做：壁纸开关（始终启用，空 URL 视为关闭轮换）；webui 浏览器版；图片缓存到磁盘；离线占位图。
- 本次不做：改聊天气泡、按钮、输入框等非表层实色元素（保持可读性）。

默认 URL：
`https://nas.xuanniao.fun:49150/api/moneyAccounting/random-image?type=1,2,3&level=5,6,7,8&orientation=2&maxResolutionLevel=2`

## Plan
- [x] `AppConfig` / store defaults 增加 `appearance.wallpaper: { url, intervalMinutes }`。
- [x] `main.ts`：壁纸服务——读配置、`fetch` 拉图、转 data URL；`setInterval` 按分钟轮换；监听 `show`/`hide`/`minimize`/`restore` 启停定时器；窗口可见时立即拉一张；`webContents.send('wallpaper:update', dataUrl)`；配置变更时重启定时器。
- [x] `preload.ts` + `declarations.d.ts`：`wallpaper.onUpdate(cb)`、`wallpaper.getConfig()` / `wallpaper.setConfig()`。
- [x] `globals.css`：`[data-wallpaper="on"]` 用 `color-mix` 半透明表层 token；禁用 ink/rainbow body 纹理；壁纸层 `bg-cover bg-center`。
- [x] `App.tsx` / `WallpaperLayer`：根节点壁纸层，订阅 IPC；首张到达后设 `data-wallpaper=on`。
- [x] `AppearanceSection`：URL + 间隔（分钟）输入，保存走 `wallpaper:set-config`。
- [x] i18n：`settings.sections/rows/help/placeholders/errors` 壁纸键。
- [ ] 手动验证：可见时轮换、隐藏暂停、改配置生效、各主题半透明可读。

## Apply Notes
- 可见判定用 `isVisible() && !isMinimized()`，与截屏快捷键的 `isFocused()` 不同；失焦但窗口仍在前台时继续轮换。
- 拉图放主进程：`electron.net.fetch` 或 Node `fetch`，避免 renderer CORS/混合内容；失败时保留上一张，不打断 UI。
- 定时器：`intervalMinutes * 60_000`；hide/minimize 时 `clearInterval`；show/restore 时立即 fetch 一次再重启 interval。
- 半透明实现优先改 `globals.css` 中 `[data-wallpaper="on"]` 的 CSS 变量 alpha，不动各 `[data-theme]` 色相；`ink`/`rainbow` 的 `body` 特殊 `background-image` 与壁纸层冲突——启用壁纸时禁用主题 body 纹理/渐变（`data-wallpaper` 优先级更高）。
- 壁纸层 z-index 置于内容之下；`ElectronFrame` 的 `bg-background` 等随 token 变半透明。
- URL 为空或非法时：不启动定时器、不发 update、renderer 去掉 `data-wallpaper` 回退纯色。

## Verify
- [ ] 首次启动（默认 URL + 1 分钟）：窗口可见后数秒内出现壁纸，约 1 分钟后自动换图。
- [ ] 关闭窗口到托盘：等待超过间隔时间，网络无新请求（可用 DevTools Network 或日志确认）；托盘「显示」后立即换图并恢复定时。
- [ ] 设置页改 URL 保存：下一张来自新地址；改间隔为 3 分钟：约 3 分钟轮换一次。
- [ ] 设置页清空 URL 保存：壁纸消失，界面回退不透明纯色背景。
- [ ] 切换 light/dark/neon 等主题：表层半透明，壁纸仍可见，文字与气泡可读。
- [ ] 重启应用后 URL 与间隔配置保留。

## Status
- State: done
- Archived: no
