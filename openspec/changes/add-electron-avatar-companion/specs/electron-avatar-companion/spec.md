## ADDED Requirements

### Requirement: Electron 数字伴侣模式

Electron 应用 SHALL 提供独立于浏览器 WebUI 的可选数字伴侣界面，并 SHALL 默认关闭该功能。

#### Scenario: 启用有效数字伴侣

- **WHEN** 用户使用有效角色素材启用数字伴侣模式
- **THEN** Electron SHALL 显示角色的待机动作或静态兜底图
- **AND** 根浏览器 WebUI SHALL 保持不变

#### Scenario: 数字伴侣已关闭

- **WHEN** 数字伴侣模式关闭
- **THEN** Electron SHALL NOT 建立 LiveTalking 会话或消耗数字伴侣 GPU 资源
- **AND** 普通聊天和音频播放 SHALL 保持原有行为

### Requirement: 角色素材校验

Electron SHALL 加载带版本的本地角色素材清单，要求提供静态兜底图，校验引用媒体类型，并拒绝解析到所选角色目录之外的资源路径。

#### Scenario: 有效的最小角色素材

- **WHEN** 角色目录包含受支持的清单和静态兜底图，但没有动作视频
- **THEN** Electron SHALL 显示静态兜底图
- **AND** SHALL 允许数字伴侣以简化动作模式运行

#### Scenario: 资源路径越界

- **WHEN** 清单引用角色目录之外的资源
- **THEN** Electron SHALL 拒绝该角色素材
- **AND** SHALL NOT 读取或显示越界资源

### Requirement: 动作视频池

系统 SHALL 支持由同一参考图生成的多个动作视频：待机池、说话池和工作状态池。待机视频 SHALL 在播放至少一轮后于循环边界随机切换；每次说话 SHALL 从说话池随机选择基底；无音频的任务类回复 SHALL 能切入工作状态视频并播完回落待机。

#### Scenario: 待机池轮换

- **WHEN** 当前待机视频播放满一轮到达循环边界
- **THEN** 系统 SHALL 随机切换到待机池中的另一视频
- **AND** 切换处 SHALL NOT 出现姿势跳变

#### Scenario: 说话池随机选择

- **WHEN** 连续多次助手语音播放
- **THEN** 每次 SHALL 从说话池随机选用说话基底视频
- **AND** 口型同步 SHALL 正常

#### Scenario: 任务类回复切入工作状态

- **WHEN** 助手回复不含可播放音频且被判定为任务执行中
- **THEN** 系统 SHALL 切入工作状态视频
- **AND** 工作视频播完或任务结束后 SHALL 回落待机池

### Requirement: 运动视频口型同步

系统 SHALL 使用闭嘴的运动视频作为 LiveTalking/Wav2Lip 说话基底素材，使原视频的身体、头发、眨眼和头部运动在说话时继续播放，并根据助手音频生成同步嘴型。说话基底 SHALL 使用中性闭合唇形（不放大源图微笑）。动作视频 MAY 包含小幅度的自然表情变化（眼神、眉梢、嘴角轻微起伏）。

#### Scenario: 在运动视频上说话

- **WHEN** 当前说话基底为受支持的闭嘴运动视频且 LiveTalking 收到助手音频
- **THEN** WebRTC 输出 SHALL 保留基础视频的非嘴部运动
- **AND** SHALL 呈现与助手音频同步的嘴型

#### Scenario: 运动视频不适合处理

- **WHEN** 说话基底视频缺失、无效或无法由 LiveTalking 加载
- **THEN** Electron SHALL 使用静态兜底图或本地待机素材
- **AND** SHALL NOT 阻止原始音频播放

### Requirement: 数字伴侣生命周期状态

数字伴侣 SHALL 支持 `idle`、`speaking` 和 `working` 状态，并 MAY 支持 `listening`、`happy` 等额外状态。状态动作缺失时 SHALL 确定性地退回待机池，再退回静态兜底图。

#### Scenario: 助手开始说话

- **WHEN** 助手音频播放项开始通过 LiveTalking 输出
- **THEN** 数字伴侣 SHALL 进入 `speaking` 状态

#### Scenario: 请求的动作不存在

- **WHEN** 当前角色没有请求状态对应的动作视频
- **THEN** 数字伴侣 SHALL 优先使用待机池，否则使用静态兜底图

#### Scenario: 播放结束或被打断

- **WHEN** 助手音频完成、停止或被替换
- **THEN** 数字伴侣 SHALL 离开 `speaking` 状态并返回当前非说话状态

### Requirement: LiveTalking WebRTC 会话

