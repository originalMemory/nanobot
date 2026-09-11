## ADDED Requirements

### Requirement: Preserve dated events and actors
归档与 Dream SHALL 区分稳定事实和影响后续对话的事件，保留绝对事件日期、主体、已确认状态及必要后续。助手建议 MUST NOT 自动变为用户决定；归档时间 MUST NOT 替代事件时间。

#### Scenario: 即将发生的短期安排
- **WHEN** 用户确认数日内的安排及一个尚未解决的问题
- **THEN** 归档保留日期、安排和未结状态，不仅因有效期短于两周而跳过

#### Scenario: 助手提出建议
- **WHEN** 只有助手建议改变某安排，用户未确认
- **THEN** 记忆标明建议主体，不声称用户已决定或已完成

### Requirement: Corrections differ from temporal changes
Dream SHALL 更新错误当前事实，同时为有解释价值的真实变化保留日期与简短转折；临时状态 SHALL 不作为永久画像。过期计划不得自动判为已完成。

#### Scenario: 偏好先退出后有限恢复
- **WHEN** 新证据表明用户在退出某活动后又选择偶尔参与
- **THEN** 当前画像反映最新有证据的状态，历史退出原因仍可保留，不将两个时点简单判成矛盾

#### Scenario: 相对日期失效
- **WHEN** 旧文件含“本周再去两次”
- **THEN** 迁移依据原消息改为绝对计划日期与截至日期；没有后续证据不得声称完成

### Requirement: Natural continuity without invented facts
回复指导 SHALL 鼓励直接相关时自然连接真实经历，并在必要时使用现有日记/会话搜索。MUST NOT 因当前时间、情绪或旧偏好推断未知的通知时间、他人动机或用户永久心理特征。

#### Scenario: 预约改期但通知时间未知
- **WHEN** 用户在预约时间附近说已改期，没有提供通知发生时间
- **THEN** 回复不声称对方临时放鸽子，不把推断写入记忆

#### Scenario: 无关新话题
- **WHEN** 用户开启与既有事件无关的话题
- **THEN** 回复不为了展示记忆强行带入旧经历或例行追问

### Requirement: Reviewable private memory migration
迁移 SHALL 生成私人 before/after、证据和逐项 diff，应用前校验当前文件哈希，原子替换并读回。原日记、会话、history 和 Dream 游标 MUST 保持不变；原文 MUST NOT 写入源码仓库。

#### Scenario: 运行文件已出现新记录
- **WHEN** NAS 当前文件与下载快照不同
- **THEN** 系统重新读取并合并候选，不用旧快照覆盖新记忆

#### Scenario: 回滚前存在后续写入
- **WHEN** 迁移后已有新的 Dream 内容且需要回滚
- **THEN** 系统保留新写入并合并恢复本次差异，不直接覆盖为旧备份

### Requirement: End-to-end quality evidence
实施验收 SHALL 包含脱敏确定性回归和私人真实对话 A/B，分别评分召回与回复；至少二十个情景覆盖正负例。关键关系/事实编造不得通过，卡片命中数量不得代替质量。

#### Scenario: 无卡片命中仍正确延续
- **WHEN** 当前会话或既有工具支持准确自然的跨日回应
- **THEN** 回放保留为成功正例，不要求增加卡片调用

#### Scenario: 模型输出波动
- **WHEN** 样例依赖提词或摘要模型判断
- **THEN** 每个模型样例重复三次并记录结果；硬负例全部通过，私人对照至少十六个情景同时满足准确和自然，且零关键事实编造
