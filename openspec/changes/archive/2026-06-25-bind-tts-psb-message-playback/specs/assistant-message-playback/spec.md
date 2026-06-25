## ADDED Requirements

### Requirement: Assistant 消息分段播放模型
系统 SHALL 在服务端将需要播放的 assistant 回复派生为有序 playback segment。每个 playback segment SHALL 绑定同一条 assistant message，并包含 `messageId`、`segmentIndex`、原始文本、通用控制元数据、TTS 状态和可选音频结果。展示文本、朗读文本和目标桌宠事件 SHALL 从 segment 原始文本和控制元数据按需派生，不得作为彼此独立的持久事实源。

#### Scenario: 从流式文本生成 segment
- **WHEN** 消息绑定 TTS 开启且 assistant 回复以 delta 形式在服务端出站侧形成完整句子、换行段落、`stream_end` 或 `turn_end`
- **THEN** 服务端 SHALL 生成一个新的 assistant playback segment
- **AND** segment SHALL 使用同一条 assistant message 的 id 和递增 `segmentIndex`

#### Scenario: 无播放需求不生成 playback segment
- **WHEN** 消息绑定 TTS 关闭且没有其他启用的 playback consumer
- **THEN** 系统 SHALL 继续通过现有 assistant delta 流展示文本
- **AND** 系统 SHALL 不额外生成或推送 assistant playback segment

#### Scenario: 同一 segment 对齐多种消费者
- **WHEN** UI、TTS 和 PSB 消费同一个 segment
- **THEN** 这些消费者 SHALL 共享同一个 `messageId` 和 `segmentIndex`
- **AND** 播放、展示和桌宠控制 SHALL 不使用彼此独立的索引或临时文本匹配

#### Scenario: 按需派生展示和朗读文本
- **WHEN** UI 或 TTS 需要消费某个 segment
- **THEN** UI SHALL 从 segment 原始文本和控制元数据派生展示文本
- **AND** TTS SHALL 从 segment 原始文本和控制元数据派生朗读文本
- **AND** 系统 SHALL 允许展示文本和朗读文本使用不同清洗规则

#### Scenario: 保留调试元数据
- **WHEN** segmenter 从原始文本中剥离控制标签
- **THEN** 系统 SHALL 保留足够的 raw/control metadata 用于调试展示
- **AND** 默认用户正文 SHALL 不包含这些控制标签

### Requirement: 干净消息展示和控制标签调试
聊天 UI SHALL 继续按 assistant delta 连续流式展示完整文字回复，并在渲染时过滤控制标签。服务端 segment 生成、TTS 合成和客户端音频播放 SHALL 作为旁路管线运行，不得阻塞、分段打断、重排或等待气泡文字展示。控制标签、音色标签、PSB 标签和播放元数据 SHALL 仅在用户显式开启调试视图时展示。

#### Scenario: 文字回复连续流式展示
- **WHEN** assistant delta 连续到达 Electron 客户端
- **THEN** 聊天气泡 SHALL 随 delta 持续更新干净正文
- **AND** 更新节奏 SHALL 不等待 segment flush、TTS 合成、音频 ready 或 segment 播放开始

#### Scenario: 音频分段不打断文字
- **WHEN** TTS 播放队列正在等待前序 segment 或播放某个 segment 音频
- **THEN** 聊天气泡 SHALL 继续展示后续到达的 assistant 文本
- **AND** 音频播放状态 SHALL 不导致已展示文字被拆成多个气泡或重排

#### Scenario: 默认隐藏控制标签
- **WHEN** assistant 回复包含 PSB 或 TTS 控制标签
- **THEN** 聊天气泡 SHALL 展示剥离标签后的正文
- **AND** 正常 Markdown 渲染 SHALL 不显示控制标签

#### Scenario: 查看控制标签调试信息
- **WHEN** 用户在 assistant 气泡上开启控制标签调试视图
- **THEN** UI SHALL 展示该消息的原始文本或 segment metadata
- **AND** 调试视图 SHALL 至少包含 segment index、controls 和 TTS/audio 状态

