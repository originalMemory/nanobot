## 背景

Electron 已能接收带音频媒体的助手消息并通过客户端队列播放，也已有本地偏好 IPC 和独立窗口模式。新功能必须复用这些能力、保持可选，并在本地数字人服务不可用时保证普通聊天正常工作。

LiveTalking 提供 WebRTC 输出、音画同步、说话打断和动作编排（custom_config）。实测在其上叠加补丁（边界切换、交叉淡化、码率）即可满足质量要求，重复实现推流和会话能力没有价值。

PoC 已完成（RTX 5090 / Windows）：
- LiveTalking + MuseTalk v1.5 与 + Wav2Lip(256) 同素材 A/B：**Wav2Lip 胜出**（嘴型更自然、清晰度可接受；MuseTalk 画面模糊且嘴动偏快）。
- 端到端指标：25FPS 稳定、协商→首帧 2.4s（暖机）、音频提交→说话 ~1s、打断即时生效。
- TTS：Qwen3-TTS 本地 x_vector 音色克隆可用（首句 RTF≈1.2）；IndexTTS2 有原生流式生成器；两者均可驱动唇形，whisper/mel 特征对 TTS 来源不敏感。
- FlashHead Lite 对比未执行，按决策放弃。

## 目标与非目标

**目标：**

- Electron 数字伴侣界面：待机轮换、说话跟随音频、工作状态联动。
- LiveTalking + Wav2Lip(256) 作为唯一实时后端。
- 同源图动作池：多个待机/说话/工作视频，循环边界无缝互切。
- 复用 nanobot 现有回复、TTS 和会话，不引入第二套 LLM/TTS。
- 服务失败时退回静态图和普通音频播放，不阻塞对话。

**非目标：**

- 修改浏览器 WebUI。
- 在实时链路运行 MiniMax H3、LTX 或其他完整视频生成模型。
- 首版随 Electron 打包 LiveTalking、模型权重、Python 或 CUDA。
- 同时维护多个推理后端或建立通用插件系统。
- 摄像头驱动、用户人脸复刻、角色素材编辑器或下载市场。

## 技术决策

### 1. 直接接入 LiveTalking（本地补丁集），不自研推理服务

LiveTalking 运行于 `D:\code\GitHub\LiveTalking`（Python 3.12 / torch 2.9.1+cu128）。Electron 通过 `/offer` WebRTC 协商、`/humanaudio` 提交音频、`/interrupt_talk` 打断、`/set_audiotype` 切动作状态。地址仅限本机回环，经主进程/预加载带类型 IPC 暴露。

部署事实（Windows）：requirements 缺 `face_recognition`（用 `dlib-bin` 预编译轮）；whisper 需 transformers 格式（HF `openai/whisper-tiny`）；Wav2Lip 权重须用 256px 变体（`wav2lip256.pth` → `models/wav2lip.pth`），genavatar 须 `--img_size 256`。

**LiveTalking 补丁清单**（全部以 `补丁:` 注释标记，便于同步上游）：

| 文件 | 内容 |
|---|---|
| `utils/image.py` | `mirror_index` → 模循环（素材自身首尾一致，去掉往返倒放） |
| `avatars/audio_features/whisper.py` | 静音 RMS 门限 + 边界 EMA（仅 whisper/MuseTalk 路径；wav2lip 走 MelASR 不需要） |
| `avatars/base_avatar.py` | ①说话↔静音按帧计数交叉淡化（10 帧）②`LT_TALK_ENTRY/EXIT=boundary\|immediate` 进入/退出模式 ③结束等待截断、新音频中止、feat_queue 排空 ④静音分支优先显示推理帧 |
| `server/rtc_manager.py` | H264 编码器 monkey-patch 码率（`LT_VIDEO_BITRATE_KBPS`，默认 12000）+ answer SDP fmtp 注入；aiortc 忽略 SDP x-google-* 必须直改编码器 |

### 2. 双视频架构：待机播原始帧，说话播推理帧

