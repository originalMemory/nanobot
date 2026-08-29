# Spec: electron-avatar-local-video

## Why
- LiveTalking 为每个会话全量解码 `idle/work` 视频帧，当前约 5 GiB/会话；待机与工作画面不需要服务端推理。
- Electron 面板最大宽度 560，无法充分使用原始 `1120x832` 视频；需放宽到 1120。
- LiveTalking 不可用时，面板缺少就地重连入口。

## Scope
- 本次要做：数字伴侣面板最大宽度由 `560` 改为 `1120` CSS px，保持 `4:3` 容器和已存面板宽度的 clamp。
- 本次要做：将 `Y:\live-talking-assets` 的 5 个待机、4 个工作 MP4 纳入 `electron/avatar-videos/`，随 Forge `extraResource` 打包；主进程提供只读本地资源 URL，renderer 不能传任意文件路径。
- 本次要做：Electron 播放待机/工作素材；仅空闲、工作、说话分类变化时交叉淡入淡出；同分类每条播完随机换另一条，不加切换动画。
- 本次要做：仅说话态建立/保持 LiveTalking WebRTC；非说话态断开连接并播放本地视频。音频转交与会话创建按实际说话生命周期调整，避免为待机/工作创建服务端会话。
- 本次要做：小窗口离线态增加“重试”按钮；点击重新健康检查并重新协商，失败保留错误提示，不自动无限重试。
- 本次要做：LiveTalking 启动不再传 `--customvideo_config`，删除 idle/work 全帧加载；保留 Wav2Lip 说话池，并检查会话结束是否立即释放会话对象和队列。
- 本次不做：重编码现有 MP4；面板超过 1120 宽；浏览器 WebUI；远程视频下载、用户自定义视频目录、多窗口共享会话。

## Plan
- [x] 复制并命名本地待机/工作 MP4 到 `electron/avatar-videos/`；在 Forge 开发和打包环境都可解析资源路径。
- [x] 主进程/preload/declarations：暴露固定视频清单或安全资源 URL，不暴露任意本地文件读取能力。
- [x] `AvatarCompanionPanel`：最大宽度 1120；以本地 `<video>` 驱动 idle/working；用两个叠放视频元素和 CSS opacity transition 实现分类交叉淡入淡出；每态只保留一个活动解码器。
- [x] 调整 `livetalking-bridge`、播放队列与面板连接时机：说话前连接并传递语音，结束后切回本地视频并关闭 PeerConnection；重试按钮复用同一连接流程。
- [x] `LiveTalking`：启动脚本移除 `--customvideo_config`；确认 WebRTC closed/failed 会移除会话，不再加载 `data/customvideo`。
- [x] 增加最小单测：lazy connect、idle/working 不调用 LiveTalking、PSB 委托释放；执行 Electron 全量测试与生产 Vite 构建。

## Apply Notes
- 原始视频均为 H.264 `1120x832`、24 fps，总量约 11.5 MiB；放在独立 `electron/avatar-videos` 并由 Forge `extraResource` 复制，避免 renderer `publicDir` 将视频重复写入 asar。运行时从 `process.resourcesPath/avatar-videos` 生成 URL。
- 1120 CSS px 在 100% 缩放时与素材宽度一致；高 DPI 由 Chromium 缩放。保持原片，避免为很小的播放端内存收益增加转码与画质损失。
- 本地视频只需一条常驻解码流；分类切换期间最多两条短暂并存。同分类换片不加动画；分类淡入淡出放 renderer，不能再调用 `/set_audiotype`。
- 说话首帧延迟取决于 WebRTC 协商。先实现“说话前连接”；若体感不可接受，再单独评估保活空会话与内存取舍。
- LiveTalking Wav2Lip 说话池当前也会全量读图，约 1 GiB。此改动先消除更大的 `idle/work` 约 5 GiB/会话；按需帧缓存属于后续独立改动，避免本次引入实时掉帧风险。

## Verify
- [x] `npm run package` 成功；包内 `resources/avatar-videos` 含 9 个视频、11.51 MiB，`app.asar` 无重复视频。
- [x] 打包后的 `nanobot.exe` 冒烟启动成功，4 秒内主进程及子进程保持运行；测试实例已关闭。
- [ ] 面板可拖拽至 1120 宽，收起/重启后宽度保存；`4:3` 容器不变。
- [ ] 禁用或停止 LiveTalking 时，待机、工作 MP4 可播放、随机轮换、循环及交叉淡入淡出；应用打包后也可播放。
- [ ] idle/working 状态不创建 LiveTalking WebRTC 会话；进入说话才连接，结束后释放连接并恢复本地视频。
- [ ] LiveTalking 离线时显示重试按钮；点击后成功恢复视频和音频，失败仍显示可读错误。
- [ ] 服务端以新启动脚本运行后，日志不出现 `custom pool`，进程不读取 `data/customvideo`；建立一条说话会话的 RAM 明显低于当前约 11 GiB。
- [ ] `npm run lint`、`npm test` 通过；手动确认说话时音频不重复播放、切换无黑屏。

## Status
- State: doing
- Archived: no
