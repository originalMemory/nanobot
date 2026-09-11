## Why

真实运行记录表明，长期画像、会话历史、日记和主题卡已经能延续聊天；主要缺口是无效提词、弱共现驱动的错误关联与重复建卡，以及长期画像和事件最新状态不同步。目标是让回复准确接上用户经历和变化原因，避免增加重复上下文或让助手凭记忆猜测。

## What Changes

- 保留四文件、Dream、原始会话和日记主题卡架构，不新增向量库、知识图谱或常驻近期摘要。
- 清理检索输入，校验小模型输出；用有限近期对话辅助省略指代，保留来源约束。
- 自动召回与手动日记搜索排除同步冲突副本；主题资格、摘要证据和结果使用一致的正式来源。
- 移除“未知词与旧主题同日共现即触发旧卡更新”的路径；独立主题正常接受资格评估。
- 修正关联实体契约：只有有证据的专属关系可以触发父主题召回；来源变化才刷新摘要，拒绝与失败有明确重试边界。
- 改进片段选取与历史阶段覆盖；补充能够区分有效召回、重复生成、失败和跳过原因的日志。
- 调整归档与 Dream 提示词，保留事件日期、主体、状态变化及用户明确表达的原因；当前事实纠正不抹除历史转折。
- 在私人工作区对现有四文件、三张卡和判定缓存进行可预览、可回滚迁移；保留人格与有价值的共同经历。
- 用脱敏回归样例与私人真实对话回放验收，不把“卡片命中数”当成“更懂用户”的替代指标。

## Capabilities

### New Capabilities

- `contextual-memory-recall`: 可信提词、正式日记来源、相关片段召回及效果观测。
- `memory-topic-lifecycle`: 独立建卡、专属实体、证据刷新、缓存重试与旧卡迁移。
- `personal-memory-continuity`: 长期画像与事件状态分工、Dream 时间语义、既有文件迁移和对话连续性验收。

### Modified Capabilities

无。现有 Active Memory 契约在 `specs/speclite/active-memory-topic-recall/spec.md`；本变更明确替代其中弱共现候选、永久拒绝及仅按来源数量防退化的策略，其余已验证行为继续保留。

## Impact

- 主要代码：`nanobot/agent/active_memory.py`、`nanobot/agent/tools/diary_search.py`；仅在传递原始消息或观测实际上下文确有必要时小范围修改现有 hook/context 接口。
- 提示词：Active Memory 提词/建卡、`nanobot/templates/agent/consolidator_archive.md`、`nanobot/templates/agent/dream.md`。
- 私人数据：运行工作区的 `AGENTS.md`、`SOUL.md`、`USER.md`、`memory/MEMORY.md`、`memory/active_memory_topics/`。下载快照仅是迁移参考，禁止直接覆盖 NAS 当前版本。
- 验证：扩展现有 memory/grep 测试，增加脱敏回放样例；不引入线上服务或新的依赖。
- 不改 Electron、根 WebUI、Dream 周期、会话压缩算法、主动消息调度，也不自动重训提词模型。
- 当前产物是待实施方案，不包含代码变更、真实记忆改写、部署或 Git 提交。