- 静音：custom_config `audiotype=1` 指向待机视频帧目录，播放原始帧（无损画质）。
- 说话：genavatar 从"中性唇形"说话基底视频生成 avatar 数据集，Wav2Lip 重绘嘴部。
- 切换：`boundary`（默认）等循环边界再切，素材同源图且首尾一致 ⇒ 边界处两边姿态天然对齐；`immediate` 立即切换靠 0.4s 交叉淡化掩盖。等待上限 = 单个素材时长（~10s）。
- 健康时 WebRTC 流是唯一音频输出；失败短超时回退原始音频播放。

### 3. 同源图动作池

所有视频由同一张参考图（`D:\ComfyUI_00055_.png`）生成，帧 0 姿态近似一致，任意两视频在循环边界互切无跳变。

- 待机池（idle×2-3）：播放 ≥1 轮后于边界随机切换下一个。
- 说话池（talking×2）：每次说话随机选一个 avatar 数据集（内存 ~1GB/个，池 ≤3）。
- 工作状态（work×2-3，无声动作视频如敲键盘/托腮思考/整理文件）：custom_config `audiotype≥2` 条目，nanobot 判定任务类回复（无音频）时经 `/set_audiotype` 切入，播完回落待机。

### 4. 素材管线：MiniMax H3 离线生成，已脚本化

`scripts/avatar_assets.py`（本项目仓库）：`submit --action idle,talking,... --image <ref>` 提交 ComfyUI（工作流 `▶▷MiniMaxH3-加速视频流整合.json` 激活的图生视频组），`poll` 轮询并在完成后调 `/free` 释放显存。

实测约束：
- 分辨率宽高必须可被 32 整除（720 高度不合法）；与源图一致用 1280×960。
- 243 帧（10.1s@24fps）生成耗时 197–313s（5090），运动复杂度影响 ±35%。
- 长视频存在昼夜/光照漂移风险（实测 idle 出现白天→黑夜→白天），提示词须强制固定时段并人工逐条验收。
- 源图本身带微笑，提示词须约束"不放大微笑"；表情允许小幅自然变化（眼神/眉梢/嘴角轻微起伏），幅度过大会破坏循环接缝。
- 说话基底必须中性闭合唇形（微笑帧会被 wav2lip 拉宽嘴角）。

### 5. Electron 只保存轻量配置

偏好保存启用状态、界面状态、角色素材目录、LiveTalking 回环地址、连接超时、进入/退出模式偏好。默认关闭，权重不进入 electron-store。模型/生成媒体不随应用分发。

### 6. TTS 选项

GLM-TTS（云）/ Qwen3-TTS（本地，已验证克隆）/ IndexTTS2（本地，原生流式）。唇形质量与 TTS 引擎无关；流式（IndexTTS2 generator 或分句提交）可将首响延迟从整段合成时间降到首句。首版不强制流式。

## 风险与权衡

- [光照昼夜漂移] → 提示词固定时段 + 人工验收，不合格换 seed 重跑。
- [说话基底嘴角被微笑帧拉宽] → 说话素材强制中性唇形。
- [Wav2Lip 256px 嘴部清晰度上限] → 接受；待机/工作状态用原始帧不受影响。
- [说话池内存 ~1GB/个] → 池 ≤3。
- [边界等待最长 ~10s] → `LT_TALK_ENTRY=immediate` 可选零等待。
- [LiveTalking 补丁与上游脱节] → 补丁集中标记，升级时按清单重放。
- [本地服务形成安全边界] → 仅回环地址 + 主进程最小 IPC。
- [LiveTalking README 发布标识要求] → 对外分发前复核许可。

## 迁移计划

1. ~~PoC 与后端选型~~（已完成：Wav2Lip 胜出）。
2. 扩展素材预设并生成动作池全套素材，人工验收。
3. LiveTalking 动作池补丁（待机轮换/说话池/工作状态）。
4. Electron 偏好 + 静态/待机界面（默认关闭）。
5. Electron 接入 WebRTC、音频提交、打断、状态切换。
6. 回滚 = 关闭数字伴侣，聊天与音频链路不变。

## 待确认问题

- nanobot 侧"任务类回复无音频"的判定信号与 `/set_audiotype` 的映射时机（Electron 集成时定）。
- 工作状态视频与实际任务语义的对应粒度（首版仅通用 work 动作）。
- 对外发布安装包时 LiveTalking 标识声明的适用范围。
