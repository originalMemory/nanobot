## 为什么

Electron 目前只能用文字和音频呈现 nanobot 的回复，无法显示一个嘴型、表情和待机动作随对话变化的常驻角色。新增本地数字伴侣模式，可以在不把完整视频生成模型塞进低延迟链路的前提下，让语音对话具备更强的临场感。

## 变更内容

- 新增仅限 Electron 的可选数字伴侣视图，支持常驻角色、待机动作、说话状态和静态降级。
- 使用 LiveTalking + Wav2Lip(256) 后端和 WebRTC 输出，根据 nanobot/TTS 音频近实时驱动说话视频的嘴型；待机时播放原始待机视频帧。该路径已在 RTX 5090 上完成端到端验证（含对 MuseTalk 的 A/B 对比，Wav2Lip 胜出）。
- 角色素材采用"同源图动作池"：多个待机视频（轮换）、多个说话视频（随机选）、多个工作状态视频（整理视频、写脚本等无音频任务关联画面）。
- 新增本地角色资源、LiveTalking 服务地址、启用状态及连接偏好配置。
- MiniMax H3（ComfyUI 工作流）仅用于离线制作动作视频，管线已脚本化（`scripts/avatar_assets.py`）；完整视频生成不进入实时回复链路。
- SoulX-FlashHead Lite 对比 PoC 未执行，按决策直接采用 LiveTalking 单一路径。

## 能力

### 新增能力

- `electron-avatar-companion`：Electron 数字伴侣展示、动作池、音频驱动唇形、配置、降级及生命周期行为。

### 修改能力

无。

## 影响

- 涉及 `electron/` 下的渲染进程、主进程/预加载 IPC、本地偏好、音频播放集成及测试。
- 涉及 `scripts/avatar_assets.py` 素材管线（已存在）及 LiveTalking 本地补丁集（`D:\code\GitHub\LiveTalking`，以 `补丁:` 注释标记）。
- 增加可选的本地 LiveTalking 服务接入和安装文档；服务缺失时普通 Electron 聊天仍可正常使用。
- 复用现有 nanobot 回复、TTS/音频播放和会话流程；首版无需修改根 `webui/` 或网关协议。
- 仅在启用数字伴侣时增加本地 GPU/显存消耗；模型权重不随应用打包。
