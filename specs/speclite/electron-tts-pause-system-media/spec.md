# Spec: electron-tts-pause-system-media

## Why
- Electron 播放 TTS 时，音乐与语音叠加，听感和可懂度差。
- TTS 结束后应恢复此前播放的媒体，不改变用户原有暂停状态。

## Scope
- 本次做：Electron 的 TTS 设置区增加“朗读时暂停支持的媒体播放器”开关，配置保存在 Electron 本地，默认关闭。
- 本次做：开关启用后，TTS 实际开始播放时暂停受支持且处于 `Playing` 的外部媒体；最后一段 TTS 实际播放结束后恢复。
- 本次做：Windows use WinRT `GlobalSystemMediaTransportControlsSessionManager`，处理支持系统媒体会话的播放器。
- 本次做：macOS 优先 use `media-control` 控制当前 Now Playing 应用；CLI 缺失或查询失败时回退 Music、Spotify AppleScript。
- 本次做：覆盖 Electron 主窗口、PSB、THA、LiveTalking 的 TTS 播放路径；多段或重叠播放只暂停、恢复一次。
- 本次做：权限拒绝、播放器退出、控制失败时继续播放 TTS，不阻塞、不误恢复。
- 本次不做：捕获或分析系统输出音频、控制未注册系统媒体会话的 Windows 应用。
- 本次不做：直接调用 macOS 私有 `MediaRemote`、模拟媒体键、全局静音、逐应用音量 ducking。
- 本次不做：Linux、浏览器 WebUI、支持列表自定义。

## Plan
- [x] Electron TTS 设置区新增开关和文案，接入本地配置与 IPC 类型。
- [x] main 进程新增最小平台控制模块；Windows 查询、暂停、恢复 GSMTC 会话，macOS use `media-control` 并保留 Music/Spotify fallback。
- [x] 暂停操作返回本轮 token，仅记录暂停成功的会话或应用；恢复只消费该 token。
- [x] TTS 播放状态统一为引用计数：首次实际出声时请求暂停，全部本地或委托播放结束后请求恢复。
- [x] 将本地 PCM、历史回放、PSB、THA、LiveTalking 的开始、结束、失败、取消接入同一状态入口。
- [x] 补设置、状态引用计数、平台结果过滤、失败降级和恢复边界测试。

## Apply Notes
- “支持的媒体播放器”不是“所有系统音频”；设置文案禁止承诺暂停游戏、会议软件或普通提示音。
- Windows token use source app、媒体元数据和同源序号定位 session；只恢复本轮暂停、仍存在且仍为暂停态的 session。
- macOS `media-control` token 保存 bundle id、PID、title、artist、album；恢复前校验同一媒体仍暂停。`contentItemIdentifier` 实测会随状态变化，禁止作为稳定标识。
- `media-control` 从 `/opt/homebrew/bin`、`/usr/local/bin` 发现；不可用时按应用记录 AppleScript token，禁止因查询或恢复启动 Music/Spotify。
- 用户在 TTS 期间已恢复播放器时，恢复阶段保持现状，不再次切换播放状态。
- TTS 生命周期以实际播放为准；`assistant_audio_end` 只表示数据流结束，不能直接触发恢复。
- 多段 TTS、重播和播放 owner 切换 use 单个引用计数，不为每个音频重复暂停外部媒体。
- 平台模块只运行在 main 进程；renderer 通过窄 IPC 上报 TTS active/inactive，不暴露任意脚本或命令执行能力。
- 开关仅在 Electron TTS 设置区展示并保存到 `electron-store`；不修改服务端 TTS schema，不向浏览器 WebUI 展示。
- Windows use系统 PowerShell 调用 WinRT；不引入原生 Node addon。macOS fallback 打包声明 `NSAppleEventsUsageDescription`。
- 暂停按目标隔离失败；恢复仅移除成功或已无需恢复的目标，失败子集保留并重试。
- main 按 `webContents.id` 管理播放 lease；renderer crash、reload、destroy 自动释放。
- PSB、THA use实际音频 source ended 回报播放结束；LiveTalking 轮询 `is_speaking`，不再由主窗口估算委托播放时长。
- 本地分段队列 use generation 取消旧 drain；stop 后旧数组引用不能继续播放下一段。
- PSB、THA 队列同样 use generation；等待系统暂停期间收到 stop 后禁止启动旧音频。
- owner 交接恢复前 debounce，并在发送 play 前重查 active lease；新 TTS 已开始时保留 token、不短暂恢复媒体。
- LiveTalking `is_speaking` use三态结果；查询失败继续等待，超时 use `max(30s, audio duration + 10s)`。
- macOS pause 后重读实际 Now Playing 元数据，避免查询与命令之间切换目标导致 token 记错。
- 设置页执行 `media-control test`，显示 system、limited、unavailable 能力；退出恢复总等待上限 `5s`。
- 归档时 Windows GSMTC、打包版 macOS TTS 闭环仍待对应环境验证；用户确认接受延期，不将其记为已验证。
- 不为统一接口引入多层抽象；一个模块内按 `process.platform` 分支。

## Verify
- [x] Electron TTS 设置区展示开关且默认关闭；关闭时 TTS 不查询或控制外部播放器。
- [ ] Windows：支持 GSMTC 的一个或多个 `Playing` session 在 TTS 开始时暂停，TTS 完成后仅恢复本轮暂停的 session。
- [ ] macOS：当前 Now Playing 应用在 TTS 开始时暂停，TTS 完成后仅恢复同一媒体；CLI 不可用时 Music、Spotify fallback 生效。
- [x] 原本暂停的播放器不启动；TTS 期间已恢复播放的播放器不再切换状态。
- [x] 连续分段、流式 PCM、历史回放及 PSB/THA/LiveTalking 委托播放期间，外部媒体无中途恢复或重复切换。
- [x] TTS 失败、取消、窗口关闭或应用退出时释放状态；可恢复的媒体恢复一次，无残留 active token。
- [x] 权限拒绝、系统 API 不可用、播放器中途退出时 TTS 正常播放且无未处理异常。
- [x] Electron 全量 tests、本次文件 lint、macOS arm64 package、Windows x64 package 通过。
- [x] `media-control 0.7.7` 真机识别 StreamMusic，并完成 pause-only、play-only 状态闭环。
- [ ] Windows 与 macOS 各完成一次真机播放器验证。

## Status
- State: done
- Archived: yes
