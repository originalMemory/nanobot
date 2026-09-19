# Nanobot Electron 基础壳

复用根 `webui/` 的同一份代码，构建进桌面包。第一阶段提供连接页、地址记忆、原生菜单、重连、单实例和窗口生命周期；对话、模型和设置界面使用上游实现。

## 启动

需要 Node.js 22.12+ 与 npm。首次执行：

```sh
npm --prefix webui ci
npm --prefix electron ci
npm --prefix electron run dev
```

先单独启动兼容 v0.3.5 的 gateway，或在连接页输入已有 NAS gateway 的 HTTP(S) origin，例如 `http://nas:8765`。认证密钥在上游登录界面填写，不放进地址。此客户端不启动、停止或修改 NAS gateway。

`dev` 会构建当前 WebUI 再打开 Electron；改 UI 后重新运行即可。仅重新打开已构建界面使用 `npm --prefix electron start`。本阶段不另建 React 项目，也暂不提供 HMR。

可用环境变量指定初始后端：

```sh
NANOBOT_GATEWAY_URL=http://127.0.0.1:8765 npm --prefix electron start
```

后续通过「连接 → 更换后端地址」或 `Cmd/Ctrl+,` 修改。「重新连接」重新载入本地界面。上游尚未完成提供方配置时，会展示它自带的初始化流程。

## 打包与验证

```sh
npm --prefix electron test
npm --prefix electron run test:smoke
npm --prefix electron run package
```

打包输出在 `electron/out/`，默认面向当前系统和架构；这是可运行的应用目录，尚未签名、公证或生成安装器。WebUI 必须先有依赖，桌面依赖和构建产物已忽略，不进入 Git。

## 边界

- 本地 `nanobot://desktop` 协议提供打包的 WebUI，并把 `/api`、`/auth`、`/webui` 请求转给选定 gateway；WebSocket 复用上游 HostSocketBridge，经主进程连接同一 gateway 并使用上游短期 token，支持 NAS 的 HTTP/WS 部署而不关闭混合内容保护。
- 不关闭 webSecurity，不向聊天页暴露 Node 或任意 IPC；连接页的 IPC 校验主 frame 和来源。外部链接交给系统浏览器，拒绝任意本地协议导航。
- 签名图片附件在不带 preload 的独立预览窗口展示，附件只作为图片加载。只有主聊天页面可申请麦克风，系统仍可拒绝；摄像头、附件页与其他来源不获授权。macOS 包包含麦克风用途说明。
- 偏好默认放在系统应用数据目录的 `Nanobot-next/`，与旧 lover 分开；可用 `NANOBOT_DESKTOP_DATA_DIR` 指定隔离目录。不同 gateway 分区保存认证缓存。
- 远端工作区不能用本机目录选择器代替，因此这一阶段不宣称支持原生目录选择、引擎重启或诊断桥接。
- 统一收件箱已完成固定入口这一步：Electron 聊天使用 `desktop`，重连不创建新话题；临时/分叉创建请求会被拒绝。普通浏览器保持上游行为。
- 后端需开启 `agents.defaults.unifiedSession: true`，发送和停止沿用上游统一路由；桌面重连状态和上下文查询映射到 `unified:default`。关闭该配置时不会强行开启统一会话。
- 统一历史读取已接入：开启统一会话后，桌面历史接口只读 `unified:default` 原文，复用现有渲染和向前分页，不拼接旧流式日志。读取包含仍在 Session 中的压缩前原文；旧 lover 另存的月度归档尚未导入。
- 桌面侧栏只展示“统一收件箱”聊天入口，不展示旧话题、新建/搜索话题及归档话题操作；Apps、Skills、Automations、Channels 和设置保留。旧话题数据未删除，普通浏览器布局不变。
- 桌面忽略旧分屏布局，隐藏添加窗格、布局切换、消息分叉和临时聊天入口；新话题/话题搜索快捷键不触发多会话操作。普通浏览器保留这些能力。
- 跨渠道完整消息自动同步已接入：其他渠道在统一会话开始执行、回复落盘时通知桌面重读历史，无需手动刷新；新增对话显示来源渠道。桌面自己的消息不重复通知，独立会话、heartbeat、独立 cron 和内部 system/cli 不进入此同步。
- 桌面生成中插入的外部消息也按其真实入站渠道保存来源，并在落盘后触发同步；不是按外层桌面轮次的渠道猜测。来源元数据不发给模型提供方。
- 本阶段不额外开启其他渠道的逐字流式镜像，原渠道回复方式保持。MiniMax TTS、本地伴侣视频和记忆迁移仍待后续。
- 服务端版本若落后于 v0.3.5，新 UI 的部分接口可能不兼容；连接成功不代表旧 lover 后端的所有能力都能直接使用。

