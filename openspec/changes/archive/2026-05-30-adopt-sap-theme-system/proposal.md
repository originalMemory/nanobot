## Why

当前 Electron 客户端仅支持 light/dark 两个主题，视觉上较为单调。Super Agent Party (SAP) 项目已建立了一套成熟的 9 主题色彩体系（light/dark/midnight/desert/neon/marshmallow/ink/party/rainbow），视觉效果丰富且经过验证。将 SAP 的主题体系移植到 nanobot Electron 客户端，可以显著提升用户的个性化体验，同时复用已有设计资产而非从零设计。

## What Changes

- **多主题色彩 Token**：将 SAP 9 个主题的色值转换为 HSL 分量格式，注入 `globals.css` 的 `[data-theme]` 块，替换现有的 `:root` / `.dark` 双主题方案
- **主题切换机制**：从 `<html class="dark">` 切换改为 `<html data-theme="xxx">` 属性切换，与 SAP 保持一致
- **Tailwind darkMode 适配**：将 `darkMode: ["class"]` 改为 selector-based 策略，使暗色系主题（dark/midnight/neon）自动激活 `dark:` 变体
- **SAP 特色视觉效果**：移植水墨主题 texture、rainbow 渐变 border、neon glow shadow 等特效 CSS
- **全局过渡动画**：引入 `--transition-duration` / `--transition-function` token 统一动画节奏
- **主题选择器 UI**：设置页从 light/dark 分段控件扩展为 9 主题网格/下拉选择器
- **侧边栏切换按钮**：适配多主题（如改为循环切换或弹出选择器）

## Capabilities

### New Capabilities
- `multi-theme-tokens`: SAP 9 主题的 CSS 变量体系（色彩、阴影、过渡动画），以 HSL 分量格式定义在 globals.css 的 `[data-theme]` 块中
- `theme-visual-effects`: SAP 特色视觉效果（水墨 texture、rainbow 渐变、neon glow、marshmallow 柔光等）

### Modified Capabilities
- `electron-local-preferences`: 主题偏好从 `"light" | "dark"` 二选一扩展为 9 个主题值；`appearance.theme` 的 schema 和默认值需更新

## Impact

- **`electron/src/globals.css`**：重写，从 ~60 行变量扩展到 ~300 行（9 主题 × ~30 变量）
- **`electron/tailwind.config.js`**：darkMode 策略变更 + 可能新增 color 映射
- **`electron/src/renderer/hooks/useTheme.ts`**：切换逻辑从 classList 改为 data-theme attribute，支持 9 主题
- **`electron/src/renderer/components/settings/AppearanceSection.tsx`**：主题选择 UI 重构
- **`electron/src/renderer/components/InboxSidebar.tsx`**：主题切换按钮适配
- **`electron/src/main.ts`**：electron-store schema 中 theme 默认值/类型可能调整
- **散落的 `dark:*` Tailwind class**：约 50-100 处需审查，大部分可通过暗色主题自动加 `.dark` class 兼容
- **依赖**：无新 npm 依赖，纯 CSS + hook 逻辑变更
