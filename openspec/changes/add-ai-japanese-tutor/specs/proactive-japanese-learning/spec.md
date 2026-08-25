## ADDED Requirements

### Requirement: 可选 Daily 课程入口
系统 SHALL 支持默认关闭的 Daily Cron，优先安排到期复习，否则预告下一课程节点。

#### Scenario: 存在到期卡
- **WHEN** Daily Cron 运行且存在到期项
- **THEN** 系统 SHALL 最多提交一道短复习题，并等待用户回复后才开始完整课程或记录 Anki review

#### Scenario: 不存在到期卡
- **WHEN** Daily Cron 运行时不存在到期项，并且已启用新课提醒
- **THEN** 系统 SHALL 只预告下一课程目标，不修改 mastery 或创建卡片

### Requirement: Weekly 学习报告
系统 SHALL 支持默认关闭的 Weekly Cron，汇总六轨进展、已完成节点、lapse 和下一重点。

#### Scenario: 生成周报
- **WHEN** Weekly Cron 执行
- **THEN** 系统 SHALL 报告已观察到的进展，不按自然周强制规定课程数量

### Requirement: 提醒控制
主动学习 SHALL 使用持久化的技能本地设置，并遵守 enabled、IANA 时区、quiet hours、已配置日程和每个本地自然日最多一次 Daily 学习提示。

#### Scenario: 命中 quiet hours
- **WHEN** 计划提醒落在 quiet hours
- **THEN** 系统 SHALL 不提交学习提示，也不为该次运行稍后补发

#### Scenario: 成功提交 Daily 提示
- **WHEN** Daily 学习提示成功提交到 outbound bus
- **THEN** 系统 SHALL 消耗该本地日期的 Daily 提醒配额，不要求 channel delivery receipt

#### Scenario: 提交前失败
- **WHEN** Daily 学习提示在提交 outbound bus 前失败
- **THEN** 该次运行 SHALL NOT 消耗本地日期的 Daily 提醒配额

#### Scenario: Weekly 报告不占 Daily 配额
- **WHEN** Weekly 报告提交
- **THEN** 其 SHALL NOT 消耗 Daily 学习提醒配额

### Requirement: Heartbeat 隔离
Heartbeat SHALL NOT 推进课程节点、记录 mastery evidence、修改 Anki 或启动正式课堂。

#### Scenario: 陪伴心跳使用日语
- **WHEN** 主动陪伴偶尔使用一句日语
- **THEN** 该内容 SHALL 保持为未跟踪对话，除非用户明确要求学习

### Requirement: 跨会话连续性
下一节课 SHALL 使用持久化的稀疏课程状态和当前 Anki 弱项，不得每次重新诊断。

#### Scenario: 学习者稍后返回
- **WHEN** 学习者在后续会话开始课程
- **THEN** planner SHALL 恢复当前节点、六轨 mastery、未解决错因和下一建议
