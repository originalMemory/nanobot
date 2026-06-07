# Spec: unified-inbox-thread-unread

## Why
- 统一收件箱 thread 缺少未读消息数，Electron 无法定位用户未读起点
- websocket 未连接时，转发只写历史导致新消息不可见，需要计入未读

## Scope
- 本次做：thread 接口返回未读消息数
- 本次做：统一会话下，转发写入历史但未实时 websocket 转发时计为未读消息
- 本次做：Electron 拉历史消息后，有未读消息时滚动到第一条未读消息居中位置
- 本次做：Electron 在第一条未读消息上方插入未读提示条
- 本次不做：修改仓库根目录 `webui/` 下的浏览器前端网页
- 本次不做：变更非统一收件箱会话的未读规则

## Plan
- [x] 定位统一收件箱 thread 接口、历史写入、websocket 转发路径
- [x] 为 thread 数据补充未读消息数字段
- [x] 在历史写入成功但未实时 websocket 转发时更新统一会话未读计数
- [x] Electron 拉历史后根据未读数定位第一条未读消息
- [x] Electron 渲染未读提示条并调整滚动逻辑
- [x] 补充或更新后端与 Electron 相关测试

## Key Locations
- `nanobot/webui/fork_http.py`：`ForkGatewayHTTPHandler._handle_inbox_thread()` 处理 `GET /api/inbox/thread`
- `nanobot/webui/transcript.py`：`build_inbox_thread_from_session()` 将 `unified:default` Session 转为 thread payload
- `nanobot/session/__init__.py`：`UNIFIED_SESSION_KEY = "unified:default"` 定义统一会话 key
- `nanobot/agent/loop.py`：`_effective_session_key()` 路由统一会话；`_persist_user_message_early()`、`_save_turn()` 写历史
- `nanobot/channels/websocket.py`：`INBOX_UNIFIED_CHAT_ID`、`_subs`、`_fan_out_to_unified_inbox()` 判断是否有 `inbox:unified` 订阅者并实时转发
- `nanobot/channels/manager.py`：`_maybe_fan_out_unified_inbox()`、`_build_unified_inbox_shadow()` 处理非 websocket 通道统一收件箱 fan-out
- `electron/src/renderer/lib/api.ts`：`fetchInboxThread()` 拉取统一收件箱历史
- `electron/src/renderer/lib/types.ts`：`WebuiThreadPersistedPayload` 需要扩展未读字段
- `electron/src/renderer/App.tsx`：`bootstrapWithSecret()` 启动时拉取 inbox thread
- `electron/src/renderer/components/InboxView.tsx`：接收 thread payload、刷新历史、传递滚动/未读定位参数
- `electron/src/renderer/hooks/useNanobotStream.ts`：`replaceMessagesFromSnapshot()` 替换历史快照；实时 WS 事件归并
- `electron/src/renderer/components/thread/ThreadViewport.tsx`：首屏滚动、贴底、窗口化；新增未读定位能力
- `electron/src/renderer/components/thread/ThreadMessages.tsx`：消息列表渲染；新增第一条未读上方提示条
- `tests/channels/test_websocket_unified_inbox.py`：覆盖 inbox thread 与 unified fan-out
- `tests/channels/test_channel_manager_unified_inbox.py`：覆盖跨通道 unified fan-out
- `electron/src/renderer/tests/thread-messages.test.tsx`：覆盖消息列表渲染

## Apply Notes
- 仓库根目录 `webui/` 的浏览器前端网页不改；`nanobot/webui/` 是后端 HTTP/transcript 模块，可为接口 payload 调整
- 未读判定以“已写入历史但未成功实时投递到当前 websocket 连接”为准
- 第一条未读消息位置由历史消息列表和 thread 未读数共同确定
- 未读计数存 `unified:default` Session metadata 键 `inbox_last_delivered_ui_count`（UI 消息水位）
- 无 `inbox:unified` 订阅者时保留水位，未读 = UI 条数 − 水位；双订阅 exclude 时视为已投递
- 实时 fan-out 早于 Session 落盘时，先记录已投递事件签名，thread 构建时与已落盘 UI 消息对账后再推进水位
- attach `inbox:unified` 时将水位推进到当前 UI 条数
- Electron 频道过滤时不做未读定位

## Verify
- [x] thread 接口返回统一会话未读消息数
- [x] 无 websocket 连接时，新写入历史的统一会话消息计入未读
- [x] Electron 有未读历史时，首屏滚动到第一条未读消息居中
- [x] Electron 第一条未读消息上方显示未读提示条
- [x] Electron 无未读历史时保持原滚动行为
- [x] 相关测试通过

## Status
- State: done
- Archived: yes
