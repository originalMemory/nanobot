## Why

Electron 当前通过相邻位置、流式状态和消息类型猜测多条 assistant 消息是否属于同一轮，并将它们强制聚合展示。该逻辑已经造成直播消息偶发遗漏、主动推送串入当前回复以及历史回放与实时展示不一致，继续增加补丁的维护成本高于聚合本身的价值。

## What Changes

- **BREAKING**：删除 Electron 旧的 assistant 回复聚合展示，不再把一轮中的多段 assistant 正文合成单条气泡。
- 在 WebSocket 请求、实时事件、transcript 和 Electron 消息模型中传递 `turnId`、`turnPhase`、`turnSeq`。
- 按 turn 元数据组织用户消息、Activity、中途回复和最终回复，同时保留各段原始消息。
- 同一 turn 只在第一条可见 assistant 回复展示头像、名称和来源，只在最后一条展示 footer、token/context 和轮次操作。
- 保留 Electron 的动态壁纸、TTS、音频、Activity/File Diff、统一会话和主动推送展示；Activity 的去重、折叠和自动收起完整采用备份分支。
- 整个对话视口增加统一半透明背景，覆盖左右留白和底部输入区，不使用模糊，也不重新给每条 assistant 正文套气泡。
- 不提供旧聚合逻辑或缺失 turn 元数据时的客户端 fallback。

## Capabilities

### New Capabilities

- `electron-turn-aware-messages`: Electron 基于明确 turn 元数据展示多段 assistant 回复、Activity、身份和 footer。

### Modified Capabilities

无。

## Impact

- 影响 WebSocket ingress/egress、transcript 写入与回放、Electron client 类型和流式状态管理。
- 影响 `electron/src/renderer/components/thread/` 的消息组织、assistant 气泡身份/footer 和 Activity 归属。
- 需要将 v0.3.0 已有的 turn 元数据契约移植到独立 Electron renderer，但不修改或加载 root `webui/`。
- 已有缺少 turn 元数据的 transcript 需要由后端回放阶段生成稳定的 turn 归属，Electron 不再自行猜测聚合关系。