本阶段验收：构建和正式 package 命令成功；地址校验、附件路径、脚本语法及 API/静态资源边界测试通过；真实 Electron 进程中验证本地 WebUI、bootstrap、WebSocket、图片预览和模拟消息收发。麦克风测试使用模拟设备且不跳过应用权限处理，不录制真实声音；物理麦克风与 macOS 系统授权交互仍需用户实际验证。模拟链路不消耗模型额度，也不证明真实模型服务可用。

## F03 桌面基础体验

- 主窗口沿用 lover 的 30px 无边框顶栏；Windows/Linux 提供最小化、最大化/还原和关闭按钮，macOS 保留原生红绿灯。连接页、认证页和聊天共用窗口控制，关闭仍隐藏到托盘；Windows/Linux 可按 Alt 打开应用菜单。
- 窗口位置、普通尺寸及最大化状态保存在本机 `Nanobot-next/window.json`，重启或更换后端后恢复；断开外接屏时会移回可见工作区，最小化和全屏不会覆盖普通尺寸。
- 侧边栏底部电源按钮「完全退出」直接结束 Electron，与托盘退出一致；标题栏关闭按钮仍隐藏到托盘。不会停止独立运行的 gateway。
- 关闭主窗口隐藏到托盘；点击托盘或使用全局 `Cmd/Ctrl+Shift+E` 显示/隐藏窗口，菜单「退出」才结束应用。快捷键被占用时仍可通过托盘唤起。
- 「桌面 → 截图并附加」或应用内 `Cmd/Ctrl+Shift+S`：短暂隐藏窗口，截取鼠标所在屏幕，回到统一收件箱并加入附件预览，手动发送。首次使用可能需要系统屏幕录制授权。
- 窗口未聚焦时，桌面对话或外部渠道回复完成可触发系统通知；点击通知唤起窗口，同轮去重，不在通知中显示对话正文。
- 「桌面 → 开机启动」在 macOS/Windows 打包版中可切换，开发模式禁用；默认不主动修改系统登录项。
- `NANOBOT_RAISE_SHORTCUT` 可覆盖全局快捷键（空字符串关闭）；`NANOBOT_DESKTOP_NOTIFICATIONS=0` 关闭系统通知。

本批需完全退出并重启 Electron 生效；外部渠道完成通知还需重启 gateway。验证包含 10 项 Electron 测试、20 项前端测试、221 项后端测试、静态检查、正式打包及打包版模拟 gateway 冒烟。截图测试只使用模拟图片；真实系统截图授权、通知投递与开机启动尚未实机验收。

## F05 外观

在桌面「设置 → 外观」选择九套主题，并设置显示名称与表情。图片头像沿用 lover 的固定来源：gateway 媒体目录中的 `avatar.jpg`、`avatar.png` 或 `avatar.webp`（依次查找），没有 Electron 配置入口；不存在时使用表情。名称用于本机聊天展示，不会改变模型人格。主题切换立即保存，身份和壁纸偏好修改后点击「保存」，也可以取消草稿。

壁纸可选择网络图片网址或本地目录，支持顺序/随机、刷新间隔和手动下一张。单张输入上限 12 MiB；目录通过系统选择器授权，坏图会跳过。窗口隐藏时暂停刷新，加载失败保留上一张并提示。开启壁纸后可调面板不透明度，文字与控件本身不降低透明度；关闭后恢复普通主题。

