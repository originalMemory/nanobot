# Spec: electron-native-message-notifications

## Why
- macOS 无托盘闪烁，后台回复完成后缺少提醒
- Windows/macOS use 同一套系统消息通知，保留 Windows 现有托盘闪烁

## Scope
- 本次做：macOS、Windows 主窗口无焦点时发送 Electron 原生通知
- 本次做：复用统一收件箱实时提醒条件；外部用户消息、完整主动消息到达时通知，流式 AI 回复仅在 `turn_end` 通知一次
- 本次做：通知展示简短正文；无文字媒体消息 use 通用文案
- 本次做：点击通知显示并聚焦主窗口
- 本次做：Windows 原有托盘闪烁保持不变，与系统通知同时触发
- 本次不做：Linux 通知、历史消息补通知、通知设置开关、浏览器 WebUI

## Plan
- [x] 扩展 renderer 提醒请求，传递通知类型和正文摘要
- [x] main 进程统一处理后台提醒：Windows 托盘闪烁 + macOS/Windows 原生通知
- [x] 通知点击后唤起主窗口
- [x] 补 IPC 类型与提醒判定测试
- [x] fix 多段流式回复的通知正文边界
- [x] renderer 限制 IPC 摘要长度
- [x] fix 通知兜底文案 i18n 与 Markdown 展示
- [x] 补摘要和正文格式化测试
- [x] macOS Forge 打包后执行有效 ad-hoc 签名
- [x] 原生通知失败时记录错误日志
- [x] 新增 macOS 一键打包、验签、安装和启动脚本
- [x] fix ad-hoc 签名的 Hardened Runtime 启动崩溃
- [x] 安装脚本 use 临时副本和失败回滚
- [x] macOS 通知正文按 UTF-8 字节限制

## Apply Notes
- main 进程继续以 `mainWindow.isFocused()` 作最终拦截
- use Electron `Notification`；调用前检查平台和 `Notification.isSupported()`
- 正文摘要限制长度，不传完整长回复
- 流式通知正文从本轮最终 assistant 内容提取，不按 delta 重复通知
- Windows 保留原托盘闪烁；macOS/Windows 原生通知共用 `tray:notify-incoming` IPC
- `stream_end` 标记正文段边界，不依赖可选 `stream_id`
- renderer 每段最多保留 1000 字符，main 清理 Markdown 后按 UTF-8 截至 240 字节
- 兜底文案读取 Electron `appearance.language`，未配置时 use 系统 locale
- macOS 固定 use ad-hoc identity `-`，并通过逐文件签名选项关闭 Hardened Runtime
- `npm run package:install:mac` 串联 package、双重验签、临时副本替换、失败回滚和启动确认

## Verify
- [x] Windows：后台提醒路径同时调用原生通知与托盘闪烁
- [x] macOS：原生通知平台路径通过生产打包
- [x] 窗口有焦点、非统一收件箱、中间思考/工具事件不通知
- [x] 流式回复仅在 `turn_end` 通知一次，通知 click 绑定 `showMainWindow`
- [x] Electron 生产打包和全量单测通过
- [x] `codesign --verify --deep --strict` 通过，Bundle ID 为 `ai.nanobot.desktop`
- [x] 一键脚本通过 `bash -n`，npm 命令可解析且脚本具备执行权限
- [x] 打包产物签名仅含 `adhoc`、不含 `runtime`
- [x] 一键脚本完成 `/Applications/Nanobot.app` 替换并确认新进程启动

## Status
- State: done
- Archived: yes
