# Spec: electron-webui-native-host

## Why
- Electron renderer 源自早期 WebUI，已与 0.3.0 WebUI 的 Session、Composer、Settings 和协议语义分叉。
- 两套 renderer 重复维护 client、stream hook、消息渲染和设置页；Electron 已出现 `maxMessages`、全局 preset 等过期行为。
- WebUI 已有 `RuntimeHost` 和 Native Chrome，Electron 应收敛为原生宿主。

## Scope
- 本次要做：Electron 使用根 `webui/` 作为唯一聊天与设置 renderer。
- 本次要做：保留 Unified Inbox、来源频道展示与过滤、托盘提醒、全局唤起、截图、焦点/锁屏 presence、单实例和最小化到托盘。
- 本次要做：保留动态壁纸 URL、轮换间隔、窗口隐藏暂停、配置持久化和半透明表层。
- 本次要做：保留 fork 的 TTS、辅助视觉设置入口。
- 本次要做：采用 WebUI 的 turn/activity timeline，不迁移 Electron“一轮一泡”聚合。
- 本次要做：删除仅服务旧 Electron 聚合的后端兼容逻辑。
- 本次要做：删除被 WebUI 替代的 Electron chat/settings/workspace/client 重复实现和失效配置。
- 本次要做：恢复 Electron renderer 的同源安全边界，移除 `webSecurity: false`。
- 本次要做：统一会话启用时，Heartbeat 固定投递到 Electron Unified Inbox。
- 本次要做：通用 `webui-thread` 支持 `unified:default`，删除 `/api/inbox/thread`。
- 本次要做：Electron 允许配置并持久化明确指定的远端 Gateway URL；连接失败时提供本地恢复入口。
- 本次要做：Unified Inbox 的标题、预览和频道筛选跟随 WebUI 当前语言。
- 本次要做：Electron 隐藏新建话题、项目内新建和新建快捷键，并将空白路由固定回 Unified Inbox。
- 本次不做：修改桌宠、自动播放、音频分段；改变后端消息/音频协议；重设计 WebUI 页面视觉。

## Plan
- [x] 建立 Electron → WebUI native host 启动链路和 preload bridge。
- [x] 将动态壁纸接入 WebUI native surface，迁移现有 `electron-store` 配置。
- [x] 在 WebUI 增加 Native-only Unified Inbox 入口、来源徽章和频道过滤。
- [x] 接入托盘通知、全局唤起、截图及 presence。
- [x] 在 WebUI 设置中接回 TTS 和 preset 辅助视觉配置。
- [x] 采用 WebUI 的 Session、per-session preset、Workspace、Composer、活动卡片和设置能力。
- [x] 审计并删除 Electron 聚合专用后端逻辑，保留官方 turn metadata 与 Unified Inbox 路由。
- [x] 删除 Electron 重复 renderer 与 `maxMessages` 等过期路径。
- [x] 收紧 BrowserWindow 导航、IPC 暴露和同源策略。
- [x] Heartbeat 在统一会话模式下固定选择 `websocket:inbox:unified`。
- [x] Unified Inbox 改用通用 `webui-thread`，删除专用接口和前端 client。
- [x] 跨渠道用户消息写入 Unified Session 后实时 fan-out 到 Unified Inbox。
- [x] Unified thread 复用通用历史分页，避免全量同步转换。
- [x] Electron gateway 首次加载失败后自动恢复。
- [x] 在 Native 设置中恢复全局唤起快捷键配置。
- [x] Electron `test` 恢复行为回归测试，不再等同于 typecheck。
- [x] 恢复 Gateway URL 设置，支持 NAS 等远端地址并在连接失败页修改。
- [x] 补齐 Unified Inbox 多语言资源和运行时语言切换响应。
- [x] Electron 禁用所有显式新建会话入口，浏览器 WebUI 保持原行为。

## Apply Notes
- `webui/` 是 renderer 单一来源；禁止继续复制文件到 `electron/src/renderer`。
- Electron main/preload 只提供原生能力，不复制业务状态。
- Unified Inbox 复用通用 `/api/sessions/{key}/webui-thread`、`inbox:unified` WebSocket fan-out 和来源元数据。
- `unified:default` 无 WebUI transcript；通用接口内部保留 Session → wire events 转换。
- Heartbeat 执行 Session 仍为 `heartbeat`；只固定最终投递目标，不改变普通 cron 的来源路由。
- WebUI 继续按官方 `turn_id`、`turn_seq`、`activitySegmentId` 在前端组织 activity；后端不合并 AI 回复文本。
- 跨频道 fan-out、Unified Session 历史转换、`source_channel`、主动投递和 cron 元数据不属于聚合兼容，继续保留。
- 壁纸继续由 Electron 主进程抓取并转 data URL；WebUI 仅消费 host 事件和本地偏好。
- 原有 Electron renderer 保留到新链路通过核心验收，再一次性删除。
- Native bridge 不向任意远端页面暴露；仅允许本地恢复页或用户明确配置的单一 gateway origin。
- Unified 用户消息 fan-out 只推送展示事件，不重复执行 agent turn。
- Electron gateway 恢复页只接受 HTTP(S) URL；远端 Gateway 可用，但页面导航仍固定在当前配置的精确 origin。
- Electron 空白路由回落到 `unified:default`；不暴露新建、项目内新建或 fork 入口。

