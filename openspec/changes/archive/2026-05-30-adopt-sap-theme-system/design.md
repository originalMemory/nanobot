## Context

当前 Electron 客户端采用 shadcn/ui 标准的双主题方案（light/dark），通过 `globals.css` 中 `:root` / `.dark` 定义 HSL 分量 token，Tailwind `darkMode: ["class"]` 驱动 `dark:` 变体。

Super Agent Party (SAP) 拥有成熟的 9 主题体系（light/dark/midnight/desert/neon/marshmallow/ink/party/rainbow），采用 `[data-theme="xxx"]` 属性选择器 + 完整色值（hex/rgb）。SAP 是 Vue + Element Plus 技术栈，与 nanobot 的 React + Tailwind + shadcn 完全不同。

本设计的核心挑战：**在保持 Tailwind + shadcn 架构不变的前提下，将 SAP 的色彩体系和特效移植过来**。

## Goals / Non-Goals

**Goals:**
- 将 SAP 9 个主题的色彩完整移植到 nanobot Electron 客户端
- 保持 Tailwind utility-first 开发体验不变
- 所有现有 shadcn 组件无需单独修改即可适配新主题
- 移植 SAP 特色视觉效果（水墨 texture、rainbow 渐变、neon glow 等）
- 主题切换平滑过渡，持久化存储

**Non-Goals:**
- 不引入 Element Plus 或任何新 CSS 框架
- 不从 Tailwind 迁走，不改 inline utility class 写法
- 不涉及 webui/ 子项目（仅 Electron）
- 不实现用户自定义主题 / 颜色编辑器
- 不复制 SAP 的代码高亮配色（nanobot 用 shiki，与 hljs 体系不同）

## Decisions

### D1: Token 格式 — 保持 HSL 分量，从 SAP hex 值转换

**选择**: 将 SAP 的 hex 色值（如 `#fdfdfc`）转换为 HSL 分量（如 `40 33% 99%`），填入 `globals.css` 的 `[data-theme]` 块。

**理由**: shadcn/ui 的 Tailwind 映射依赖 `hsl(var(--token))` 格式，改格式意味着重写整个 tailwind.config 和所有组件的 opacity modifier（如 `bg-primary/90`）。保持 HSL 格式改动最小。

**替代方案**: 改用 oklch() 或直接 hex — 会破坏 Tailwind opacity modifier，需要 Tailwind v4 才能原生支持。

### D2: 主题切换机制 — 从 class 改为 data-attribute + 暗色标记 class

**选择**:
- 主切换：`<html data-theme="midnight">` 属性选择器
- 暗色系主题（dark/midnight/neon）同时加 `class="dark"` 保持 `dark:` 变体兼容
- `tailwind.config.js` 改为 `darkMode: ["selector", '[data-theme="dark"], [data-theme="midnight"], [data-theme="neon"]']`

**理由**: 这样做可以：
1. 支持 9+ 主题而非仅 2 个
2. 保持现有 `dark:*` class 全部有效（约 50-100 处）不需要逐一修改
3. 与 SAP 的 `data-theme` 属性方案一致

**替代方案**: 全部用 CSS 变量消除 `dark:` 变体 — 改动量太大，且部分色彩（如 `dark:border-white/10`）无对应 token。

### D3: Token 映射策略 — SAP 变量到 shadcn token 的对应关系

| SAP 变量 | shadcn token | 说明 |
|----------|-------------|------|
| `--bg-color` | `--background` | 主背景 |
| `--text-color` | `--foreground` | 主文字 |
| `--el-color-primary` | `--primary` | 主色 |
| `--el-bg-color-page` | `--muted` | 页面底色/次级背景 |
| `--el-text-color-secondary` | `--muted-foreground` | 次级文字 |
| `--border-color` | `--border` | 边框 |
| `--el-input-bg-color` | `--input` | 输入框背景 → 用于 border 色 |
| `--card-shadow` | `--card-shadow`（新增） | 卡片阴影 |
| `--el-color-primary` (白字时) | `--primary-foreground` | 主色上的文字 |
| `--code-bg` | `--code-bg`（新增） | 代码块背景 |

对于 SAP 中没有直接对应的 shadcn token（如 `--secondary`、`--accent`、`--popover`），根据各主题的色彩逻辑推导：
- `--card` / `--popover`: 通常与 `--bg-color` 相同或更浅
- `--secondary`: 从 `--el-bg-color-page` 派生
- `--accent`: 从 `--el-color-primary` 的 light-9 色阶派生
- `--ring`: 与 `--el-color-primary` 相同

### D4: 特效实现 — 通过 `[data-theme]` 选择器 + 额外 CSS class

**选择**: 在 `globals.css` 的 `@layer utilities` 中，用 `[data-theme="rainbow"]` 等选择器定义主题专属特效。

移植的特效清单：
- **全局**: `--transition-duration: 0.3s` + `--transition-function` 统一过渡
- **Rainbow**: body 径向渐变背景、磨砂玻璃 sidebar、彩虹滚动条
- **Neon**: 发光 box-shadow、荧光 border
- **Ink**: `--ink-bg-texture` 宣纸纹理 background-image
- **Marshmallow**: 柔光粉色阴影

**不移植的**: SAP 中针对 Element Plus 组件的 `.el-button--primary`、`.el-menu-item` 等特效，因为 nanobot 没有这些组件。

### D5: useTheme hook 重构

```typescript
type Theme = "light" | "dark" | "midnight" | "desert" | "neon" | "marshmallow" | "ink" | "party" | "rainbow";

const DARK_THEMES: Theme[] = ["dark", "midnight", "neon"];

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  if (DARK_THEMES.includes(theme)) {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}
```

持久化路径不变：electron-store `appearance.theme`，类型从 `"light" | "dark"` 扩展为 9 值枚举。

### D6: 设置 UI — 主题网格选择器

在 AppearanceSection 中，将 light/dark 分段控件替换为一个 3×3 网格（或横向滚动卡片），每个主题展示：
- 色彩预览块（主色 + 背景色 + 文字色小方块）
- 主题中文名（如"水墨"、"荧光"、"棉花糖"）

## Risks / Trade-offs

| 风险 | 缓解措施 |
|------|----------|
| `dark:*` class 与新暗色主题不完全匹配（如 midnight 的蓝调 vs dark 的灰调） | 暗色系统一加 `.dark` class；颜色差异通过 CSS 变量自动解决，`dark:` 只用于结构性切换 |
| 部分组件硬编码颜色（如 `border-black/[0.06]`）在彩色主题下不协调 | 可后续逐步替换为 token 引用；初期接受轻微不一致 |
| 9 主题的 CSS 变量增加 globals.css 体积（~300 行） | 可接受，CSS 体积增量 < 5KB，不影响性能 |
| rainbow/neon 等花哨主题可能与 shadcn 简约组件风格冲突 | 特效限定在 body 背景/阴影/滚动条等外围元素，不侵入组件内部 |
| shiki 代码高亮不跟随主题变化 | 已有 `useThemeValue()` 在 dark/light 切换 highlighter 主题；可后续扩展为 9 主题映射，但 MVP 阶段只分「亮色系 → one-light」「暗色系 → one-dark」 |
