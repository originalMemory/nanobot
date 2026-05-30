## Why

Electron 设置 UI 缺少 `maxTokens`、`contextWindowTokens`、`maxMessages` 三个关键模型/会话参数的配置入口，用户只能手动编辑 `config.json`。同时，nanobot 后端已在运行时追踪每轮 token 用量（input/output/cache），但未通过 WebSocket 下发给前端，导致用户无法在对话中直观看到 token 消耗和上下文窗口占用情况。OpenClaw 已有此能力（↑in ↓out R/W cache · ctx%），nanobot 应对齐。

## What Changes

- **Electron 设置 UI 扩展**：在模型分区（ModelsSection）中增加 `maxTokens`（单次回复上限）、`contextWindowTokens`（上下文窗口大小）、`maxMessages`（回放历史条数上限）三个数字输入字段，通过现有 `/api/settings/update` 端点保存。
- **Token 用量后端持久化与下发**：在 agent loop 结束时将 `usage` dict（prompt_tokens, completion_tokens, cached_tokens, cache_creation_tokens）写入 assistant 消息 metadata，并通过 `turn_end` WebSocket 帧下发给前端；transcript 回放同步支持。
- **气泡底部 token 用量展示**：在 MessageBubble 的 assistant footer 中，耗时标签左侧增加 token 用量行，格式为 `↑1.2k ↓340 R62.3k 32% ctx`，显示输入 token、输出 token、缓存命中 token、上下文窗口占用百分比。数字超过 1000 自动缩写为 k。

## Capabilities

### New Capabilities
- `token-usage-display`: 在 Electron 对话气泡底部展示每轮 token 用量统计（input/output/cache/context%），涵盖后端 usage 持久化、WebSocket 协议扩展、前端 UI 渲染。

### Modified Capabilities
- `electron-settings-ui`: 模型分区新增 maxTokens、contextWindowTokens、maxMessages 三个配置字段的编辑能力。

## Impact

- **后端**：`nanobot/agent/loop.py`（usage 持久化 + turn_end 元数据）、`nanobot/channels/websocket.py`（turn_end 帧扩展）、`nanobot/webui/transcript.py`（transcript 回放映射）
- **协议**：WebSocket `turn_end` 事件增加 `usage` 对象；`message` 事件 assistant 消息增加 `usage` 字段
- **前端类型**：`electron/src/renderer/lib/types.ts`（UIMessage 增加 usage 字段、InboundEvent turn_end 扩展）
- **前端组件**：`electron/src/renderer/components/MessageBubble.tsx`（footer token stats）、`electron/src/renderer/hooks/useNanobotStream.ts`（解析 usage）、`electron/src/renderer/components/settings/ModelsSection.tsx`（新增配置项）
- **国际化**：`electron/src/renderer/i18n/locales/*/common.json`（新增 token 相关翻译 key）
- **测试**：需补充 WebSocket turn_end usage 下发测试、MessageBubble footer 渲染测试
