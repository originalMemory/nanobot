## Why

配置中已有 `botName` 和 `botIcon`，但前端（WebUI / Electron）聊天界面中 AI 回复旁没有展示任何 bot 身份信息。目前这两个字段仅在 CLI 终端的 `StreamRenderer` header 中使用。用户希望在聊天消息流中看到 bot 的名称和图片头像，使对话体验更接近真实聊天应用。

## What Changes

- 在 WebUI 和 Electron 的 assistant 消息旁展示 bot 身份标识（圆形头像图片 + `botName`）
- 后端新增 `/api/avatar` 公开路由，从 media 根目录读取 `avatar.{jpg,png,webp}`，不存在则 404
- 后端 settings API 返回新增 `bot_avatar_url` 字段（avatar 文件存在时返回 `/api/avatar`，否则 `null`）
- 前端优先展示图片头像；图片加载失败或无 avatar 文件时，降级为 `botIcon` emoji 圆形背景
- `botIcon`（emoji）保留作为降级头像展示，不再仅用于 CLI

## Capabilities

### New Capabilities
- `bot-identity-in-thread`: 在聊天消息流中展示 bot 身份标识（圆形头像 + 名称），位于 assistant 消息左侧

### Modified Capabilities

（无需修改现有 spec）

## Impact

- **后端**: WebSocket channel 新增 `/api/avatar` 路由；settings API 新增 `bot_avatar_url` 字段
- **前端组件**: `MessageBubble`（webui + electron）、`ThreadMessages`，需要新增 bot identity 展示逻辑
- **状态管理**: 需要将 settings 中的 `bot_name` / `bot_icon` / `bot_avatar_url` 通过 Context 传递到 thread 组件树
- **配置**: 复用现有 `agents.defaults.botName` / `agents.defaults.botIcon`；头像图片为约定路径 `~/.nanobot/media/avatar.{jpg,png,webp}`
