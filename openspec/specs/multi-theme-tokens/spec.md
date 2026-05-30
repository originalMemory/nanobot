## ADDED Requirements

### Requirement: 9 主题 CSS 变量定义
`globals.css` SHALL 通过 `[data-theme="<name>"]` 属性选择器定义 9 个主题的完整 CSS 变量集。每个主题 SHALL 包含以下 shadcn 标准 token（HSL 分量格式，不含 `hsl()` 包装）：

- `--background`, `--foreground`
- `--card`, `--card-foreground`
- `--popover`, `--popover-foreground`
- `--primary`, `--primary-foreground`
- `--secondary`, `--secondary-foreground`
- `--muted`, `--muted-foreground`
- `--accent`, `--accent-foreground`
- `--destructive`, `--destructive-foreground`
- `--border`, `--input`, `--ring`
- `--radius`
- `--sidebar`, `--sidebar-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border`

色值 SHALL 从 SAP 项目 `static/css/styles.css` 中对应主题的 hex/rgb 值转换为 HSL 分量。

#### Scenario: light 主题变量生效
- **WHEN** `<html>` 元素设置 `data-theme="light"`
- **THEN** `--background` 的计算值对应 SAP light 主题的 `--bg-color: #fdfdfc`（转为 HSL 分量 `40 33% 99%`）
- **AND** `--primary` 对应 SAP 的 `--el-color-primary: #2a7a8c`
- **AND** 所有 Tailwind utility（如 `bg-background`、`text-foreground`）正确渲染对应色值

#### Scenario: 暗色系主题变量覆盖亮色默认
- **WHEN** `data-theme="midnight"` 被设置
- **THEN** `--background` 为深海军蓝色（对应 SAP `#0f172a`）
- **AND** `--foreground` 为浅灰白色（对应 SAP `#e2e8f0`）
- **AND** 所有组件自动呈现暗色外观

#### Scenario: 所有 9 个主题均有完整变量覆盖
- **WHEN** 遍历主题列表 `["light", "dark", "midnight", "desert", "neon", "marshmallow", "ink", "party", "rainbow"]`
- **THEN** 每个主题的 `[data-theme]` 块都定义了完整的 shadcn token 集合
- **AND** 无任何 token 遗漏导致 fallback 到其他主题值

### Requirement: data-theme 属性驱动主题切换
现有的 `:root` / `.dark` class 主题切换 SHALL 被替换为 `[data-theme]` 属性选择器方案。`globals.css` 中不再使用 `:root` 和 `.dark` 定义主题 token（可保留非主题的全局变量如 `--cjk-line-height`）。`:root` SHALL 保留一份 light 主题 token 的 fallback 值，以防 `data-theme` 属性意外缺失。

#### Scenario: globals.css 不再使用 .dark class 定义 token
- **WHEN** 检查 `globals.css` 的 `@layer base` 块
- **THEN** 主题 token 全部位于 `[data-theme="xxx"]` 选择器内
- **AND** 不存在 `.dark { --background: ... }` 形式的定义

#### Scenario: 默认主题为 light
- **WHEN** `<html>` 元素未设置 `data-theme` 属性（异常情况）
- **THEN** 应用 SHALL 在初始化时自动设置 `data-theme="light"` 作为 fallback
- **AND** `:root` 的 fallback token 确保页面在 JS 加载前不失去样式

### Requirement: Tailwind darkMode 兼容暗色系主题
`tailwind.config.js` 的 `darkMode` SHALL 配置为 selector 模式，匹配所有暗色系主题（dark、midnight、neon），使现有的 `dark:` Tailwind 变体对这些主题生效。

#### Scenario: dark: 变体在 midnight 主题下生效
- **WHEN** `data-theme="midnight"` 被设置
- **THEN** 带有 `dark:text-white` 的元素渲染为白色文字
- **AND** 带有 `dark:bg-gray-900` 的元素渲染深色背景

#### Scenario: dark: 变体在亮色主题下不生效
- **WHEN** `data-theme="marshmallow"` 被设置
- **THEN** `dark:` 前缀的 class 不生效
- **AND** 元素使用非 dark 变体的样式

### Requirement: 全局过渡动画 token
`globals.css` SHALL 在 `:root` 中定义 `--transition-duration: 0.3s` 和 `--transition-function: cubic-bezier(0.4, 0, 0.2, 1)`，供主题切换和组件动画使用。

#### Scenario: 主题切换过渡平滑
- **WHEN** 用户从一个主题切换到另一个主题
- **THEN** 背景色、文字色等属性以 `var(--transition-duration)` 时长平滑过渡
- **AND** 不出现闪烁或突变

### Requirement: useTheme hook 支持 9 主题
`useTheme` hook SHALL 支持 9 个主题值的读取、设置和持久化。它 SHALL：
1. 定义 `Theme` 类型为 9 个主题字符串的联合类型
2. 提供 `DARK_THEMES` 常量标记哪些主题属于暗色系
3. `applyTheme()` 同时设置 `data-theme` 属性和暗色系的 `.dark` class
4. `setTheme()` 写入 electron-store 并立即应用
5. 初始化时从 electron-store 读取，fallback 到 `"light"`

#### Scenario: 切换到暗色系主题
- **WHEN** 调用 `setTheme("neon")`
- **THEN** `<html>` 设置 `data-theme="neon"` 且 `class` 包含 `"dark"`
- **AND** electron-store 的 `appearance.theme` 更新为 `"neon"`

#### Scenario: 切换到亮色系主题
- **WHEN** 调用 `setTheme("marshmallow")`
- **THEN** `<html>` 设置 `data-theme="marshmallow"` 且 `class` 不包含 `"dark"`
- **AND** electron-store 的 `appearance.theme` 更新为 `"marshmallow"`

#### Scenario: 启动时恢复上次主题
- **WHEN** 应用启动且 electron-store 中 `appearance.theme` 为 `"desert"`
- **THEN** 应用以 desert 主题渲染
- **AND** `<html data-theme="desert">` 在首次绘制前设置

### Requirement: 主题选择器 UI
AppearanceSection SHALL 展示一个主题选择器（网格或卡片列表），显示所有 9 个主题供用户选择。每个主题选项 SHALL 展示：
- 主题名称（中英文，如"水墨 / Ink"）
- 色彩预览（至少包含主色、背景色、文字色的可视化表示）
- 当前选中状态标记

#### Scenario: 用户在设置中切换主题
- **WHEN** 用户点击"棉花糖"主题卡片
- **THEN** 整个应用立即切换为 marshmallow 主题
- **AND** 选中状态标记移动到该卡片
- **AND** 偏好被持久化

#### Scenario: 侧边栏主题按钮适配
- **WHEN** 存在 InboxSidebar 的主题快捷切换按钮
- **THEN** 该按钮 SHALL 以合理方式适配多主题（如打开主题选择弹窗、或循环切换）
