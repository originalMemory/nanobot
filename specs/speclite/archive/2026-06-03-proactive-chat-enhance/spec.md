# Spec: proactive-chat-enhance

## Why
- 锁屏时 Electron 窗口仍为 unfocused，主动陪伴会继续触发，但用户不在场
- `quiet_hours` 只支持单段时间，无法同时排除夜间和工作日上班时间

## Scope
本次做：
- Electron 主进程监听 `powerMonitor` `lock-screen`/`unlock-screen`，将 `locked` 状态随 presence 上报
- `ProactiveChatService._tick()` 加锁屏跳过逻辑
- `ProactiveChatConfig.quiet_hours` 废弃，改为 `quiet_periods: list[str]`
- 格式：`"HH:MM-HH:MM"`（每天生效）或 `"weekday:HH:MM-HH:MM"`（仅周一至周五）
- 字段改名，删除旧 `quiet_hours`，不做兼容
- Electron presence WebSocket 消息加 `locked` 字段

本次不做：
- `weekend:` 前缀（暂不需要）
- 锁屏期间积压触发后解锁立即补发
- 多 `locked` 状态来源聚合（当前只有 Electron）

## Plan
- [x] `electron/src/main.ts`：`powerMonitor.on('lock-screen'/'unlock-screen')` 更新本地 `locked` 状态，presence 消息改为 `{ focused, locked }`
- [x] `nanobot/channels/websocket.py`：presence 解析加 `locked` 字段，`ConnectionPresence` 加 `locked: bool`
- [x] `get_unfocused_last_user_connection()` 加 `locked=True` 时跳过（视为在场，不触发）
- [x] `ProactiveChatConfig`：加 `quiet_periods: list[str]`，删 `quiet_hours`
- [x] `ProactiveChatService._is_quiet_hours()` 改为 `_is_quiet_period()` 支持新格式解析
- [x] 解析逻辑：`"weekday:HH:MM-HH:MM"` 先判 weekday（weekday() < 5），再判时间段；`"HH:MM-HH:MM"` 直接判时间段
- [x] 单元测试：weekday/weekend 时间段判断；locked 状态跳过

## Apply Notes
- presence 消息结构改为 `{ focused: boolean, locked?: boolean }`；`locked` 初始值为 `false`，仅在锁屏事件后变 `true`
- `powerMonitor` 需在 `app.whenReady()` 后使用
- `ConnectionPresence` 结构体加 `locked: bool = False`
- `"weekday:HH:MM-HH:MM"` 解析：split 首个 `:` 取 prefix，余下部分为时间范围字符串 `"HH:MM-HH:MM"`；prefix 不是 `weekday` 则整串视为时间范围
- 时间范围解析 regex：`r"(\d{2}:\d{2})-(\d{2}:\d{2})"`
- `get_unfocused_last_user_connection` 目前返回 `(conn, chat_id) | None`；locked 判断加在 `focused` 判断之后：`if presence.locked: skip`

## Verify
- [x] 锁屏后观察日志，主动陪伴不再触发（"最近用户连接不存在或仍在前台，跳过" 或新增 "锁屏，跳过"）
- [x] 解锁后恢复正常触发逻辑
- [x] 配置 `quiet_periods: ["22:00-08:00", "weekday:09:00-18:00"]`，工作日 10:00 不触发
- [x] 工作日 20:00 正常触发
- [x] 周末 10:00 正常触发（weekday 段不生效）

## Status
- State: done
- Archived: yes
