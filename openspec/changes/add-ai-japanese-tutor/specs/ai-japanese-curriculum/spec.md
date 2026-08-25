## ADDED Requirements

### Requirement: 结构化 N1 课程
系统 SHALL 提供机器可读课程，覆盖新标日初级 48 课、中级 32 课、高级 24 课，并包含 Foundation→N1 前置关系与桥接节点。

#### Scenario: 课程校验通过
- **WHEN** 执行课程校验命令
- **THEN** 系统 SHALL 找到恰好 104 个教材课号，所有前置引用可解析，并且每个节点都有来源与验证状态

#### Scenario: 候选节点被排除
- **WHEN** 课程节点的验证状态为 `candidate`
- **THEN** planner SHALL 将其排除在正式教学与制卡之外

### Requirement: 六轨独立掌握度
系统 SHALL 分别跟踪词汇/汉字、语法、阅读、听力、会话输出和考试策略。

#### Scenario: 能力发展不均衡
- **WHEN** 诊断证据显示阅读为 N3、听力为 N5
- **THEN** 状态 SHALL 分别保留两个等级，不得折叠为单一综合等级

### Requirement: 按前置关系规划课程
planner SHALL 根据前置关系、Anki 弱项、教材课序、题型覆盖缺口和学习状态选择下一个可教节点。

#### Scenario: 缺少前置知识
- **WHEN** 下一教材节点依赖尚未掌握的前置知识
- **THEN** planner SHALL 安排桥接节点，并在前置知识满足后返回原节点

### Requirement: 有界课程时长
planner SHALL 支持默认 15～20 分钟标准课、约 5 分钟微型复习和约 30 分钟深度课。

#### Scenario: 生成标准课计划
- **WHEN** 用户请求标准课
- **THEN** 计划 SHALL 包含 0～5 个实际到期复习项、有到期项时通常取 3～5 个、一个主要新目标、一次迁移检查和最多 3 个卡片候选

#### Scenario: 到期项不足三个
- **WHEN** 实际到期复习项少于 3 个
- **THEN** planner SHALL 只使用现有到期项，不得用未到期卡凑数

#### Scenario: 生成深度课计划
- **WHEN** 用户明确请求深度课
- **THEN** 计划 MAY 增加阅读或听力练习，但仍 SHALL 最多引入一个主要新目标

### Requirement: 掌握状态需要迁移证据
系统 SHALL 使用 `new`、`learning`、`reviewing`、`mastered` 状态，并要求跨会话的新语境证据后才能标记为 mastered。

#### Scenario: 单次答对
- **WHEN** 学习者只在原练习语境中答对一次
- **THEN** 节点 SHALL NOT 直接进入 `mastered`

#### Scenario: 跨会话迁移成功
- **WHEN** 学习者在至少两个会话的新语境中独立完成识别与主动输出
- **THEN** 节点 MAY 进入 `mastered`

### Requirement: 可度量的材料生成
AI SHALL 围绕选定节点生成例句、短对话、分级阅读和听力文本，并默认保持可度量的已知词汇单位覆盖率不低于 90%。

#### Scenario: 生成课程材料
- **WHEN** AI 为节点生成材料
- **THEN** 系统 SHALL 记录节点 ID、生成器版本、主要新目标、Sudachi 归一后的词汇单位、覆盖率计算、豁免项和语言事实来源

#### Scenario: 覆盖率低于阈值
- **WHEN** 排除标点、纯数字和已声明专名后的归一词汇单位覆盖率低于 90%
- **THEN** 生成器 SHALL 简化或重新生成材料，不得静默接受

### Requirement: 可选句子 TTS
Anki 词汇复习 SHALL NOT 依赖 nanobot TTS；只有用户确认需要带音频的 AI 句子卡时，系统才 MAY 生成可复用 TTS 文件。

#### Scenario: 用户确认需要句子音频
- **WHEN** 用户确认把 AI 生成句子制作成带音频的听力卡，并且 TTS 成功
- **THEN** 结果 SHALL 包含本地路径、MIME、内容 hash、配置音色和生成器元数据

#### Scenario: TTS 失败
- **WHEN** 句子音频合成失败
- **THEN** 系统 MAY 创建不带音频的 Reading/Speaking Card，但 SHALL NOT 创建或声称存在 Listening Card

### Requirement: 来源治理
系统 SHALL 维护来源注册表，包含版本、许可证、可信等级、允许用途和署名要求。

#### Scenario: 许可证不明确
- **WHEN** 来源没有明确许可证或再分发授权
- **THEN** 其内容 SHALL NOT 进入技能 bundle、仓库、镜像或测试 fixture

### Requirement: 模块化技能 bundle
日语老师 SHALL 保留 `japanese-tutor` 技能名，使用仓库跟踪的 canonical bundle，并按需加载课程数据与详细参考，不得把全部内容写入 `SKILL.md`。

#### Scenario: 简单查词
- **WHEN** 用户只询问一个词
- **THEN** 技能 SHALL 直接回答，不加载完整课程，也不启动正式课堂

#### Scenario: 构建或部署 bundle
- **WHEN** 测试日语技能或复制到 NAS workspace
- **THEN** 源文件 SHALL 来自 `deploy/skills/japanese-tutor`，不得依赖一次性的 Downloads 快照
