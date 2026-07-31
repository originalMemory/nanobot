## ADDED Requirements

### Requirement: 历史游标保持有效且单调
系统 SHALL 只把非负整数视为有效历史游标，并 SHALL 使用持久计数器与历史尾部有效游标分配下一编号；尾部损坏时 SHALL 扫描历史恢复最大有效值。

#### Scenario: 计数器落后于历史
- **WHEN** `.cursor` 小于 `history.jsonl` 中最大的有效游标
- **THEN** 新历史记录 SHALL 使用历史最大游标加一且不得复用已有编号

#### Scenario: 历史已压缩而计数器领先
- **WHEN** `.cursor` 大于当前 `history.jsonl` 中最大的有效游标
- **THEN** 新历史记录 SHALL 使用计数器加一

#### Scenario: 非法历史游标
- **WHEN** 计数器或历史记录中的游标为负数、布尔值或非整数
- **THEN** 系统 SHALL 忽略非法值并继续使用其余有效状态

### Requirement: Dream 消费游标常规推进保持单调
系统 SHALL 将损坏或负数的 Dream 游标视为未设置，并 SHALL 阻止常规推进接口回退消费游标；显式 Dream restore 不受此限制。

#### Scenario: 读取损坏游标
- **WHEN** `.dream_cursor` 不是非负整数
- **THEN** 系统 SHALL 返回安全默认值 0

#### Scenario: 写入较旧游标
- **WHEN** 调用方尝试将 `.dream_cursor` 写成小于当前有效值的编号
- **THEN** 系统 SHALL 保留当前较大的编号

### Requirement: Dream 基于当前持久记忆运行
系统 SHALL 在 Dream 提示词中提供当前 `SOUL.md`、`USER.md` 和 `memory/MEMORY.md` 内容，并 SHALL 对单文件嵌入大小设置上限。

#### Scenario: 构建 Dream 提示词
- **WHEN** 存在未处理历史
- **THEN** 提示词 SHALL 同时包含当前三个持久记忆文件和本批历史

#### Scenario: 持久记忆文件缺失
- **WHEN** 任一持久记忆文件不存在或不可读
- **THEN** 提示词 SHALL 将其表示为空且继续构建

### Requirement: Dream 审计基于真实文件差异
系统 SHALL 只使用三个持久记忆文件相对 Git HEAD 的真实工作树差异生成 Dream 提交说明，并 MUST NOT 使用模型自述作为审计正文。

#### Scenario: 持久记忆发生变化
- **WHEN** Dream 修改了任一受控持久记忆文件
- **THEN** 提交说明 SHALL 包含实际文件路径、增删统计和受限长度的真实 diff

#### Scenario: 只有消费游标变化
- **WHEN** 仅 `.dream_cursor` 变化而三个持久记忆文件未变化
- **THEN** 系统 SHALL 视为无内容变更且不得据此创建 Dream 内容提交

#### Scenario: 模型描述与文件不一致
- **WHEN** 模型回复声称了真实 diff 中不存在的修改
- **THEN** Dream 提交说明 MUST NOT 包含该声称

### Requirement: Dream 完成语义在入口间一致
定时 Dream 与手动 `/dream` SHALL 使用相同的完成、消费游标和提交规则。

#### Scenario: 干净完成且有内容变化
- **WHEN** Dream 以 completed 结束且真实内容 diff 非空
- **THEN** 系统 SHALL 推进消费游标并提交真实差异

#### Scenario: 干净完成但无内容变化
- **WHEN** Dream 以 completed 结束且真实内容 diff 为空
- **THEN** 系统 SHALL 推进消费游标且不得创建空内容提交

#### Scenario: Dream 未完成
- **WHEN** Dream 异常或以非 completed 原因结束
- **THEN** 系统 SHALL 保持消费游标不变

#### Scenario: Dream 工具调用失败
- **WHEN** Dream 最终响应为 completed 但本轮存在工具错误
- **THEN** 系统 SHALL 将本轮视为未完成并保持消费游标不变

#### Scenario: Git 审计失败
- **WHEN** 系统无法生成持久记忆文件的真实 Git diff
- **THEN** 系统 SHALL 将 Dream 视为失败并保持消费游标不变

### Requirement: 损坏历史可跳过且可观察
系统 SHALL 跳过无法解析或结构无效的历史记录，并 SHALL 对同一 MemoryStore 实例中的同类游标损坏最多记录一次警告。

#### Scenario: JSONL 混有损坏行
- **WHEN** `history.jsonl` 同时包含有效记录与无法解析或无效游标记录
- **THEN** 系统 SHALL 返回有效记录并跳过损坏记录

#### Scenario: 重复读取同一损坏文件
- **WHEN** 同一 MemoryStore 多次读取包含无效游标的历史
- **THEN** 系统 SHALL 只记录一次该类游标损坏警告
