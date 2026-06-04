# Spec: electron-global-inbox-shortcut

## Why
- 应用在托盘/后台时，用户无法用键盘快速回到主界面并开始输入。
- 需全局快捷键：唤起窗口 → 统一收件箱 → 聚焦输入框；默认 `Ctrl+Shift+E`（macOS 为 `Cmd+Shift+E`），可改。

## Scope
- 本次要做：主进程注册/注销可配置全局快捷键（默认 `CmdOrCtrl+Shift+E`），触发 `showMainWindow` 并向 renderer 发 IPC。
- 本次要做：renderer 收到 IPC 后切到 chat 视图、`activeChannel=null`（统一收件箱），并聚焦 `ThreadComposer` 文本框。
- 本次要做：`electron-store` 持久化快捷键；设置页提供编辑与保存（Electron accelerator 格式）。
- 本次要做：preload + `declarations.d.ts` 暴露订阅 API；中英文 i18n。
- 本次不做：渠道过滤收件箱的快捷键切换。
- 本次不做：与系统/其他应用冲突的自动解决（注册失败时提示用户改键）。

## Plan
- [x] `AppConfig` / store defaults 增加 `shortcuts.raiseInbox`（默认 `CmdOrCtrl+Shift+E`）。
- [x] `main.ts`：`registerRaiseInboxShortcut()` 在 `app.whenReady` 注册；`shortcut:set-raise-inbox` 改键并重注册；`before-quit` 注销；handler 内 `showMainWindow` + `webContents.send('shortcut:raise-inbox')`。
- [x] `preload.ts`：`shortcut.onRaiseInbox(cb)`；`declarations.d.ts` 补类型。
- [x] `App.tsx` Shell：订阅 IPC → `setView('chat')`、`setActiveChannel(null)`；`focusComposerSignal` 驱动聚焦。
- [x] `ThreadComposer`：`forwardRef` + `useImperativeHandle({ focus })`。
- [x] 设置页 `AppearanceSection`：`shortcut:get/set-raise-inbox` IPC，试注册失败回滚；使用 `@tanstack/react-hotkeys` 的 `useHotkeyRecorder` 实现快捷键录制 UI。
- [x] i18n：`settings.rows/help/errors/shortcut`。
- [ ] 手动验证三平台唤起 + 聚焦；改键后旧键失效。

## Apply Notes
- 与截屏快捷键不同：截屏仅在窗口 `focus` 时 `globalShortcut.register`；本功能需应用级常驻全局注册（参考 `second-instance` → `showMainWindow` 模式）。
- Electron 跨平台写法用 `CmdOrCtrl+Shift+E`，UI 文案区分 Mac（Cmd）与其它（Ctrl）。
- 窗口隐藏/最小化时仍需生效；若 `mainWindow` 未创建则 `createWindow`，在 `did-finish-load` 后补发 raise 事件（避免 renderer 未就绪丢事件）。
- 统一收件箱 = `activeChannel === null` + `InboxView` 使用 `inbox:unified` chat id（现有逻辑，不新增路由）。
- 改键流程：先 `unregister` 旧 accelerator，再 `register` 新键；失败则回滚 store 并通知 renderer。

## Verify
- [ ] 应用驻托盘，按默认全局快捷键：主窗口显示/置前，侧栏为统一收件箱，光标在输入框。
- [ ] 当前在设置页或某渠道过滤时按快捷键：回到 chat + 统一收件箱 + 聚焦输入。
- [ ] 设置页修改为 `CmdOrCtrl+Shift+K`（示例）保存后：新键生效，旧 `E` 组合不再触发。
- [ ] 重启应用后快捷键配置保留。
- [ ] 非法 accelerator 字符串保存失败并有可见错误提示。
- [ ] 与现有 `CmdOrCtrl+Shift+S` 截屏快捷键无互相注销/冲突（截屏仍仅窗口获焦时注册）。

## Status
- State: done
- Archived: yes
