## 1. 稳定主会话 ID（stable-session-attach）

- [x] 1.1 修改 `_connection_loop`：解析 WebSocket 连接 URL 的 `chat_id` query param，存在时用作 `default_chat_id`（替代 `uuid.uuid4()`）
- [x] 1.2 增强 `_dispatch_envelope` 的 `attach` 分支：对不存在的 `chat_id` 自动创建 session（通过 `SessionManager.get_or_create`）
- [x] 1.3 增强 `_is_valid_chat_id` 校验函数：拒绝路径遍历字符、限制长度 ≤ 128、只允许字母数字连字符下划线
- [x] 1.4 为稳定 chat_id 编写单元测试：覆盖 URL param 指定、attach 恢复、非法 ID 拒绝场景

## 2. 统一 Transcript 写入

- [x] 2.1 在 `WebSocketChannel.send()` 中增加统一 transcript 双写：`unifiedSession: true` 时，消息同时 append 到 `unified:default` transcript，携带 `source_channel` 和 `source_chat_id`
- [x] 2.2 处理非 WebSocket 通道的出站消息双写：在 `AgentLoop` 或 bus outbound handler 中，当 `unifiedSession: true` 时拦截所有通道出站消息写入统一 transcript
- [x] 2.3 处理入站消息的统一 transcript 写入：在消息进入 Agent 处理之前（或之后），将入站 user 消息也写入统一 transcript
- [x] 2.4 为统一 transcript 双写编写单元测试

## 3. WebSocket Fan-out

- [x] 3.1 在 `_dispatch_envelope` 中支持 `inbox:unified` 作为特殊 attach 目标：Electron 客户端 attach 到该频道以订阅所有通道消息
- [x] 3.2 修改 `send()` 方法：`unifiedSession: true` 时，除推送给原 `chat_id` 订阅者外，也推送给 `inbox:unified` 订阅者，事件携带 `source_channel`
- [x] 3.3 实现非 WebSocket 通道消息的 fan-out：当其他通道（Telegram/Discord 等）产生入站/出站消息时，也推送给 `inbox:unified` 订阅者
- [x] 3.4 处理消息去重：防止 Electron 同时订阅自身 chat_id 和 `inbox:unified` 时收到重复消息
- [x] 3.5 为 fan-out 编写单元测试

## 4. Inbox HTTP 端点

- [x] 4.1 在 WebSocket channel 的 HTTP 路由中新增 `GET /api/inbox/thread` 端点
- [x] 4.2 实现端点逻辑：读取 `unified:default` transcript，调用 `build_webui_thread_response` 返回 UI 消息列表
- [x] 4.3 添加认证检查（复用现有 `_check_api_token`）
- [x] 4.4 为 inbox thread 端点编写单元测试

## 5. Electron 渲染层基础设施（移植 webui）

- [x] 5.1 创建 `electron/` 目录结构（Electron Forge + vite-typescript 模板）
- [x] 5.2 配置构建工具链（Forge + Vite，热重载开箱即用）
- [x] 5.3 引入 React + Tailwind CSS + shadcn/ui 依赖，配置 PostCSS / tailwind.config / globals.css
- [x] 5.4 移植核心 lib：`types.ts`、`nanobot-client.ts`、`tool-traces.ts`、`media.ts`、`format.ts`、`thread-display-compat.ts`、`subagent-channel-display.ts`
- [x] 5.5 改造 `bootstrap.ts` / `api.ts`：baseUrl 参数化（`http://localhost:{port}`），token/secret 持久化用 `electron-store` 或 renderer localStorage
- [x] 5.6 移植 `useNanobotStream` hook（含流式状态机完整逻辑）
- [x] 5.7 移植消息渲染组件：`MessageBubble`、`MarkdownText`、`CodeBlock`、`ImageLightbox`、`AgentActivityCluster`、`ThreadMessages`、`ThreadViewport`
- [x] 5.8 移植 `ThreadComposer`（输入框、Slash 命令、图片附件）及相关 hooks（`useAttachedImages`、`useClipboardAndDrop`）

## 6. Electron 主进程

- [x] 6.1 窗口管理：合理的初始尺寸（1200×800）、窗口位置/大小记忆、macOS dock 行为
- [x] 6.2 系统托盘：关闭窗口最小化到托盘，托盘图标提供「显示」/「退出」菜单
- [x] 6.3 `electron-store` 配置持久化：使用**有层级的 schema**，为后续设置页移植预留扩展空间
  - `gateway.url`（默认 `http://localhost:8765`）、`gateway.token`、`gateway.chatId`（默认 `electron-main`）
  - `appearance.theme`
  - 预留 `providers`、`models` 命名空间（后续设置页扩展，本期留空）
- [x] 6.4 `preload.ts` IPC 桥：使用**分组命名空间**设计，避免后续 API 混乱
  - `window.electronAPI.config.get(key)` / `window.electronAPI.config.set(key, value)`
  - `window.electronAPI.screenshot.capture()`
  - 后续设置页直接复用 `config` 命名空间，无需重构

## 7. Electron 统一 Inbox 视图

- [x] 7.1 App 引导层：从 `electron-store` 读取 gateway 地址和 token，初始化 `NanobotClient`，使用持久化 `chat_id` connect 并 attach `inbox:unified`
- [x] 7.2 历史加载：连接成功后调用 `GET /api/inbox/thread`，将结果作为 `initialMessages` 传入 `useNanobotStream`
- [x] 7.3 实时消息：`inbox:unified` fan-out 推送经由 `useNanobotStream` 驱动视图更新
- [x] 7.4 `source_channel` 标签渲染：在消息气泡旁显示来源通道徽章（`[Telegram]`、`[Discord]` 等）
- [x] 7.5 侧边栏导航：「统一收件箱」固定入口 + 从 transcript 聚合的各通道入口，点击通道按 `source_channel` 过滤消息列表；**底部预留「设置」齿轮图标占位**（本期点击无响应，后续设置页接入时激活）

## 8. 截屏集成

- [ ] 8.1 主进程实现 `desktopCapturer` 截屏：注册全局快捷键，截图数据经 IPC 发送到 renderer
- [ ] 8.2 renderer 截图预览 + 确认发送：截图作为 `media` 附件复用现有 `useAttachedImages` 发送路径

---

## 后续：设置页移植（独立需求，本期不做）

> 本期完成后另开 openspec 变更（建议命名 `electron-settings`）覆盖以下内容。
> 6.3 的 store schema 和 6.4 的 IPC 命名空间已为此预留扩展口。

- [ ] S.1 移植 `SettingsView.tsx` 及子面板：Overview、Appearance、Models、Providers、
      ImageGeneration、Web、AppsCatalog、Runtime、Advanced（共 ~4600 行）
- [ ] S.2 补充设置相关 API：`/api/settings` 系列读写接口对接（`fetchSettings`、`updateSettings` 等加入 `api.ts`）
- [ ] S.3 `electron-store` 中 `providers` / `models` 命名空间落地（与 S.2 联动）
- [ ] S.4 侧边栏「设置」齿轮图标激活，跳转设置视图
- [ ] S.5 `LanguageSwitcher`、主题切换在 Electron 中的持久化（读写 `appearance.theme`）
