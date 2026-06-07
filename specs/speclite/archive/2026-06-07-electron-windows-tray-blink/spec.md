# Spec: electron-windows-tray-blink

## Why
- Windows 后台收到统一收件箱实时消息时，用户看不到窗口内容，需要托盘视觉提醒
- 微信式原图标与空白图交替闪烁，用户熟悉、实现成本低（无原生 blink API，定时换图）

## Scope
- 本次做：仅 **Windows**（`win32`）；收到 **实时 WebSocket 消息** 且 **主窗口无焦点** 时，托盘图标在原图与空白图间交替闪烁
- 本次做：主窗口获焦、托盘点击显示窗口、应用退出时停止闪烁并恢复原图标
- 本次做：实时消息指 inbox 可见对话内容——外部 channel 入站 `user`、完整 assistant `message`（无 `kind`）、`channel_delivery` 主动投递；纯流式回复在 `turn_end` 补通知
- 本次做：sidebar 频道过滤时，仅 `source_channel` 与当前选中频道一致（或「全部」）才闪烁
- 本次不做：macOS / Linux 托盘行为
- 本次不做：启动时历史未读触发闪烁（仅运行时 WS 投递）
- 本次不做：流式 token（`delta` / `stream_end` / `reasoning_*`）、中间帧（`tool_hint` / `progress` / `reasoning` kind）
- 本次不做：修改仓库根目录 `webui/` 浏览器前端

## Plan
- [x] main 进程新增 tray blink 模块：`start` / `stop`，`setInterval` 交替 `tray.setImage(normal | empty)`
- [x] 空白图用 `nativeImage.createEmpty()` 或同尺寸透明图，与原 `tray.png`（16×16）配对
- [x] main 进程维护 `mainWindow.isFocused()`；`focus` 时 `stop`；`blur` 后不自动闪（等新消息）
- [x] preload 暴露 `tray.notifyIncoming()` → IPC；renderer 在 `useNanobotStream`（或 inbox 消息入口）符合条件时调用
- [x] 托盘 click / `showMainWindow` 时 `stop`
- [x] 手动验收：无焦点收消息闪、有焦点不闪、点托盘停闪

## Apply Notes
- 闪烁逻辑放 **main 进程**（timer 不受 renderer `backgroundThrottling` 影响）
- 触发判定以 main 侧 `!mainWindow.isFocused()` 为准，不用 `document.hasFocus()`
- 已在闪时不重置 interval，避免多消息抖动；持续闪直到获焦或用户打开窗口
- 间隔建议 500ms，与微信观感接近
- 现有 `loadTrayIcon()` / `createTray()` 在 `electron/src/main.ts`；IPC 模式对齐 `presence` / `screenshot` 命名空间
- renderer 通知入口：`useNanobotStream` + `tray-notify.ts`（`requestTrayBlinkForInboxEvent` / `requestTrayBlinkForStreamTurnEnd`）
- 流式路径：`delta` 标记回合，`turn_end` 补 blink；完整 `message` 仍直接通知
- 频道过滤：`InboxView.activeChannel` 传入 hook，无 `source_channel` 的本地流式回复在「全部」视图才闪
- 空白帧：`electron/src/tray-blink.ts` 用 1×1 透明 PNG resize 到托盘尺寸
- renderer 过滤逻辑：`electron/src/renderer/lib/tray-notify.ts`

## Verify
- [x] Windows：窗口隐藏/最小化/失焦时收到实时 user 或 assistant 消息，托盘原图与空白交替闪
- [x] Windows：窗口有焦点时收到同类消息，托盘不闪
- [x] Windows：闪烁中点击托盘或窗口获焦，立即停止并恢复原图标
- [x] Windows：流式 delta、tool_hint 等中间帧不触发闪烁（单元测试覆盖）
- [x] 非 Windows 平台：`notifyIncoming` 无效果，无报错（main 侧 `win32` guard）

## Status
- State: done
- Archived: yes
