## ADDED Requirements

### Requirement: Evidence-bound query terms
系统 SHALL 清理附件和系统注入后提词；输出最多五个去重、有来源的检索词，排除路径、附件名、纯序号和无来源词，同时保留有明确实体依据的数值别名。

#### Scenario: 当前图片操作不检索历史
- **WHEN** 用户仅要求“收藏第 3 张，再来几张”，模型返回序号词
- **THEN** 系统过滤无效词，不扫描日记，也不调度主题生成

#### Scenario: 数值别名是明确主题
- **WHEN** 用户明确提到已知网盘别名 `115`
- **THEN** 系统允许其作为实体检索词，不因纯数字形式丢弃

### Requirement: Bounded conversational reference resolution
启用近期上下文辅助时，系统 SHALL 限制为最近三个用户轮次及对应非工具最终回复、最多 2000 字，排除工具/推理/旧参考注入；扩展词 SHALL 有明确指代证据。无法确认时 SHALL 保持未知。

#### Scenario: 明确的物品回指
- **WHEN** 近期只讨论一个订购物且当前说“那个终于到了”
- **THEN** 系统可从该窗口提取该物品名，日志标记来源为近期对话

#### Scenario: 歧义回指
- **WHEN** 窗口存在两个同等可能的物品且用户仅说“那个”
- **THEN** 系统不自行选择一个物品或继承全部旧话题

### Requirement: Canonical diary evidence
自动召回、手动日记搜索和卡片输入 SHALL 排除同步冲突副本并使用一致的正式文档身份；主题频次 SHALL 按独立日期计算，原文件 MUST 保持不变。

#### Scenario: 同一天多个同步版本
- **WHEN** 一篇正式日记伴随十个 `.sync-conflict-*` 副本
- **THEN** 该事件不占据十个召回位置，也不贡献十天的主题资格证据

### Requirement: Relevant excerpts and history coverage
系统 SHALL 优先返回与查询相关的正文并保留来源定位；有卡时 SHALL 继续保持关键词覆盖优先，再兼顾近期与历史代表，不以全体候选日期排序替代相关性。

#### Scenario: 正文被概要挤掉
- **WHEN** 全日概要主要讨论无关话题而正文包含用户所问事件
- **THEN** 片段优先保留该事件正文，天气数据、导航与无关概要不占据主要内容

#### Scenario: 空概要
- **WHEN** YAML 概要为空且下一行是心情字段
- **THEN** 系统识别概要为空，不把下一字段当摘要证据

### Requirement: Observable recall without transcript logging
日志 SHALL 带时间、规则版本、关联 ID、过滤原因、正式候选/去重数、卡片匹配方式和耗时；MUST NOT 为诊断额外记录整段私人上下文。卡片未命中 SHALL NOT 被直接判作回复失败。

#### Scenario: 依赖当前会话回答
- **WHEN** 自动提词为空但当前会话已有足够历史，主模型正确接续
- **THEN** 检索记录为跳过，回复评测仍判成功，不诱导无意义召回


### Requirement: Partial raw recall and post-filter limit
单个日记读取失败时，系统 SHALL 保留其余可读片段，同时标记来源不完整并禁止写卡。手动搜索 SHALL 在日期与有效正文过滤后计算返回数量，并继续补位。

#### Scenario: 一篇损坏、一篇正常
- **WHEN** 匹配文件包含一篇无法解码的日记和一篇正常日记
- **THEN** 返回正常日记片段，但不调度卡片重建

#### Scenario: 近期仅元数据命中
- **WHEN** 最近若干日记只在天气字段匹配，较早日记正文才匹配
- **THEN** 较早的有效正文仍能返回，不被提前截断排除