### Requirement: 消息绑定 TTS 开关
系统 SHALL 提供消息绑定 TTS 开关。开启后，服务端 assistant playback segment SHALL 自动进入 TTS 合成队列；关闭后，系统 SHALL 不自动为 assistant 回复生成 playback segment 或语音，聊天展示 SHALL 继续使用现有 delta 流。

#### Scenario: 开启消息绑定 TTS
- **WHEN** 消息绑定 TTS 开启且 assistant segment 生成
- **THEN** 系统 SHALL 从 segment 原始文本和控制元数据派生朗读文本，并请求 TTS provider 合成语音
- **AND** 合成结果 SHALL 写回对应 segment 的 audio 状态

#### Scenario: 关闭消息绑定 TTS
- **WHEN** 消息绑定 TTS 关闭且没有其他启用的 playback consumer
- **THEN** 系统 SHALL 不请求 TTS provider
- **AND** 系统 SHALL 不触发 segment playback 生命周期
- **AND** 聊天 UI SHALL 仍按 delta 流展示过滤控制标签后的正文

### Requirement: 有序 segment 播放生命周期
系统 SHALL 按 `segmentIndex` 顺序串行播放 assistant segments。TTS 合成 MAY 并发执行，但音频播放和桌宠生命周期事件 MUST 按 index 顺序消费，同一条 assistant message 的多个 segment 音频不得重叠播放。

#### Scenario: 后段音频先完成
- **WHEN** segment 2 的音频先于 segment 1 完成
- **THEN** 播放队列 SHALL 等待 segment 1 完成或失败后再播放 segment 2
- **AND** 桌宠 SHALL 不提前执行 segment 2 的动作

#### Scenario: 多段音频顺序切换
- **WHEN** segment N 的音频播放结束且 segment N+1 已准备好
- **THEN** 系统 SHALL 先发出 segment N 的 segment-end 生命周期事件
- **AND** 系统 SHALL 随后开始播放 segment N+1
- **AND** 系统 SHALL 在 segment N+1 音频开始前发出 segment N+1 的 segment-start 生命周期事件

#### Scenario: 多段音频不得重叠
- **WHEN** segment N 正在播放音频
- **THEN** 系统 SHALL 不播放 segment N+1 或更后续 segment 的音频
- **AND** 即使后续 segment 音频已经 ready，也 SHALL 等待当前 segment 结束或失败跳过

#### Scenario: segment 播放开始
- **WHEN** 播放队列开始消费某个 segment
- **THEN** 系统 SHALL 发出 segment-start 生命周期事件
- **AND** 事件 SHALL 携带 `messageId`、`segmentIndex`、朗读文本和控制元数据

#### Scenario: segment 播放结束
- **WHEN** segment 音频播放结束或 TTS 失败被跳过
- **THEN** 系统 SHALL 发出 segment-end 生命周期事件
- **AND** 后续 segment SHALL 只在当前 segment 结束后开始

### Requirement: 播放中断和会话切换
系统 SHALL 在用户停止生成、切换会话、刷新历史或关闭桌宠窗口时终止当前 assistant playback，并通知相关桌宠恢复默认状态。

#### Scenario: 用户停止当前回复
- **WHEN** 用户停止正在生成或播放的 assistant 回复
- **THEN** 系统 SHALL 取消未完成的 segment TTS 请求或忽略其结果
- **AND** 当前播放中的音频 SHALL 停止
- **AND** 桌宠 SHALL 收到 playback-stop 或等价恢复事件

#### Scenario: 切换会话
- **WHEN** 用户切换到另一会话或刷新历史快照
- **THEN** 系统 SHALL 不播放历史 segment
- **AND** 历史消息 SHALL 只用于展示，不触发桌宠控制事件或 TTS 自动播放
