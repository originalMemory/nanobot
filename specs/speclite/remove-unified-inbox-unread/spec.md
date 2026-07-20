# Spec: remove-unified-inbox-unread

## Why
- 统一收件箱不再需要未读计数、未读分隔条和首条未读定位。
- 删除投递水位与对账状态，缩短实时 fan-out 和 thread 回放链路。

## Scope
- 本次要做：删除统一收件箱未读水位模块及 Session metadata 读写。
- 本次要做：thread payload 和 Electron 类型、启动状态、组件 props 不再包含 `unreadCount`。
- 本次要做：删除未读分隔条、未读滚动定位、相关 i18n 和测试。
- 本次保留：统一收件箱订阅、实时 fan-out、持久化 thread 回放、频道过滤、普通滚动和加载更早消息。
- 本次不做：修改 Email IMAP 未读邮件拉取、CLI 未读按键处理、浏览器 `webui/` 前端。

## Plan
- [x] 删除 `nanobot/session/inbox_unread.py`，移除 WebSocket fan-out、attach 和 thread 构建中的未读集成。
- [x] 移除后端 thread/fork payload 的 `unreadCount` 字段及相关 imports。
- [x] 移除 Electron bootstrap/type/state、InboxView、ThreadViewport、ThreadMessages 的未读逻辑。
- [x] 删除中英文 `thread.unreadDivider` 文案和未读专项测试，保留并更新统一收件箱回归测试。

## Apply Notes
- 旧 Session 中的 `inbox_unread_count`、`inbox_last_delivered_ui_count`、`inbox_pending_delivered_ui_events` 保留为惰性无效数据；不增加迁移或清理逻辑。
- `GET` thread 响应直接移除 `unreadCount`，不返回固定 `0`。
- inbox attach 和 fan-out 不再因订阅状态写 Session metadata。
- Electron 打开收件箱按现有普通 thread 规则滚到底部。

## Verify
- [x] `NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost pytest tests/channels/test_websocket_unified_inbox.py -q`（22 passed）。
- [x] `ruff check nanobot/channels/websocket.py nanobot/webui/fork_http.py nanobot/webui/transcript.py tests/channels/test_websocket_unified_inbox.py`。
- [x] `cd electron && npm test`（30 files、202 tests passed）。
- [x] 变更文件定向 ESLint 无 error；仅保留 `App.tsx` 两个既有 unused warning。
- [x] 统一收件箱 thread payload 无 `unreadCount`，attach/fan-out 不写未读 metadata。
- [x] Electron 无未读分隔条和未读定位，历史 hydrate、实时消息、频道过滤和加载更早消息正常。

## Verification Notes
- 本机无 `bun`，使用项目现有 npm scripts 执行同等测试。
- 全仓 `npm run lint` 仍因既有 `@/` alias resolver、缺失 `react-hooks` 规则等报错；定向检查通过。
- 全仓 `npx tsc --noEmit` 仍有 PSB 测试、设置组件等既有类型错误；本次触及的 `App.tsx` 报错与基线一致。

## Status
- State: done
- Archived: yes
