# Spec: electron-streaming-system-status

## Why
- Electron 流式回复进行中缺少系统级状态，窗口隐藏后无法判断是否仍在处理。
- 现有 Windows 托盘仅在回复完成后闪烁；macOS 菜单栏无工作中和未读状态。

## Scope
- 本次做：Electron use `idle`、`streaming`、`unread` 状态驱动菜单栏、托盘和 Windows 任务栏提示。
- 本次做：macOS 菜单栏 use Template 图标切换；资源 use `22×22` 与 `44×44@2x` 贴近菜单栏满高；动态 tooltip 展示空闲、正在回复、有新回复。
- 本次做：Windows 托盘 use 工作中双帧动画；未读 use 橙色图标闪烁。
- 本次做：Windows 流式中显示任务栏不确定进度条；未读时清除进度条并显示橙色 overlay 图标。
- 本次做：窗口聚焦只清除未读；`turn_end`、停止、错误、断线和退出清除流式状态与定时器。
- 本次做：保留现有后台系统通知及触发条件。
- 本次不做：浏览器 WebUI、Linux、状态设置开关、macOS 菜单栏彩色图标、macOS Dock badge、错误态红色提示。

## Plan
- [x] 将 `tray-blink.ts` 收拢为菜单栏/托盘状态控制器，独立维护 `streaming` 与 `unread`，托盘优先级为 `unread > streaming > idle`。
- [x] 新增 macOS 普通、工作中、未读 Template 图标的 `1x`/`2x` 资源及双帧切换。
- [x] 新增 Windows 工作中、橙色未读托盘资源和任务栏橙色 overlay 资源。
- [x] main 进程接入 Windows `setProgressBar`、`setOverlayIcon`，补状态切换、tooltip、focus 和退出清理。
- [x] preload 和 renderer 类型新增流式状态 IPC；统一收件箱将聚合后的 `isStreaming` 变化同步给 main。
- [x] 扩展状态控制、IPC 和流式生命周期测试。

## Apply Notes
- renderer 现有 `isStreaming` 覆盖多个 active turn，并持续到 `turn_end`；use boolean 状态同步，不按 delta 高频发送。
- 状态是两个维度：`streaming` 表示工作，`unread` 表示需关注。Windows 进度条和 overlay 可独立显示；托盘按优先级选图。
- `streaming: true` 立即显示工作态；`false` 清除任务栏进度。后台 `turn_end` 再进入未读态并触发现有系统通知。
- macOS Template 图标由系统处理深浅模式；不强制染色。工作中约 `800ms` 切帧，未读约 `600ms` 闪烁。
- macOS 猫形主体占满约 `21×20pt`；状态标记 use 透明隔离带后覆盖右上角，不为 badge 压缩主体，允许遮挡右耳。
- Windows 工作中不 use `flashFrame()`；任务栏不确定进度 use `setProgressBar(..., { mode: "indeterminate" })`，结束 use负值清除。
- focus 清除 `unread` 后若仍在流式，托盘回到工作态；断线、renderer 卸载和应用退出强制回到 `idle`。
- gateway 消息校验错误回传 `chat_id + turn_id`；renderer 只结束失败 turn，无归属错误不清理其他 active turn。
- Windows 通知快捷键 use `APP_NAME` 常量；overlay 资源缺失时回退为空图。

## Verify
- [x] macOS：菜单栏普通图标 Retina 清晰；流式中工作图标缓慢切换；后台完成后切到未读图标；聚焦恢复普通图标。
- [x] macOS：light/dark 及菜单栏选中态自动反色，无彩色底块或尺寸跳动。
- [ ] Windows：流式中托盘工作动画和任务栏绿色不确定进度同时出现；结束后进度条清除。
- [ ] Windows：后台完成后托盘橙色闪烁、任务栏橙色 overlay 和系统通知同时出现；聚焦后全部清除。
- [x] 工具调用间隙不提前退出工作态；多个 active turn 中任一未结束时保持工作态。
- [ ] `turn_end`、停止、错误、断线、renderer 卸载和退出不残留图标、overlay、进度条或 interval。
- [ ] Electron 单测、TypeScript 检查和生产 package 通过，打包产物包含全部 `1x`/`2x`/Windows 图标资源。

## Status
- State: doing
- Archived: no
