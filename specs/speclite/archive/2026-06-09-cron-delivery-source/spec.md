# Spec: cron-delivery-source

## Why
- cron / heartbeat 主动投递写入统一会话时带 `_channel_delivery`，UI 只能显示「主动推送」，无法知道来自哪个任务
- `on_cron_job(job)` 执行时有 `job.id`、`job.name`，但未透传到 `_deliver_to_channel` → session / WebSocket / 重放链路
- `assistant-source-badge` spec 曾明确不做 heartbeat vs cron 区分；现补后端字段 + Electron 展示

## Scope

本次要做：
- cron / heartbeat 执行期间，将 `job.id`、`job.name` 透传到 channel delivery 镜像行
- session 消息新增字段：`_cron_job_id`、`_cron_job_name`（与 `_channel_delivery` 同条 assistant 消息）
- `_deliver_to_channel`、MessageTool metadata、WebSocket outbound、transcript 重放全链路透传
- Electron 来源徽章：有 `cronJobName` 时直接展示任务名；`cronJobName === "heartbeat"` 时 i18n「心跳」；无任务名的旧数据兜底「主动推送」
- 单元测试：MessageTool context 透传、`_deliver_to_channel` 写入、transcript wire event、Electron badge 解析

本次不做：
- WebUI（非 Electron）UI 改造
- cron 管理页 / 点击跳转任务详情
- 改 agent turn 所在 session（`cron:{id}` / `heartbeat`）里的 user/assistant 记录；只改 channel delivery 镜像行
- 历史消息回填（旧数据无字段则 UI 保持现状）

## Plan

- [x] `MessageTool`：新增 `_delivery_source_var`（`job_id` + `job_name`）；`set_delivery_source` / `reset_delivery_source`；execute 时写入 metadata `_cron_job_id` / `_cron_job_name`
- [x] `on_cron_job`（heartbeat + agent_turn 分支）：agent 执行前 `set_delivery_source(job.id, job.name)`，finally 重置；显式 `_deliver_to_channel` 调用补 metadata
- [x] `_deliver_to_channel`：从 metadata 读取并写入 session extra + outbound metadata
- [x] `nanobot/webui/transcript.py`：`session_messages_to_wire_events` / `replay_transcript_to_ui_messages` 映射 `cron_job_id`、`cron_job_name`
- [x] `nanobot/channels/websocket.py`：实时 message payload 带 `cron_job_id`、`cron_job_name`
- [x] Electron：`types.ts`、`useNanobotStream.ts`、`message-source.ts`、`MessageSourceBadge.tsx`；i18n `message.source.heartbeat`（zh-CN 心跳 / en Heartbeat）
- [x] 测试：`tests/tools/test_message_tool.py`、`tests/cli/test_commands.py`、`tests/utils/test_webui_transcript.py`、`electron/.../message-source.test.ts`

## Apply Notes

- 透传机制与现有 `set_record_channel_delivery` 并列：cron turn 内同时 set 两个 ContextVar
- metadata / wire 用 snake_case；UI 用 camelCase（`cronJobId`、`cronJobName`）
- heartbeat 系统 job：后端 `_cron_job_name` 仍存 `"heartbeat"`（与 cron 存储一致）；Electron `resolveMessageSourceBadge` 对 `"heartbeat"` 特判，读 i18n `message.source.heartbeat`
- 用户触发的 message 工具外发（`_user_initiated_channel_delivery`）不带 cron 字段
- session 字段前缀 `_` 与 `_channel_delivery` 一致；wire 事件无前缀
- 徽章规则：有 `cronJobName` 时只展示任务名（heartbeat 走 i18n）；无任务名的旧 `channelDelivery` 数据兜底「主动推送」

## Verify

- [x] cron job 触发且 agent 经 message 工具投递：统一会话镜像行含 `_cron_job_id`、`_cron_job_name`
- [x] cron job 触发且走 `_deliver_to_channel(record=True)` 兜底路径：同上
- [x] heartbeat 触发投递：镜像行 `_cron_job_name` 为 `heartbeat`；Electron 徽章显示 i18n「心跳」而非字面量
- [x] Electron 实时消息与 `/api/inbox/thread` 重放均显示任务名徽章（cron 显示原名，heartbeat 显示 i18n）
- [x] 普通对话、用户外发镜像、无 cron 上下文的消息：无 cron 字段、UI 无变化
- [x] `pytest tests/tools/test_message_tool.py tests/cli/test_commands.py tests/utils/test_webui_transcript.py -q`
- [x] `npx vitest run electron/src/renderer/tests/message-source.test.ts`

## Status
- State: done
- Archived: yes
