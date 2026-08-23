## 1. 后端 PoC 与选型（已完成）

- [x] 1.1 Windows/RTX 5090 搭建 LiveTalking + MuseTalk + Wav2Lip 测试环境（Python 3.12/torch 2.9.1+cu128，权重与部署坑位已记录 design.md）
- [x] 1.2 同素材同音频 A/B：Wav2Lip(256) 胜出（MuseTalk 模糊、嘴动过快）
- [x] 1.3 记录指标：25FPS 稳定、协商→首帧 2.4s、提交→说话 ~1s、打断即时
- [x] 1.4 确定单一后端 LiveTalking + Wav2Lip(256)；FlashHead Lite 对比按决策跳过，不引入产品抽象
- [x] 1.5 LiveTalking 补丁集落地（边界切换、交叉淡化、进入/退出模式、码率、模循环），`LT_TALK_ENTRY/EXIT` 四组合回归通过

## 2. 动作池素材

- [x] 2.1 素材制作（手动 ComfyUI 生成，含颜色/光照/循环约束经验；脚本管线保留备用）
- [x] 2.2 全套素材：待机×5、说话×3、工作×4（`D:\ComfyUI_windows_portable-G313\ComfyUI\output\Video`，1120×832）
- [x] 2.3 人工验收通过（用户逐条筛选后的成品）
- [x] 2.4 说话池 avatar 数据集 ×3（`data/avatars/avatar_talk_pool/{0,1,2}`）

## 3. LiveTalking 动作池

- [x] 3.1 custom_config 待机池（audiotype=1 父目录多子目录），播满一轮边界随机切换（90s 轮换 17 次验证）
- [x] 3.2 说话池随机选择（`avatar_talk_pool` 3 数据集，每次说话随机选用，帧数自适应）
- [x] 3.3 work 池 audiotype=2，`/set_audiotype` 切入/切回验证通过
- [x] 3.4 回归 boundary/immediate 正常；RAM 占用：说话池×3 约 2.2GB + 待机/工作池约 1.5GB

## 4. Electron 偏好与界面

- [ ] 4.1 现有 Electron 配置和预加载链路中增加带类型的数字伴侣偏好与默认值，默认关闭
- [ ] 4.2 带版本的角色素材清单（静态兜底图 + 动作池目录映射），校验媒体类型和目录边界并测试
- [ ] 4.3 设置分区：启用状态、素材目录、LiveTalking 回环地址、连接超时、进入/退出模式、连接状态
- [ ] 4.4 数字伴侣界面：待机轮换、说话、工作、静态降级状态；动作缺失确定性回退；生命周期测试（打断、纯文字、播放完成、关闭）

## 5. LiveTalking WebRTC 接入

- [ ] 5.1 主进程/预加载带类型 LiveTalking 客户端：仅回环地址，健康检查、协商、音频提交、`set_audiotype`、打断
- [ ] 5.2 渲染层 RTCPeerConnection + 单媒体元素播放音视频流
- [ ] 5.3 播放队列接入：服务健康时提交音频且禁止原始音频重复播放，失败立即回退
- [ ] 5.4 停止/替换/切会话/切角色/退出 → 打断、关连接、释放轨道
- [ ] 5.5 测试：消息顺序、无重复音频、失败降级、打断传播、关闭后原有播放行为

## 6. 文档与验证

- [ ] 6.1 LiveTalking/MuseTalk→Wav2Lip 本地安装、角色准备、Electron 连接说明（含补丁清单重放步骤）
- [ ] 6.2 MiniMax H3 离线素材制作最小流程及约束（32 倍数分辨率、固定光照、中性唇形）
- [ ] 6.3 两种状态（关闭/连接）下运行 Electron lint、单元测试、生产构建
- [ ] 6.4 RTX 5090 手动验证：连续对话、五分钟稳定性、打断、动作池轮换、工作状态切换、服务崩溃降级
- [ ] 6.5 对外分发前复核 LiveTalking 许可证及 README 标识适用范围