这些本机偏好保存在 `Nanobot-next/appearance.json`，与旧 lover 和 NAS 配置分开。主题沿用当前 gateway 分区的 localStorage。旧偏好不会自动迁移；本地目录指这台电脑上的目录。新宿主接口需完全退出并重启 Electron 后生效。

## F06 文件与笔记

侧栏「工作区」「笔记库」分别提供只读浏览入口，使用可展开目录树，支持 Markdown、原文、代码和图片，并各自记住上次打开的文件。「今日日记」按 gateway 时区打开当天的日记，不会自动创建缺失文件。

这两个页面不显示右上角的明暗模式切换按钮；主题仍可在外观设置中选择。

在 gateway 配置中设置 `diaryRoot` 为日记目录；它的父目录就是可浏览的笔记库，例如 `/path/to/note/日记` 对应 `/path/to/note`。远端 gateway 应填写远端路径。更改本次新增配置及接口后需重启 gateway，随后刷新 Electron；浏览目录不会改变 Agent 的文件权限。

## F12 按需桌面感知

Electron 连接后自动上报桌面状态，不设功能开关，也不定时截图。心跳中的有效任务需要桌面上下文时，可调用 `desktop_context`；普通对话明确需要看屏幕时也可使用。只取鼠标所在屏幕，长边最多 1600 像素，以 JPEG 传给主模型，模型需能处理图片。

应用处于前台、系统锁屏/休眠或状态未知时不截图；采集中状态变化、切换桌面连接、断线或超时会丢弃结果。多台 Electron 连接时，只有尚无目标的新连接会接管；已有目标只随用户发送消息切换，后台重连不抢占。目标断线后不自动切换到其他已有连接。响应只能完成该连接自己的请求。系统截图权限仍由操作系统控制。

不新建独立截图文件；截图作为单次多模态工具结果使用，正常消息历史只保留图片占位。运行中的上游恢复检查点可能暂存内联图片，结束后按既有机制清理。心跳是否发消息继续走上游通知判断，不绕过 `message` 投递抑制；静默时段和问候条件由现有 HEARTBEAT.md 任务控制。

需要重启 gateway 并完全退出、重新打开 Electron。隔离验证使用 `node electron/test/smoke.cjs --desktop-context`，它只使用模拟采集器，不读取真实屏幕。


## MiniMax 语音

是否生成语音固定由 AI 决定，不需要模式开关；设置概览可选择 gateway 中配置好的 MiniMax 服务与音色。连接后流式播放生成的语音；消息底部的喇叭按钮重播已保存音频，右下角可停止。没有生成过语音的回复会提示不可重播。MiniMax 失败不影响文字回复。

配置沿用 lover 的 tools.tts（preset/voice）和 ttsPresets：preset 中的 config 配置 provider=minimax、apiKey、apiBase、model、speed、rpm；voices 中以 id/label 标识音色，languageVoices.default 是中文音色，languageVoices.ja 是日语音色。密钥只留在 gateway。新文件以 64 kbps MP3 保存在 gateway 实例 media/speech 下，重播不重新合成。gateway 需要 FFmpeg，Dockerfile 已包含此依赖。历史使用 lover 的 speech 对象；原有 speech.path 音频在媒体目录内仍可读时可直接重播，不复用过期签名 URL。

“朗读时暂停系统媒体”默认开启，可在设置中关闭；复用 lover 的媒体暂停/恢复实现。Windows 使用原有系统媒体会话控制；macOS 优先 media-control，缺少时仅支持 Music/Spotify；Linux 暂不支持。只恢复本次暂停且身份匹配的媒体。此项保存在本机，与 gateway 的服务/音色选择分开。


## 本地数字伴侣

设置概览的“数字伴侣”可开启本地视频面板，默认关闭。只区分待机和工作，不连接 LiveTalking，也不随语音切换说话视频。包含 lover 的 9 个内置视频，支持拖动、缩放、收起以及重启后恢复面板位置。

可选择本机场景包目录：idle/sunrise、idle/day、idle/sunset、idle/night，以及对应 working 目录；开始时间可在设置中修改。缺少或损坏素材时回退到内置视频。素材只读，界面不接收任意文件路径；隐藏/收起面板后卸载视频。
