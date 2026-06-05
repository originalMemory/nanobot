# Spec: cron-unified-context

## Why
- `unifiedSession: true` 下所有对话写入 `unified:default`，heartbeat / cron job 执行时 session 独立（`heartbeat`、`cron:{id}`），拿不到最近对话上下文
- heartbeat 任务常依赖"刚才聊过什么"，用户 cron 提醒也可能需要对话上下文（如"30分钟后提醒我刚才说的那件事"）
- 当前 MEMORY.md / history.jsonl 有 Dream 延迟，不能覆盖即时上下文

## Scope
**本次做：**
- `CronPayload` 增加 `context_messages: int`（默认 0 = 不注入）；> 0 时固定从 `unified:default` 读取，不指定 session
- `on_cron_job` 在 heartbeat 和 agent_turn 执行前注入上下文前缀（dream 跳过）；仅 `unifiedSession: true` 时生效
- `HeartbeatConfig` 增加 `context_messages: int`（默认 50），gateway 注册 heartbeat system job 时写入 payload
- `CronTool` 直接暴露 `context_messages: int`（默认 0，不注入；>0 时写入 payload）
- unified 模式下 heartbeat 固定投递 `websocket:inbox:unified`
- 共享 helper `build_unified_context_prefix`，通过 `Session.get_history()` 读取最近消息

**本次不做：**
- 修改 heartbeat 的 `session_key`（仍写 `heartbeat` session，不污染 `unified:default`）
- 用户 cron 自动注入（须显式传 `context_messages > 0`）
- 指定非 unified session 作为上下文来源
- token budget 精确估算（用 `max_messages` 条数截断即可）

## Plan
- [x] `CronPayload` 加 `context_messages: int = 0`
- [x] `HeartbeatConfig` 加 `context_messages: int = 50`
- [x] `build_unified_context_prefix` helper：固定读 `unified:default` 的 get_history，格式化成 `## Recent Conversation\n...` 文本块
- [x] heartbeat 注册 system job 时，仅 unified 模式写入 `context_messages`
- [x] `on_cron_job` heartbeat / agent_turn 分支注入 context prefix
- [x] `CronTool.execute` 直接暴露 `context_messages: int`（默认 0）
- [x] 单元测试

## Apply Notes
- `get_history(max_messages=N)` 对未 consolidate 消息取尾部 `[-N:]`，再做过 legal 边界裁剪
- 通过 `_align_raw_metas` 从原始消息对齐 `source_channel` / `timestamp`
- heartbeat 注册：仅 `unifiedSession=true` 时 payload 写入 `context_messages`
- unified 下 heartbeat 投递固定 `websocket:inbox:unified`，无 websocket 则跳过
- 实现落点：`nanobot/cron/context.py`

## Verify
- [x] unified 模式下 heartbeat prompt 含 `## Recent Conversation` 块，默认 50 条
- [x] 非 unified 模式不注入
- [x] `context_messages=0` 时不注入
- [ ] Electron 端到端手动验证
- [x] CronTool `context_messages` 参数与持久化
- [x] `CronPayload` 旧 JSON 向后兼容

## Status
- State: done
- Archived: yes
