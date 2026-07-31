# Spec: electron-model-fallback-visibility

## Why
- Electron 设置页未展示主模型与 fallback 调用顺序。
- fallback 生效后，输入框仍显示配置主模型，无法确认本轮实际处理模型。

## Scope
- Electron 设置页管理具名 preset 的主模型与 fallback 顺序。
- fallback 触发时，通过 WebSocket 更新本轮模型徽章；turn 结束后恢复配置模型。
- 回复结束后，在最后一条 assistant 消息下固定展示实际回复模型，并单独标记是否发生 fallback；支持 cron/heartbeat 和历史回放。
- 保持全局统一会话模型选择。
- 不引入 session-scoped preset、长按拖动切换或 root WebUI 改动。

## Plan
- [x] 扩展设置 API：读取、迁移和更新模型调用顺序。
- [x] 扩展 Electron 模型设置页：排序、启停并标记主模型/fallback。
- [x] 发布并消费 `turn_model_updated`，展示本轮实际 fallback 模型。
- [x] 补后端与 Electron 测试。
- [x] 每次模型调用同步主模型/fallback，避免多次调用后显示过期。
- [x] 排除 cron、heartbeat 和 subagent 的后台模型调用。
- [x] 实际回复模型、fallback 标记和降级链记录到本轮 assistant 消息。
- [x] Electron 在回复后渲染可回放的模型信息与 fallback 标记。
- [x] 续跑同一逻辑 turn 时保留已发生的 fallback 标记。
- [x] 所有 AgentLoop 构造和 provider 热刷新路径安装 fallback observer。
- [x] 模型顺序更新与 preset 迁移在运行时刷新失败时回滚配置。
- [x] cron/heartbeat 投递在直播与历史回放中保留整轮 token usage。

## Apply Notes
- 调用顺序映射现有 `modelPreset + fallbackModels`，不改 FallbackProvider 的 failover 语义。
- 实时 fallback 状态不写 session；结束时将实际回复模型、fallback 标记和降级链写入最后一条 assistant 记录。
- 只提示带 WebUI turn metadata 的前台主 agent 调用。
- 后台任务不显示输入框 fallback 状态，但最终消息保留 fallback 摘要。
- cron/heartbeat 的内部 turn 与主动投递消息共用 turn id；`message` 工具提前投递时由 turn_end 补齐直播 usage，并在内部 turn 完成后回写历史记录。
- 实际回复模型取产生最终文本的最后一次 LLM 调用；同轮 fallback 模型去重，按首次调用顺序保留详情。
- 用户已在本轮确认按上述两项实施。

## Verify
- [x] 设置调用顺序后，配置保存为首项 `modelPreset`、其余项 `fallbackModels`。
- [x] fallback 触发时 Electron 展示实际模型，turn 结束后恢复主模型。
- [x] 相关 Python、Electron 测试通过。
- [x] 同一 turn 的后续主模型调用恢复主模型显示。
- [x] cron 和 subagent fallback 不更新 Electron 模型徽章。
- [x] 前台回复、cron/heartbeat 回复结束后固定展示实际回复模型，fallback 时额外标记。
- [x] 刷新历史后实际回复模型与 fallback 标记仍存在。
- [x] sustained goal 续跑不会清除同轮 fallback 状态。
- [x] 非 gateway 构造和热刷新后的 FallbackProvider 都能记录实际模型。
- [x] 无效 provider 或运行时刷新失败不会留下半更新配置。
- [x] cron/heartbeat 普通回复和 `message` 工具回复均展示 token，刷新后仍保留。

## Status
- State: done
- Archived: yes
