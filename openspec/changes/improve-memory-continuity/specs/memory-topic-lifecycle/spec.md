## ADDED Requirements

### Requirement: Independent topic discovery
系统 SHALL 按至少五个独立日记日期将候选送审，不要求九十天跨度。未知词与旧主题的日记共现 MUST NOT 自动触发旧卡关系重建或阻止独立资格判断；每轮最多安排一个新卡任务。

#### Scenario: 独立游戏与菜品经常同日出现
- **WHEN** 查询新游戏且正式来源满足长期门槛，与某菜品只在日记中共现
- **THEN** 系统独立评估游戏资格，不要求先更新菜品卡

#### Scenario: 短期事件
- **WHEN** 新事件没有达到长期门槛
- **THEN** 系统仍允许原始日记召回，但不为达到建卡数量而放宽门槛

### Requirement: Exclusive entity inheritance
父卡召回 SHALL 仅接受规范主题、同义别名或有正文证据的专属实体。助手、用户、供应商及通用物品 MUST NOT 仅凭共现继承主题；平级关系不得自动递归召回。

#### Scenario: 助手与菜品
- **WHEN** 查询助手或商店名，旧菜品卡曾将其记录为从属实体
- **THEN** 未经新规则复核的该关系不可用于召回菜品卡

#### Scenario: 作品专属角色
- **WHEN** 查询角色且证据明确该角色属于某作品
- **THEN** 系统可返回作品卡、关系依据和相关日记

### Requirement: Evidence-driven card refresh
系统 SHALL 按规范来源及相关内容指纹刷新卡片，保持回复后后台生成、单飞和原子替换；无有效证据变化 SHALL 不调用摘要模型。

#### Scenario: 只修改天气区块
- **WHEN** 日记天气或文件 mtime 变化而主题相关正文不变
- **THEN** 系统不重建主题卡

#### Scenario: 去重后证据数量减少
- **WHEN** 完整读取正式来源后发现旧卡来源数因冲突副本清理而减少
- **THEN** 系统允许基于正式证据替换旧卡，不以数量减少直接拒绝更新

#### Scenario: 部分来源读取失败
- **WHEN** 本轮不能完成正式来源读取
- **THEN** 系统保留旧摘要、记录来源不完整，不将缺失内容当作用户历史被删除

### Requirement: Versioned decisions and bounded retry
资格判定 SHALL 绑定规则版本、证据指纹和实际提供的卡片索引指纹；无变化的明确拒绝不重复判断，实质证据或规则变化允许重评。服务/解析失败 SHALL 与语义拒绝区分，同一主题和证据的失败至少冷却一小时。

#### Scenario: 重复请求失败主题
- **WHEN** 同一证据的生成刚失败且一小时内再次查询
- **THEN** 系统正常返回原文或可用旧摘要，不立即再次调用生成模型

#### Scenario: 旧拒绝有新证据
- **WHEN** 候选的相关证据、已有卡片索引或资格规则版本实质变化
- **THEN** 系统允许下一次相关查询重新评估，不将旧拒绝永久视为真理

### Requirement: Safe schema transition
升级 SHALL 保留旧卡备份和可用摘要；旧版关系未经新规则复核前不得继承，未知字段不导致数据丢失。迁移 MUST NOT 触发全库无差别生成。

#### Scenario: 三张旧卡切换
- **WHEN** 工作区升级到新 schema
- **THEN** 系统保存旧内容、限制旧关系使用，并仅为被查询或明确纳入迁移的主题生成候选


### Requirement: Compact persistent card representation
系统 SHALL 在生成时校验实体引用的 path 和 quote，但持久化实体只保留名称、关系和来源定位。日期范围 SHALL 从 sources 派生，不持久化 date_range、source_count、rejected_relations、related_topics 或 migration_note。

#### Scenario: 校验后保存精简实体
- **WHEN** 实体关系引用已通过原文校验
- **THEN** 保存相对来源路径，不复制 quote；后续仍可按该已确认实体召回父卡

#### Scenario: 旧范围与实际来源冲突
- **WHEN** sources 包含无序日期且旧 date_range 与其不一致
- **THEN** 显示使用 sources 中合法日期的最小值与最大值，不使用旧范围字段


### Requirement: Indexed topic disposition
模型送审 SHALL 同时获得已有卡片的主题、别名、已确认实体名称和最多300字摘要，返回 alias、entity、new 或 no_save。证据不足与价值不足 SHALL 统一为 no_save，仅 reason 区分原因。超时或格式错误不得伪装为 no_save。

#### Scenario: 候选属于已有主题
- **WHEN** 候选证据支持其为索引中某主题的别名或专属实体
- **THEN** 系统校验原文并补充对应映射，不新建卡，不用候选窄证据覆盖父卡摘要

#### Scenario: 本次不保存
- **WHEN** 模型认为证据不足或没有可复用信息
- **THEN** 保存 action=no_save 与理由，判断依据改变后允许重新送审，不增加永久否决状态

#### Scenario: 判断期间索引变化
- **WHEN** 模型审核期间已有卡片索引发生变化
- **THEN** 旧判断不写入缓存或父卡，保留现有数据并等待基于新依据重试


### Requirement: Preserve confirmed mappings on refresh
重建 SHALL 将当前版本已确认的映射作为基线输入；模型漏返或空列表不得删除映射。撤销 SHALL 有明确声明、原因和可校验的新证据；声明仅用于本次生成，不持久化。旧版未确认映射不得直接继承为已确认。

#### Scenario: 模型只返回新摘要
- **WHEN** 原文没有撤销已确认别名和实体，而模型的新结果未重复列出它们
- **THEN** 已确认映射继续可用于召回，摘要正常更新

#### Scenario: 新证据明确纠正关系
- **WHEN** 模型声明撤销并给出可验证的纠正原文
- **THEN** 仅撤销对应映射，无有效证据的撤销被忽略

### Requirement: Upgrade a legacy target before linking
候选归属到旧版父卡时，系统 SHALL 用父主题完整来源升级卡片，再以新索引复核归属并补映射；升级失败 SHALL 保留旧卡，不缓存虚假的关联成功。

#### Scenario: 仅提及旧卡中的新实体
- **WHEN** 候选实体审核指向旧版父卡
- **THEN** 后台完成父卡完整升级和归属复核，无需用户先单独提起父主题名称
