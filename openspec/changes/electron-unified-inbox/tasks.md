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

## 5. Electron 应用基础架构

- [x] 5.1 创建 `electron/` 目录结构：入口文件（`src/main.ts`、`src/preload.ts`、`src/renderer.ts`）保持在 `src/` 根，功能模块在 `src/main/`（主进程）和 `src/renderer/`（渲染进程）内按功能拆子目录
- [x] 5.2 配置 Electron 构建工具链：使用 Electron Forge（`create-electron-app --template=vite-typescript`），内置 Vite 插件、makers（zip/deb/rpm/squirrel）和 fuses 安全配置，无需额外 electron-builder
- [ ] 5.3 实现主进程：窗口管理、系统托盘、本地配置持久化（`electron-store`）
- [ ] 5.4 实现 WebSocket 连接管理：自动连接、断线重连（指数退避）、使用持久化 chat_id attach
- [x] 5.5 配置开发环境：Forge+Vite 已提供热重载（`npm start`），`main.ts` 默认开启 DevTools

## 6. Electron 统一 Inbox 视图

- [ ] 6.1 实现消息列表组件：渲染统一时间线，支持 `source_channel` 标签
- [ ] 6.2 实现消息输入组件：文本输入、发送按钮
- [ ] 6.3 实现历史加载：启动时通过 `GET /api/inbox/thread` 拉取历史
- [ ] 6.4 实现实时消息更新：通过 WebSocket 接收 fan-out 推送，追加到视图
- [ ] 6.5 实现侧边栏导航：统一收件箱 + 各通道视图切换（基于 `source_channel` 过滤）

## 7. 截屏集成

- [ ] 7.1 实现 `desktopCapturer` 截屏功能：快捷键触发、截图预览
- [ ] 7.2 截图作为 `media` 附件通过 WebSocket 发送到 gateway
