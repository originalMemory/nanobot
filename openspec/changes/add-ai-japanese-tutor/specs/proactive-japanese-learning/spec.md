## ADDED Requirements

### Requirement: 可选 Daily 课程入口
系统 SHALL 提供供 nanobot 现有 Cron 调用的 Daily 内容，优先安排到期复习，否则预告下一课程节点。

#### Scenario: 存在到期卡
- **WHEN** Daily Cron 运行且存在到期项
- **THEN** 系统 SHALL 最多提交一道短复习题，并等待用户回复后才开始完整课程或记录 Anki review

#### Scenario: 不存在到期卡
- **WHEN** Daily Cron 运行时不存在到期项
- **THEN** 系统 SHALL 只预告下一课程目标，不修改 mastery 或创建卡片

### Requirement: Weekly 学习报告
系统 SHALL 提供供 nanobot 现有 Cron 调用的 Weekly 内容，汇总六轨进展、已完成节点、lapse 和下一重点。

#### Scenario: 生成周报
- **WHEN** Weekly Cron 执行
- **THEN** 系统 SHALL 报告已观察到的进展，不按自然周强制规定课程数量

### Requirement: 复用现有 Cron
主动学习 SHALL 由 nanobot 现有 Cron 创建、保存和触发；技能 SHALL NOT 实现独立调度设置、quiet hours 或每日配额。

#### Scenario: 创建主动学习任务
- **WHEN** 用户确认创建 Daily 或 Weekly 任务
- **THEN** 系统 SHALL 使用 nanobot Cron 并在创建时指定时间和时区，技能只提供执行内容

### Requirement: 跨会话连续性
下一节课 SHALL 使用持久化的稀疏课程状态和当前 Anki 弱项，不得每次重新诊断。

#### Scenario: 学习者稍后返回
- **WHEN** 学习者在后续会话开始课程
- **THEN** planner SHALL 恢复当前节点、六轨 mastery、未解决错因和下一建议
