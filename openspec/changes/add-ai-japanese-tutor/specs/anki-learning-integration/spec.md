## ADDED Requirements

### Requirement: MBP 原生 Anki Desktop
系统 SHALL 使用 MBP 原生安装的 Anki Desktop；AnkiConnect SHALL 通过局域网端口和 API key 供 NAS nanobot 访问。

#### Scenario: MBP 上的 Anki 运行
- **WHEN** MBP 已唤醒且 Anki Desktop 正在运行
- **THEN** Anki collection、Note Type、媒体和配置 SHALL 保持可用

#### Scenario: AnkiConnect 局域网访问
- **WHEN** NAS nanobot 使用已配置的 MBP 局域网地址与 API key 调用 AnkiConnect
- **THEN** Anki 服务 SHALL 接受该调用并拒绝无效 API key

#### Scenario: GUI 与同步可用
- **WHEN** MBP 上的 Anki Desktop 运行
- **THEN** Anki GUI 和局域网 AnkiConnect SHALL 可访问，并保留 AnkiWeb 同步所需的出站网络

### Requirement: 用户手工导入个人牌组
系统 SHALL 要求用户手工把三个指定的新标日词汇牌组导入私人 Anki collection，并直接使用这些牌组，不做迁移。

#### Scenario: 尚未导入牌组
- **WHEN** 三个个人牌组不存在
- **THEN** 课程 SHALL 继续使用开放来源，系统 SHALL NOT 自动下载或提取牌组

#### Scenario: 已导入牌组
- **WHEN** 三个个人牌组存在
- **THEN** adapter SHALL 读取其词汇、课/单元标签、原单词音频、到期卡和复习历史，不修改原 Note Type、字段、模板、Card 或媒体

#### Scenario: planner 请求当前课词汇
- **WHEN** planner 按教材等级、课号或单元请求新课词汇
- **THEN** adapter SHALL 从三个导入牌组返回匹配词汇字段、标签、Card/Note ID 和音频引用，并保持牌组不变

### Requirement: 只读牌组发现
adapter SHALL 提供只读 discovery，报告匹配牌组、字段、标签、Note 数、媒体引用和异常。

#### Scenario: 执行 discovery
- **WHEN** 运行 discovery
- **THEN** 系统 SHALL NOT 修改 Note Type、Card、标签、排程状态或媒体文件

### Requirement: 查询并提交 Anki 复习
adapter SHALL 暴露到期卡、卡片元数据、lapse/review history，以及 scheduler-backed answer 操作；AI SHALL 根据答题与提示证据自动判定 Again、Hard、Good，Easy 只由用户明确指定。

#### Scenario: 请求到期卡
- **WHEN** planner 或 Daily Cron 请求到期复习数据
- **THEN** adapter SHALL 返回 Card/Note ID、deck、Card Type、due/lapse 元数据和可用课程节点映射，并保持 Anki 不变

#### Scenario: 答错或放弃
- **WHEN** 用户答错、明确放弃，或在答案揭示后才复述正确答案
- **THEN** AI SHALL 提交 `Again`

#### Scenario: 使用提示后答对
- **WHEN** 用户请求或使用提示后答对，或在答案揭示前经过多次尝试自行纠正
- **THEN** AI SHALL 提交 `Hard`

#### Scenario: 无提示直接答对
- **WHEN** 用户无需提示直接给出符合当前考点的正确答案
- **THEN** AI SHALL 提交 `Good`

#### Scenario: 用户明确选择 Easy
- **WHEN** 用户明确表示该卡太简单或要求记录 `Easy`
- **THEN** AI SHALL 提交 `Easy`

#### Scenario: 异步响应时间
- **WHEN** AI 只能观察到消息间隔，无法确认用户实际思考时长
- **THEN** AI SHALL NOT 仅凭响应时间把评分改为 `Hard` 或 `Easy`

#### Scenario: 自动评分提交
- **WHEN** AI 根据上述规则得到评分，且本节课未启用只练习或手动评分模式
- **THEN** adapter SHALL 通过 Anki scheduler 提交评分并返回结果，不得直接写 due、interval、rating 或 revlog

#### Scenario: 只练习或手动评分模式
- **WHEN** 用户在本节课选择只练习不记 Anki，或选择手动评分但尚未给出评分
- **THEN** Anki Card SHALL 保持不变，系统 SHALL 明确说明本次没有记入 Anki review

### Requirement: 原词汇牌组保持不变
系统 SHALL 把三个导入牌组作为词汇、课程标签、原单词音频和 FSRS 状态的权威来源，不得迁移或改写。

#### Scenario: AI 需要主动表达练习
- **WHEN** AI 需要把已有词汇反向用于中文→日文练习
- **THEN** AI MAY 在课堂中临时反向提问，但 SHALL NOT 创建或声称存在新的 Anki 反向词汇 Card

### Requirement: AI 句子卡模型
集成 SHALL 提供 `Japanese Immersion` Note Type，包含可追溯来源的 Reading/Speaking Card，并在存在有效音频时支持 Listening Card。

#### Scenario: 创建纯文本句子卡
- **WHEN** 用户确认添加不带音频的句子候选
- **THEN** Anki SHALL 创建 Reading/Speaking Card，不创建 Listening Card

#### Scenario: 创建带音频句子卡
- **WHEN** 用户确认添加句子候选且媒体写入成功
- **THEN** Anki SHALL 创建 Listening Card，并让各 Card Type 独立维护 FSRS 状态

### Requirement: AI 介导的句子制卡
AI SHALL 预览最多 3 个带稳定 Candidate ID 的句子卡候选，并在 Anki mutation 前取得明确确认。

#### Scenario: 句子制卡成功
- **WHEN** 已确认 Note 和媒体全部写入成功
- **THEN** adapter SHALL 调用 Anki sync，并返回 Note ID 与同步结果

#### Scenario: 跨容器写入音频
- **WHEN** nanobot workspace 中存在已确认句子的临时音频
- **THEN** adapter SHALL 读取 bytes 并通过 AnkiConnect `storeMediaFile(data=base64)` 上传，不得把 nanobot 本地 path 交给 Anki 容器

#### Scenario: 媒体写入失败
- **WHEN** 媒体存储或 Note 创建失败
- **THEN** adapter SHALL NOT 报告成功或调用 sync，候选 SHALL 保持可重试

#### Scenario: 部分写入后重试
- **WHEN** 同一 Candidate ID 与内容 hash 的媒体或 Note 已存在
- **THEN** adapter SHALL 对账既有产物，不得创建重复 Note 或冲突媒体文件

#### Scenario: 本地写入后同步失败
- **WHEN** 所有已确认本地写入成功但 Anki sync 失败
- **THEN** adapter SHALL 返回 `written_unsynced` 和已创建 Note ID，并允许只重试 sync，不得重放 Note 或媒体创建

### Requirement: 复习状态归 Anki 所有
Anki SHALL 是词汇 due、rating、interval 和 review history 的唯一权威来源；课程 mastery 另存为教学证据。

#### Scenario: 记录课程证据
- **WHEN** AI 记录 curriculum mastery evidence
- **THEN** 系统 SHALL NOT 直接编辑 Anki Card 的 rating、due 或 interval

### Requirement: 版权内容隔离
仓库和运行镜像 SHALL NOT 包含提取的新标日数据、教材音频、解密 key 或导出的私人 collection。

#### Scenario: 扫描交付物
- **WHEN** 扫描仓库、镜像、fixture 和日志
- **THEN** SHALL 不存在版权牌组 payload 或私人 collection 内容
