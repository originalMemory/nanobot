# Spec: emoji-picker（Electron 输入框）

## Why
- 输入框无法快速插入 emoji，需要切换系统输入法
- 用户与 AI 聊天时插入 emoji 是高频需求；`:shortcode` / 中文关键词补全可减少点选步骤

## Scope
- 本次要做
  - 安装 `emoji-picker-react`（替代 emoji-mart）
  - 工具栏笑脸按钮，点击弹出 `EmojiPicker`（`emojiStyle=NATIVE`，`suggestedEmojisMode=FREQUENT`）
  - 按界面语言加载 `emojis-zh` / `emojis-en`；主题跟随 `useThemeValue`（`Theme.DARK` / `LIGHT`）
  - 选中 emoji 插入 textarea 光标处；与 Picker 共用 `localStorage` 键 `epr_suggested` 记录最近/常用（最多 14 条）
  - 输入 `:query` 或全角 `：query`（行前或空白后）弹出内联补全面板（最多 8 条）；↑/↓ 选中时 `scrollIntoView`
  - `InboxView` 拉取并传入 `listSlashCommands` / `fetchCliApps` / `fetchMcpPresets`（修复 `/`、`@` 无数据）
  - i18n：`thread.composer.emoji.*`（按钮、补全标签、搜索占位）
  - 单元测试：`emoji-colon.test.ts`（解析、过滤、unified→native）
- 本次不做
  - webui 侧 emoji Picker 迁移（仅同步列表键盘 `scrollIntoView`）
  - 自定义 emoji 集合

## Plan
- [x] `electron/` 安装 `emoji-picker-react`，移除 emoji-mart 相关依赖
- [x] `electron/.npmrc`：`legacy-peer-deps=true`（React 19 兼容）
- [x] `ThreadComposer`：工具栏 Smile 按钮 + Picker popover；点击外部 / Esc 关闭
- [x] `emoji-picker-data.ts`：候选列表、中英文过滤、最近读取、`recordEmojiSuggestion`
- [x] `emoji-colon.ts`：`parseEmojiColonQuery`（`:` / `：`）、展示名
- [x] 插入逻辑：colon 替换整段（含冒号）；Picker 选中后 `recordEmojiSuggestion` + 关面板
- [x] `InboxView` 数据加载并下传 `ThreadComposer` / `ThreadViewport`

## Apply Notes
- 不用懒加载：Picker 与数据包随 composer 打包，换库后体积可接受
- 中文候选 `n[0]` 常为 CLDR 单字 → `pickChineseLabel` 取更长标签；列表 `:tag` 用 `emojis-en` 建的 `shortcodeByUnified`，避免显示 unified 十六进制
- 正则须用字面量 `/(?:^|\s)[:：](...)$/iu`；勿在模板字符串里写 `\u4e00`（会被 JS 先解析成汉字）
- colon 与 URL：要求 `(?:^|\s)` 前缀，避免 `http://` 误触发
- Picker 与 slash/mention 列表共用 `useScrollSelectedListboxOptionIntoView`

## Verify
- [x] 笑脸按钮开关 Picker；选中插入光标后并保持 focus
- [x] 有选区时插入替换选区
- [x] dark / light 下 Picker 主题正确
- [x] 中文界面：Picker 与 `：` 补全显示中文名；英文界面显示英文 shortcode
- [x] `:smi` / `：笑` 过滤候选；`http://` 不触发
- [x] Picker 与 `:` 空查询默认列表与最近使用一致（`epr_suggested`）
- [x] `/`、`@` 在 Inbox 输入框可弹出命令 / mention 列表
- [x] `npm test -- --run emoji-colon` 通过

## Status
- State: done
- Archived: yes
