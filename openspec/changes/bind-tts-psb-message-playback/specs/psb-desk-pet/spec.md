## MODIFIED Requirements

### Requirement: PSB 音频口型同步
PSB 桌宠展示时，消息绑定 TTS 的 segment 音频 SHALL 由 PSB 窗口实际播放。Electron 主聊天窗口 SHALL 只负责播放队列协调和生命周期转发，不得同时播放同一段 PSB 音频。PSB 窗口 SHALL 使用 Web Audio 分析当前 segment 音频音量并驱动模型口型变量，且口型同步 SHALL 使用 segment identity 对齐当前播放内容。

#### Scenario: 播放 segment TTS 音频
- **WHEN** 当前会话开始播放带音频的 assistant segment
- **THEN** PSB 窗口 SHALL 获取并播放该 segment 音频
- **AND** 口型同步 SHALL 绑定该 segment 的 `messageId` 和 `segmentIndex`
- **AND** 聊天主窗口不得重复承担 PSB 的口型播放职责

#### Scenario: 口型变量存在
- **WHEN** 当前 PSB 模型支持 `face_talk` 或等价口型变量
- **THEN** PSB 窗口 SHALL 根据 200-3000 Hz 人声音量能量平滑写入口型变量

#### Scenario: segment 音频结束
- **WHEN** 当前 segment 音频播放结束、失败跳过或被用户停止
- **THEN** PSB 窗口 SHALL 将口型变量恢复为闭嘴状态
- **AND** 口型恢复 SHALL 不等待整轮 assistant turn 结束

### Requirement: PSB AI 标签注入和解析
当 PSB 特殊标签启用时，系统 SHALL 向 AI 注入当前选中 PSB 模型支持的配置类型、标签格式和句首放置约束。assistant 回复中的 PSB 特殊标签 SHALL 在服务端 segmenter 中解析为通用 segment controls 中可供 PSB 消费的一类控制元数据，不作为默认展示正文。PSB 标签 MUST 放在句首，并在对应播放段开始时同步给 PSB 窗口。若消息绑定 TTS 关闭且没有 playback segment，PSB 标签 SHALL 只从默认展示文本和朗读文本中过滤，不触发 PSB segment lifecycle。

#### Scenario: 注入当前模型能力
- **WHEN** 当前会话构建 AI 上下文且 `deskPet.psb.enabledResponseTags` 为 true
- **THEN** 系统 SHALL 注入当前选中 PSB 模型支持的 timeline、expression、face、fade 能力摘要
- **AND** 注入内容 SHALL 包含可用标签格式示例
- **AND** 注入内容 SHALL 要求 PSB 标签放在每句话的句首

#### Scenario: 解析句首 timeline 标签
- **WHEN** assistant segment 原始文本以 `<psb:timeline name="...">` 或等价格式开头
- **THEN** segmenter SHALL 将该标签解析为该 segment controls 中可供 PSB 消费的 timeline 控制项
- **AND** 聊天 UI 派生的默认展示文本 SHALL 移除该标签
- **AND** PSB 窗口 SHALL 在该 segment 播放开始时执行该 timeline action

#### Scenario: 解析句首 face 和 fade 标签
- **WHEN** assistant segment 原始文本开头包含 PSB face 或 fade 标签
- **THEN** segmenter SHALL 将变量名和值保存为该 segment controls 中可供 PSB 消费的控制项
- **AND** PSB 窗口 SHALL 在该 segment 播放开始时应用这些变量
- **AND** 不在当前模型元数据中的变量 SHALL 被忽略或作为不可用标签记录

#### Scenario: 句中控制标签
- **WHEN** assistant 输出在句子或 segment 中间包含 PSB 控制标签
- **THEN** 系统 SHALL 从派生的默认展示文本和朗读文本中剥离该标签
- **AND** 系统 SHALL 记录到调试元数据
- **AND** 系统 SHALL 不默认执行该句中标签

#### Scenario: 控制标签默认隐藏
- **WHEN** assistant 回复包含 PSB 特殊标签
- **THEN** 聊天 UI SHALL 在展示 assistant 回复时隐藏 PSB 特殊标签
- **AND** 标签仍 SHALL 作为 segment 控制元数据被解析

#### Scenario: 控制标签调试可见
- **WHEN** 用户在 assistant 气泡中开启控制标签调试视图
- **THEN** 聊天 UI SHALL 展示该消息的原始 PSB 标签或解析后的 segment controls
- **AND** 调试展示 SHALL 不改变 segment 播放行为

### Requirement: PSB 临时状态恢复
PSB 桌宠 SHALL 根据有音频的 segment 生命周期恢复临时展示状态。非循环 timeline SHALL 在播放结束后恢复初始循环 timeline；表情、face 和 fade 临时状态 SHALL 在当前 segment 结束后恢复，若下一 segment 立即开始则 SHALL 先结束上一 segment 再执行下一 segment 动作。无音频模式一期不触发 PSB segment lifecycle。

#### Scenario: 非循环 timeline 播放结束
- **WHEN** PSB 窗口执行一个非循环 timeline 标签
- **THEN** timeline 播放结束后 SHALL 自动切回初始循环 timeline

#### Scenario: segment 音频结束
- **WHEN** 当前 assistant segment 音频播放结束
- **THEN** PSB 窗口 SHALL 将表情、face 和 fade 恢复为初始状态
- **AND** 恢复 SHALL 使用该 segment 的生命周期，而不是等待整轮 turn_end

#### Scenario: TTS 关闭不触发 segment lifecycle
- **WHEN** 消息绑定 TTS 关闭且没有可播放 segment
- **THEN** PSB 窗口 SHALL 不接收 segment-start 或 segment-end
- **AND** 聊天 UI SHALL 仍隐藏 PSB 特殊标签

#### Scenario: 下一 segment 开始
- **WHEN** 下一个 segment 即将开始播放
- **THEN** PSB 窗口 SHALL 先结束上一 segment 的临时 expression、face 和 fade 状态
- **AND** 随后 SHALL 执行下一 segment controls 中可供 PSB 消费的控制项

#### Scenario: 相邻 segment 音频切换
- **WHEN** segment N 音频结束并切换到 segment N+1 音频
- **THEN** PSB 窗口 SHALL 先恢复 segment N 的临时状态和口型
- **AND** PSB 窗口 SHALL 再执行 segment N+1 的 controls
- **AND** PSB 窗口 SHALL 使用 segment N+1 音频重新开始口型同步