## Verify
- [x] Electron 使用 WebUI 的话题列表、Session 搜索/管理、fork、Workspace、语音转写、Automation、Skills 和频道设置。
- [x] Unified Inbox 可回放并实时接收跨频道用户消息、回复、流式 delta 和主动投递。
- [x] 来源频道徽章、频道过滤和托盘提醒正确。
- [x] 截图主动附加、服务端截图请求、焦点/锁屏 presence 正确。
- [x] 动态壁纸首次加载、定时轮换、隐藏暂停、配置修改和重启恢复正确。
- [x] TTS 与 preset 辅助视觉设置可读写。
- [x] Session 模型切换使用 per-session `/model`，不再写全局 preset。
- [x] AI 回复采用 WebUI 原生活动时间线；旧 `AssistantTurnBubble` 和聚合兼容路径不存在。
- [x] Electron 不再展示或提交 `maxMessages`。
- [x] BrowserWindow `webSecurity` 开启，外部导航和原生 IPC 受限。
- [x] WebUI build/test、Electron typecheck/test/package 通过。
- [x] Heartbeat 统一模式固定投递到 `inbox:unified`；未启用 WebSocket 时保留原选路。
- [x] `/api/sessions/unified%3Adefault/webui-thread` 回放 Unified Session；`/api/inbox/thread` 不存在。
- [x] QQ/微信等跨渠道用户消息无需刷新即可显示在 Unified Inbox。
- [x] Unified Inbox 首屏和向前加载遵循通用分页协议。
- [x] Gateway 晚于 Electron 启动时窗口可自动恢复。
- [x] Native 设置可读取、修改和录制全局唤起快捷键。
- [x] Electron 行为测试覆盖 gateway 恢复与快捷键 bridge。
- [x] Gateway URL 可在 Native 设置与连接失败页修改，重启后仍生效。
- [x] 中文界面显示“统一收件箱 / 所有渠道”，切换语言无需重启。
- [x] Electron 无新建话题按钮、项目内新建、fork 和 `Cmd/Ctrl+Shift+O`；搜索仍可用。

## Verification Evidence
- WebUI：`npm test -- --run`，49 files / 741 tests passed。
- WebUI：`npm run lint && npm run build`，通过。
- Electron：`npm run lint && npm test && npm run package`，通过并产出 macOS arm64 包。
- Unified Inbox / transcript：90 tests passed。
- screenshot / presence：27 tests passed。
- Python：`ruff check nanobot/webui/transcript.py`，通过。
- Diff：`git diff --check`，通过；旧 renderer、`AssistantTurnBubble`、Electron `maxMessages` 与宽泛 config IPC 均不存在。
- Heartbeat：`pytest -q tests/cli/test_commands.py -k heartbeat_target`，3 passed。
- Unified thread routes：11 passed；Session transcript converter：58 passed。
- `/api/inbox/thread` 生产引用已删除，仅保留 404 回归断言。
- Review fixes Python：AgentLoop、Unified Inbox、transcript、HTTP routes，203 passed。
- Review fixes WebUI：49 files / 742 tests passed；lint、build 通过。
- Review fixes Electron：3 behavior tests passed；typecheck、lint、macOS arm64 package 通过。
- Diff：`ruff check`、`git diff --check` 通过。
- Gateway URL：Electron 2 files / 11 tests passed；typecheck、lint、macOS arm64 package 通过。
- WebUI：49 files / 744 tests passed；lint、build 通过。
- i18n：10 个 locale 的 Unified Inbox 与 Gateway 设置资源结构一致；运行时切换回归测试通过。
- Final diff：`git diff --check` 通过。
- Electron 新建会话屏蔽：App layout 39 tests passed；WebUI 49 files / 745 tests passed。
- WebUI：lint、build、`git diff --check` 通过；浏览器新建会话回归测试保持通过。

## Status
- State: done
- Archived: yes
