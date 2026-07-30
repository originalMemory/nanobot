## ADDED Requirements

### Requirement: Every Electron chat event shall carry explicit turn metadata
Gateway SHALL provide `turnId`、`turnPhase` and `turnSeq` for every user、Activity and assistant message delivered to Electron, and all events from one agent turn SHALL share the same `turnId`.

#### Scenario: Interactive multi-segment turn
- **WHEN** 一次用户请求产生 reasoning、工具调用、中途正文和最终正文
- **THEN** 所有记录共享同一 `turnId`，并通过 `turnPhase` 和递增 `turnSeq` 保持原始顺序

#### Scenario: Proactive delivery
- **WHEN** Cron、Heartbeat 或子 Agent 主动投递一轮消息
- **THEN** gateway 为该轮生成独立 `turnId`，且不会复用正在进行的交互轮次

### Requirement: Transcript replay shall normalize legacy turns
Transcript replay SHALL return complete turn metadata even when persisted legacy records do not contain turn fields; Electron MUST NOT infer legacy turn boundaries or use its previous aggregation fallback.

#### Scenario: Legacy interactive history
- **WHEN** replay 读取缺少 turn 字段、由用户消息开始的旧记录
- **THEN** replay 为该用户请求及其后续 Activity/assistant 消息生成稳定的 synthetic turn id

#### Scenario: Legacy proactive history
- **WHEN** replay 读取缺少用户消息的主动投递记录
- **THEN** replay 为该主动投递生成独立 synthetic turn id

### Requirement: Electron shall preserve assistant reply segments
Electron SHALL render every assistant正文消息 as an independent message and SHALL NOT concatenate adjacent assistant replies into one bubble.

#### Scenario: Text around a tool call
- **WHEN** assistant 在工具调用前后各发送一段正文
- **THEN** Electron 按正文、Activity、正文的顺序展示三个单位，不合并两段正文

#### Scenario: Concurrent or late turn
- **WHEN** 另一主动 turn 的消息在当前 turn 附近到达
- **THEN** Electron 根据 `turnId` 分别展示，不把它并入相邻 assistant 回复

### Requirement: Repeated assistant chrome shall be scoped to turn boundaries
Electron SHALL show assistant identity before the first visible agent unit in a turn and footer、usage、context、latency and turn actions on the last visible assistant reply in that turn.

#### Scenario: Multi-message assistant turn
- **WHEN** 同一 turn 包含多条 assistant 正文
- **THEN** 整轮只在首个 agent 单位前展示一次头像、名称和来源，只有最后一条正文展示 footer 和 usage/context

#### Scenario: Single-message assistant turn
- **WHEN** 一个 turn 只有一条 assistant 正文
- **THEN** 该消息前展示整轮身份 header，并在正文后展示 footer

#### Scenario: Activity precedes assistant text
- **WHEN** 一个 turn 先产生 reasoning 或工具 Activity，之后才产生正文
- **THEN** Electron 先展示该轮助手身份，再按备份分支的去重、折叠和自动收起规则展示 Activity 与文档式正文

### Requirement: Activity shall remain associated with its originating turn
Electron SHALL group reasoning、tool trace and file edit Activity only within the same `turnId`, while `activitySegmentId` SHALL delimit Activity runs inside that turn.

#### Scenario: Multiple activity runs
- **WHEN** 同一 turn 出现 reasoning、正文、再次工具调用和最终正文
- **THEN** 两个 Activity run 保持在对应正文之间，不被合并到 turn 外层气泡

#### Scenario: Streaming completion
- **WHEN** 收到某个 turn 的 `turn_end`
- **THEN** 只结束该 turn 的直播 Activity 和 footer 状态，不影响其他 turn

### Requirement: Electron-specific media and visual behavior shall survive turn migration
Turn-aware rendering SHALL preserve Electron dynamic wallpaper styles、TTS/audio playback、assistant identity/source、File Diff and bottom anchoring behavior.

#### Scenario: Audio across segmented replies
- **WHEN** 同一 turn 的多段回复分别包含音频播放片段
- **THEN** 片段仍按消息顺序自动播放，且不会因取消聚合而遗漏

#### Scenario: Activity collapse at bottom
- **WHEN** 流式 Activity 在消息列表底部结束
- **THEN** Activity 按备份分支延迟后自动折叠，最后一条 assistant 正文及其 footer 仍保持可见

#### Scenario: Wallpaper readability without assistant bubbles
- **WHEN** Electron 开启动态壁纸并展示文档式 assistant 正文
- **THEN** 整个对话视口使用无模糊的半透明背景，覆盖左右留白和底部输入区，正文不需要独立气泡也能保持可读
