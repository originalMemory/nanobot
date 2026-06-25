## MODIFIED Requirements

### Requirement: 音频媒体出站
服务端 SHALL 负责生成 assistant playback segment、调用 TTS provider 合成音频，并将 segment 音频作为带 segment identity 的媒体结果推送给订阅目标 `chat_id` 的连接。音频 MIME SHALL 纳入允许提供的媒体类型白名单。音频媒体 SHALL 能够关联 `messageId` 和 `segmentIndex`，不得只作为整条消息的无序附件处理。

#### Scenario: 推送 segment 音频媒体
- **WHEN** 服务端 assistant segment TTS 合成完成并生成音频文件
- **THEN** 系统 SHALL 为其生成签名媒体 URL 并随 segment audio 事件推送给订阅连接
- **AND** 事件 SHALL 携带 `messageId` 和 `segmentIndex`

#### Scenario: 音频 MIME 放行
- **WHEN** 客户端通过签名 URL 拉取 segment 音频文件
- **THEN** 系统 SHALL 以正确的音频 MIME（如 `audio/wav`、`audio/mpeg` 或 provider 返回格式）提供该文件

#### Scenario: 音频结果写回对应 segment
- **WHEN** 客户端收到 segment 音频媒体事件
- **THEN** 客户端 SHALL 使用 `messageId` 和 `segmentIndex` 找到对应 segment
- **AND** 客户端 SHALL 不通过正文文本匹配音频归属

### Requirement: Electron 自动播放主动语音
Electron 客户端收到 assistant segment 音频就绪事件时 SHALL 按 segment index 顺序串行消费该音频。Electron SHALL 维护播放队列和 segment 生命周期顺序；PSB 窗口可用时 SHALL 作为 PSB 模式下的实际音频播放方和口型分析方。Electron 主聊天窗口 SHALL 不与 PSB 窗口重复播放同一段音频。THA 不属于一期 segment playback 的桌宠控制消费者。

#### Scenario: 收到 segment 语音后顺序播放
- **WHEN** Electron 客户端收到带音频 URL 的 assistant segment
- **THEN** 客户端 SHALL 将该 segment 标记为 ready
- **AND** 播放队列 SHALL 在前序 segment 完成后自动消费该音频

#### Scenario: PSB 窗口可用时由 PSB 播放
- **WHEN** PSB 桌宠窗口打开且当前 segment 属于 PSB playback
- **THEN** Electron SHALL 将音频 URL 和 segment identity 发送给 PSB 窗口
- **AND** PSB 窗口 SHALL 播放该音频并执行口型同步
- **AND** Electron 主聊天窗口 SHALL 不重复播放该音频

#### Scenario: PSB 不可用时回退普通播放
- **WHEN** PSB 桌宠窗口未打开或 PSB playback 未启用
- **THEN** Electron MAY 使用普通音频播放器播放该 segment 音频
- **AND** 播放队列 SHALL 仍按 `messageId` 和 `segmentIndex` 维护顺序和状态

#### Scenario: 相邻音频自动切换
- **WHEN** 当前 segment 音频播放结束且下一个 segment 音频已 ready
- **THEN** Electron 客户端 SHALL 结束当前 segment 生命周期
- **AND** Electron 客户端 SHALL 立即切换到下一个 segment
- **AND** 下一个 segment 的 segment-start SHALL 在其音频播放前触发

#### Scenario: 后续音频等待当前段
- **WHEN** 当前 segment 音频仍在播放或由 PSB 窗口播放且后续 segment 音频已 ready
- **THEN** Electron 客户端 SHALL 将后续音频保留在播放队列中
- **AND** Electron 客户端 SHALL 不并行播放后续音频

#### Scenario: 播放开始通知桌宠
- **WHEN** Electron 客户端开始播放某个 segment 音频
- **THEN** 客户端 SHALL 发送 segment-start 生命周期事件给相关桌宠窗口
- **AND** 事件 SHALL 包含该 segment 的控制元数据

#### Scenario: 播放结束通知桌宠
- **WHEN** Electron 客户端完成播放某个 segment 音频
- **THEN** 客户端 SHALL 发送 segment-end 生命周期事件给相关桌宠窗口
- **AND** 桌宠 SHALL 恢复该 segment 的临时口型和表情状态

#### Scenario: 播放失败降级
- **WHEN** segment 音频自动播放被拒绝或失败
- **THEN** 客户端 SHALL 至少呈现对应文本消息
- **AND** 客户端 SHALL 将该 segment audio 状态标记为 failed
- **AND** 播放队列 SHALL 结束该 segment 并继续后续 segment
