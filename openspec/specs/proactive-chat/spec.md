## ADDED Requirements

### Requirement: 主动陪伴触发条件

系统 SHALL 提供一个独立于 heartbeat 的周期性触发服务，仅在满足全部条件时发起一次主动陪伴事件：功能已启用、当前不在静默时段、且最后一条 user 消息来源的 Electron 连接当前处于失焦状态。

#### Scenario: 目标端失焦时触发

- **WHEN** 触发服务到达一个 tick，功能已启用且不在静默时段，最后一条 user 消息来源的 Electron 连接当前 `focused=false`
- **THEN** 系统 SHALL 针对该连接的 `chat_id` 发起一次主动陪伴事件

#### Scenario: 目标端处于前台时跳过

- **WHEN** 触发服务到达一个 tick，最后一条 user 消息来源的 Electron 连接 `focused=true`
- **THEN** 系统 SHALL 跳过本次 tick，不发起主动事件

#### Scenario: 无可定位的目标连接时跳过

- **WHEN** 没有最后 user 消息来源、或该来源对应的 Electron 连接已断开
- **THEN** 系统 SHALL 跳过本次 tick

#### Scenario: 功能未启用时不触发

- **WHEN** `proactive_chat.enabled` 为 false
- **THEN** 触发服务 SHALL 不发起任何主动事件

#### Scenario: 静默时段内不触发

- **WHEN** 当前时间落在配置的静默时段内
- **THEN** 系统 SHALL 跳过本次 tick

### Requirement: 主动陪伴编排

系统 SHALL 通过一个编排 skill 指挥 LLM 完成：获取目标端截图、结合近期对话生成一句简短的主动文案、合成对应语音、并将文案与语音发送给目标 `chat_id`。

#### Scenario: 完整编排成功

- **WHEN** 主动陪伴事件被触发
- **THEN** 系统 SHALL 依次请求截图、读取近期对话、生成主动文案、合成语音，并把文案与语音发送给目标 Electron 连接

#### Scenario: 截图不可用时降级

- **WHEN** 截图请求超时或失败
- **THEN** 系统 SHALL 仅基于近期对话生成文案与语音，而不中断整个流程

### Requirement: 隐私默认安全

系统 SHALL 默认关闭主动陪伴功能，且仅向触发该事件的目标失焦连接采集截图。

#### Scenario: 默认关闭

- **WHEN** 用户未显式开启 `proactive_chat.enabled`
- **THEN** 系统 SHALL 不进行任何截图采集或主动语音

### Requirement: 主动陪伴配置

系统 SHALL 暴露主动陪伴相关配置：启用开关、触发间隔、静默时段。TTS provider 配置独立于主动陪伴，挂载在 `tools.tts` 下（与 `imageGeneration` 对称），`default_voice` 亦在此配置。

#### Scenario: 读取配置

- **WHEN** 触发服务启动
- **THEN** 系统 SHALL 从配置读取 `proactiveChat.enabled`、`proactiveChat.interval_s`、`proactiveChat.quiet_hours` 并据此运行；TTS 能力由 `tools.tts.enabled=true` 独立控制