配置的本地 LiveTalking 服务健康时，Electron SHALL 通过 WebRTC 接收数字伴侣音视频流，并 SHALL 使用现有音频播放队列决定音频提交顺序和取消时机。

#### Scenario: 建立数字伴侣会话

- **WHEN** 用户打开已启用且配置有效的数字伴侣界面
- **THEN** Electron SHALL 与 LiveTalking 完成 WebRTC 协商
- **AND** SHALL 在一个媒体元素中播放其音视频流

#### Scenario: 提交助手音频

- **WHEN** 播放队列取出一条带可播放音频的助手消息且 LiveTalking 会话健康
- **THEN** Electron SHALL 将该音频提交给当前 LiveTalking 会话
- **AND** SHALL NOT 同时通过原始音频播放器播放第二份声音

#### Scenario: 纯文字回复

- **WHEN** 助手回复不含可播放音频
- **THEN** Electron SHALL NOT 向 LiveTalking 提交说话任务

### Requirement: 说话打断

Electron SHALL 将现有播放队列的停止、替换及会话切换操作传播到 LiveTalking 的说话打断能力。

#### Scenario: 播放项被取消

- **WHEN** 当前助手音频被停止、替换或因切换会话而丢弃
- **THEN** Electron SHALL 请求 LiveTalking 打断当前说话
- **AND** SHALL 停止呈现该播放项的说话状态

### Requirement: LiveTalking 失败降级

数字伴侣 SHALL 为可选能力；LiveTalking 缺失、不健康、不兼容、连接超时或提交失败时 SHALL NOT 阻止助手回复和音频播放。

#### Scenario: LiveTalking 不可用

- **WHEN** 数字伴侣已启用但 LiveTalking 健康检查或 WebRTC 协商失败
- **THEN** Electron SHALL 使用本地素材保持角色可见
- **AND** SHALL 通过现有播放路径播放助手原始音频
- **AND** SHALL 显示非阻塞的不可用状态

#### Scenario: 音频提交失败

- **WHEN** 当前音频无法在短超时内交给 LiveTalking 播放
- **THEN** Electron SHALL 立即回退到原始音频
- **AND** SHALL 使用本地说话动画，避免丢失回复

### Requirement: 本地服务安全边界

Electron SHALL 只接受回环地址上的 LiveTalking 服务，并 SHALL 通过带类型的主进程/预加载 API 访问服务，不得向渲染组件暴露任意程序执行能力。

#### Scenario: 配置非回环地址

- **WHEN** 用户提供的 LiveTalking 地址不是本机回环地址
- **THEN** Electron SHALL 拒绝该配置

### Requirement: 数字伴侣偏好

Electron SHALL 使用现有本地偏好机制保存数字伴侣启用状态、界面状态、角色素材目录、LiveTalking 回环地址、连接超时及进入/退出切换模式偏好，但 SHALL NOT 保存模型权重或渲染输出。

#### Scenario: 重启后恢复偏好

- **WHEN** 用户配置有效数字伴侣并重启 Electron
- **THEN** Electron SHALL 恢复偏好
- **AND** SHALL 在使用前重新校验角色素材与 LiveTalking 服务

#### Scenario: 关闭数字伴侣

- **WHEN** 用户关闭数字伴侣、切换角色或退出应用
- **THEN** Electron SHALL 关闭 RTCPeerConnection 并释放媒体轨道

### Requirement: 离线动作素材生成

实时对话 SHALL NOT 要求运行 MiniMax H3、LTX 或 LivePortrait。系统 SHALL 允许消费由 MiniMax H3（经 `scripts/avatar_assets.py` 管线）或其他工具离线制作并经人工验收的闭嘴动作视频。素材 SHALL 保持全程固定光照（无昼夜漂移）、身份一致且首尾可无缝循环。

#### Scenario: 使用离线生成动作

- **WHEN** 角色素材包含兼容的离线生成动作视频
- **THEN** Electron 和 LiveTalking SHALL 将其作为普通角色动作素材使用
- **AND** SHALL NOT 在对话期间调用对应视频生成模型

### Requirement: 单一首版后端决策

首版 SHALL 仅接入 LiveTalking + Wav2Lip(256) 单一路径（已按 RTX 5090 A/B 结果确定），SHALL NOT 为未选方案维护产品级后端抽象。

#### Scenario: 后端已确定

- **WHEN** 实施 Electron 集成
- **THEN** SHALL 只对接 LiveTalking 现有 HTTP/WebRTC 接口与已落地补丁集
- **AND** SHALL NOT 引入 MuseTalk 产品路径或 AvatarBackend 抽象层
