# Spec: electron-refresh-inbox-thread

## Why
- Electron 收件箱消息靠启动时一次 `GET /api/inbox/thread`  hydrate；WS 断线、外部 channel 写入、或服务端 transcript 更新后，本地列表可能与服务端不一致。
- 需要手动从服务端重新拉 transcript，重置当前消息列表，无需重启应用。

## Scope
- 本次要做：`InboxView` 收件箱标题栏（`统一收件箱` / channel 名那一行）右侧加刷新按钮。
- 本次要做：点击后调用已有 `fetchInboxThread(token, apiBase)`，用返回的 `messages` 覆盖 `useNanobotStream` 本地列表；成功后 bump `scrollToBottomSignal` 滚到底。
- 本次要做：刷新中按钮 loading/disabled；`isStreaming` 时禁用，避免覆盖进行中的 turn。
- 本次要做：失败时保留原列表，标题栏或按钮旁展示简短错误；中英文 i18n。
- 本次不做：webui；改 gateway `/api/inbox/thread` 协议；刷新 sidebar channel 列表（仍由现有 `messages` 推导）；streaming 中强制刷新或二次确认弹窗；改 `App.tsx` boot 时的 `initialMessages` 持久化。

## Plan
- [x] `InboxView.tsx`：解构 `setMessages`；`handleRefreshHistory` 调 `fetchInboxThread` → `setMessages(payload?.messages ?? [])` → `setScrollToBottomSignal(+1)`；`refreshing` state。
- [x] `InboxView.tsx`：标题栏改为 `flex` 布局，右侧 `Button` + `RefreshCw`（刷新中 `animate-spin`）；`disabled={isStreaming || refreshing}`。
- [x] `electron/src/renderer/i18n/locales/{en,zh-CN}/common.json`：`inbox.refreshHistory`、`inbox.refreshHistoryFailed`（或等价键）。
- [x] 可选：`InboxView` 单测（跳过，手动验证已覆盖）。
- [x] 手动验证：有历史时刷新列表更新；streaming 时按钮不可用；404/网络失败不清空列表。

## Apply Notes
- API 已存在：`electron/src/renderer/lib/api.ts` → `fetchInboxThread` → `/api/inbox/thread`；404 返回 `null`，视为空列表。
- 用 `setMessages` 直接覆盖即可；**不要**改 `useNanobotStream` 的 `chatId` effect——`INBOX_CHAT_ID` 不变，仅替换数组。
- 刷新后 `isStreaming` 不会自动从 transcript 最后一项 `trace` 推断重置；若服务端 snapshot 含未完成 trace，沿用 hook 现有 `setMessages` 后的 streaming 推断逻辑（当前仅在 `chatId` 切换时跑）。若 snapshot 无 trace，`isStreaming` 可能仍为 true——刷新前若已 `disabled` streaming 则无此问题。
- 标题栏指 `InboxView` 内 `h-9` 行，不是 `WindowTitleBar`（窗口拖拽条）。
- 仅改 `electron/`，遵守 `no-webui-unless-requested` 规则。

## Verify
- [x] 有多条历史消息：点刷新，列表与服务端一致（可改服务端 transcript 后验证）。
- [x] 刷新成功：视口滚到最新消息。
- [x] Agent 正在回复（`isStreaming`）：刷新按钮 disabled，点击无效。
- [x] 断网或 5xx：列表不变，出现错误提示；恢复网络后可再次刷新成功。
- [x] `activeChannel` 过滤视图：刷新后仍按当前 channel 过滤展示（数据源为全量 inbox messages）。

## Status
- State: done
- Archived: yes
