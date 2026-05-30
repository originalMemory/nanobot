## 1. 后端 Avatar 路由

- [x] 1.1 在 `nanobot/channels/websocket.py` 的 `_dispatch_http` 中新增 `/api/avatar` 路由，调用新方法 `_handle_avatar_fetch`
- [x] 1.2 实现 `_handle_avatar_fetch`：从 `get_media_dir()` 按优先级查找 `avatar.{jpg,png,webp}`，找到则返回文件内容+MIME，否则 404
- [x] 1.3 在 `nanobot/webui/settings_api.py` 的 settings 返回中新增 `bot_avatar_url` 字段：检测 avatar 文件是否存在，存在返回 `"/api/avatar"`，否则 `null`

## 2. 前端类型更新

- [x] 2.1 在 `webui/src/lib/types.ts` 和 `electron/src/renderer/lib/types.ts` 的 `SettingsPayload.agent` 中新增 `bot_avatar_url: string | null` 字段

## 3. WebUI BotIdentityContext + 展示

- [x] 3.1 创建 `webui/src/contexts/BotIdentityContext.tsx`，导出 `BotIdentityProvider` 和 `useBotIdentity` hook，类型 `{ botName: string; botIcon: string; botAvatarUrl: string | null }`
- [x] 3.2 在 `webui/src/components/thread/ThreadShell.tsx` 中，从 settings state 读取 `bot_name` / `bot_icon` / `bot_avatar_url`，用 `BotIdentityProvider` 包裹 `ThreadViewport`
- [x] 3.3 在 `webui/src/components/MessageBubble.tsx` 的 assistant 分支中，调用 `useBotIdentity()`，将外层 div 改为两列 flex（左列 32px `flex-none items-end`，右列 `flex-1`）；左列渲染 24×24 圆形头像（`<img>` 优先，`onError` 降级 emoji/首字母大写）；右列保持现有内容结构不变
- [x] 3.4 将 `botName` 文字加入 footer row（copy + latency 所在 div）的最左侧，`text-xs font-medium`
- [x] 3.5 处理边界情况：空内容流式消息（TypingDots）不使用两列布局，不显示头像和 botName；trace 消息不展示

## 4. Electron BotIdentityContext + 展示

- [x] 4.1 创建 `electron/src/renderer/contexts/BotIdentityContext.tsx`（与 WebUI 同构）
- [x] 4.2 在 `electron/src/renderer/App.tsx` 中，从 settings state 读取对应字段，用 `BotIdentityProvider` 包裹渲染树
- [x] 4.3 在 `electron/src/renderer/components/MessageBubble.tsx` 的 assistant 分支中，同 WebUI 方案实现两列布局（注意 Electron 中 avatar URL 需通过 `resolveMediaUrl` 拼上 apiBase）
- [x] 4.4 处理边界情况（同 3.5）

## 5. 测试

- [x] 5.1 在 `tests/channels/` 中添加后端测试：`/api/avatar` 路由——有文件返回 200、无文件返回 404、优先级正确
- [x] 5.2 在 `webui/src/tests/message-bubble.test.tsx` 中添加前端测试：验证 assistant 消息渲染身份行、avatar 降级逻辑、user/trace 消息不展示
