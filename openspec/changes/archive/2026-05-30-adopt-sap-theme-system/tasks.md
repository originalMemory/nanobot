## 1. 基础架构变更

- [x] 1.1 修改 `electron/tailwind.config.js` 的 `darkMode` 从 `["class"]` 改为 `["selector", '[data-theme="dark"], [data-theme="midnight"], [data-theme="neon"]']`
- [x] 1.2 在 `electron/src/globals.css` 的 `:root` 中添加 `--transition-duration: 0.3s` 和 `--transition-function: cubic-bezier(0.4, 0, 0.2, 1)` 全局过渡 token
- [x] 1.3 将 `globals.css` 中 `:root { ... }` 主题 token 块改为 `[data-theme="light"] { ... }`
- [x] 1.4 将 `globals.css` 中 `.dark { ... }` 主题 token 块改为 `[data-theme="dark"] { ... }`

## 2. 9 主题 CSS 变量定义

- [x] 2.1 将 SAP light 主题色值转换为 HSL 分量，填入 `[data-theme="light"]` 块（替换现有 shadcn neutral 值）
- [x] 2.2 将 SAP dark 主题色值转换为 HSL 分量，填入 `[data-theme="dark"]` 块
- [x] 2.3 新增 `[data-theme="midnight"]` 块，从 SAP midnight 主题转换色值
- [x] 2.4 新增 `[data-theme="desert"]` 块，从 SAP desert 主题转换色值
- [x] 2.5 新增 `[data-theme="neon"]` 块，从 SAP neon 主题转换色值
- [x] 2.6 新增 `[data-theme="marshmallow"]` 块，从 SAP marshmallow 主题转换色值
- [x] 2.7 新增 `[data-theme="ink"]` 块，从 SAP ink 主题转换色值
- [x] 2.8 新增 `[data-theme="party"]` 块，从 SAP party 主题转换色值
- [x] 2.9 新增 `[data-theme="rainbow"]` 块，从 SAP rainbow 主题转换色值

## 3. 主题特效 CSS

- [x] 3.1 添加 Rainbow 主题 body 多层径向渐变背景（`[data-theme="rainbow"] body { ... }`）
- [x] 3.2 添加 Rainbow 主题彩虹滚动条样式（`::-webkit-scrollbar-thumb` 渐变）
- [x] 3.3 添加 Neon 主题发光阴影效果（覆盖 `.chat-ai-bubble` 和 `.chat-user-bubble` 的 box-shadow）
- [x] 3.4 添加 Ink 主题宣纸纹理 background-image
- [x] 3.5 添加 Marshmallow 主题柔光粉色阴影
- [x] 3.6 添加全局主题切换过渡规则（`[data-theme] * { transition: background-color, color, border-color ... }`），但排除首次加载

## 4. useTheme hook 重构

- [x] 4.1 定义 `Theme` 联合类型（9 个主题值）和 `DARK_THEMES` 常量
- [x] 4.2 重写 `applyTheme()` 函数：设置 `data-theme` 属性 + 条件添加/移除 `.dark` class
- [x] 4.3 更新 `getInitialTheme()`：从 electron-store 读取，fallback 到 `"light"`，无效值处理
- [x] 4.4 更新 `setTheme()`：写入 electron-store + 调用 `applyTheme()`
- [x] 4.5 添加首次加载跳过过渡动画的逻辑（如在 apply 前 body 加 `no-transition` class，requestAnimationFrame 后移除）

## 5. Electron Store Schema 更新

- [x] 5.1 更新 `electron/src/main.ts` 中 `appearance.theme` 的 schema 默认值和类型注释，支持 9 个主题值

## 6. 设置 UI 改造

- [x] 6.1 在 AppearanceSection 中创建主题网格选择器组件，展示 9 个主题卡片
- [x] 6.2 每个主题卡片显示色彩预览（主色 + 背景色 + 文字色小方块）和主题中/英文名
- [x] 6.3 当前选中主题高亮标记
- [x] 6.4 点击主题卡片立即切换并持久化

## 7. 侧边栏适配

- [x] 7.1 修改 InboxSidebar 的主题切换按钮，适配多主题（如改为打开主题选择 Popover、或循环切换下一个主题）

## 8. 兼容性处理

- [x] 8.1 审查项目中 `.dark .chat-ai-bubble` 等直接引用 `.dark` 选择器的自定义 CSS，确保改为 `[data-theme="dark"], [data-theme="midnight"], [data-theme="neon"]` 或利用 `.dark` class 保持兼容
- [x] 8.2 验证 `CodeBlock` 组件的 `useThemeValue()` 在多主题下正确返回 dark/light highlighter 主题
- [x] 8.3 验证所有 shadcn UI 组件（Button、Dialog、Dropdown 等）在 9 个主题下视觉正确
