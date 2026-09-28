# Spec: active-memory-recall-dedup

## Why

- 主题卡已提供长期背景时，普通召回仍重复注入主题卡来源内的原文片段。
- Active Memory 只提供相关历史背景；精确日期、原话、数值由模型调用日记搜索工具完成。
- 当前实现先用 Ollama 提取关键词，再用 `rg` 找候选日记，最后把主题卡和最多 10 条普通片段一起注入当前轮次。
- 主题卡摘要和其来源片段重复时，增加上下文长度，却没有增加等量的新证据。

## Scope

- 主题卡命中时，按该卡的 `source_files` 过滤普通召回结果。
- 去掉已经被主题卡覆盖的普通片段；保留主题卡来源范围外的新记录。
- 保留主题卡、来源日期、主题卡过期提示和 `Active Memory` 引用边界。
- 保持无主题卡时的现有普通召回、相关性分组、时间分层和最多 10 条结果行为。
- Active Memory 只提供背景，不判断用户意图，不执行精确日记查询，不替代日记搜索工具。
- 不引入 SQLite、FTS、向量库、知识图谱、意图分类器或第二套记忆过滤规则。

## Current Flow

1. `ActiveMemoryHook.before_iteration()` 读取当前用户消息。
2. Ollama 模型从消息中提取最多 5 个搜索词；失败、超时、无词时放弃召回，不阻断主对话。
3. `_search_diary()` 用 `rg` 搜索日记正文，规范化冲突副本，按关键词命中数、概要命中数、频次和时间分层排序。
4. `_find_topic_card()` 根据主题、别名或已核验实体匹配主题卡。
5. `_format_injection()` 当前会同时写入主题卡摘要和普通召回片段。
6. 当前回复结束后，后台任务异步审核或更新候选主题卡；主题卡不写入普通会话历史。

## Target Behavior

### 主题卡命中

- 主题卡继续作为长期背景摘要注入。
- 普通结果按 `source_files` 做路径级去重。
- 日记文件属于主题卡来源范围时，其普通片段不再重复注入。
- 日记文件不属于主题卡来源范围时，继续保留，作为卡片之后的新证据或其他关键词的背景。
- 主题卡过期时仍显示过期提示；范围外的新片段仍然保留。
- 主题卡没有 `source_files`、来源解析失败或来源不完整时，不做危险的批量过滤，保留普通召回。

### 无主题卡

- 维持现有普通召回路径。
- 不改变关键词提取、`rg` 搜索、时间分层、候选多样化和最多 10 条结果限制。

### 精确查询边界

- “哪天”“具体金额”“原话”“数值”“完整清单”等精确问题仍由模型调用日记搜索工具处理。
- Active Memory 不新增意图分类，也不尝试从当前消息判断用户是否需要精确查询。
- 去重只减少重复背景，不承诺主题卡包含所有原文细节。

## Plan

- [ ] 在日记召回结果中保留主题卡来源文件集合和普通命中路径的可比较形式。
- [ ] 主题卡命中时过滤 `source_files` 范围内的普通片段。
- [ ] 来源缺失、路径无法规范化或卡片过期时保持安全降级：不批量过滤普通结果。
- [ ] 保持主题卡和普通片段的来源日期格式不变。
- [ ] 增加主题卡命中去重测试。
- [ ] 增加主题卡范围外新文件保留测试。
- [ ] 增加无主题卡路径行为不变测试。
- [ ] 增加来源不完整时不误删普通召回的测试。
- [ ] 运行 Active Memory 相关测试、Ruff 和 `git diff --check`。

## Apply Notes

- 去重边界使用卡片的 `source_files`，不使用日期字符串粗略比较；同一天可能存在多个文件或不同主题证据。
- 路径比较必须经过现有 `canonical_diary_files()` 规范化，继续排除 `.sync-conflict-*` 副本。
- 主题卡摘要、来源日期和 `_stale` 状态保持现有格式，避免破坏已有卡片和调用方。
- 过滤发生在 `_search_diary()` 结果形成后或等价的单一位置，避免普通搜索、主题发现和卡片构建分别实现不同规则。
- 不修改 `MemoryStore`、Dream、会话归档、`USER.md`、`SOUL.md` 或 `MEMORY.md`。
- 不修改用户下载的 `/Users/illusion/Downloads/memory` 数据；只修改仓库代码和测试。

## Risks

- 主题卡摘要可能遗漏某天的精确细节；因此只去重卡片来源范围内的片段，范围外的新证据仍保留。
- 主题卡来源列表可能滞后；`_stale` 提示和范围外片段必须继续保留，不能把卡片当作完整原文替代品。
- 多词主题、别名和实体可能解析成不同路径表示；必须复用现有路径规范化逻辑。
- 过滤规则错误会让模型失去可核对的原文，因此来源不完整时必须选择不过滤。

## Follow-up Roadmap

### 第一阶段：验证与低风险收紧

- 从真实日记查询中建立 30～50 条本地评估集；每条记录期望来源日期、主题卡状态和允许的背景范围。
- 统计 `Recall@10`、无关注入率、主题卡命中率、注入字符数、p50/p95 延迟和卡片过期率。
- 分别记录关键词提取、`rg` 搜索、主题卡排队、主题卡摘要和总耗时；`skip_error` 记录阶段和异常类型。
- 保持 Markdown 日记为唯一事实源，保留来源路径、fingerprint 和过期提示。
- 本阶段不改主题卡后台调度、全局锁或并发策略。

### 第二阶段：主题卡质量与上下文成本

- 新增来源只更新受影响的时间线和摘要段落，避免每次重建完整历史。
- 为每个来源保留 fingerprint、日期和变更记录，用于识别新增、修改和未变化的日记文件。
- 重要事实增加 `as_of`、状态和被替代关系，避免旧摘要覆盖新状态。
- 主题卡命中时继续采用“卡片摘要 + 卡片范围外新片段”的注入规则，不在 Active Memory 内增加意图分类。
- 为卡片摘要、卡片范围外新片段分别设置上下文预算；优先保留最新状态、关键转折和新证据。
- 预算策略不能替代模型的精确日记搜索；精确查询仍由日记工具完成。

### 后续检索评估

- 只有评估证明 `rg` 的字面检索不足时，才评估 FTS、向量或图检索。
- SQLite/FTS 只作为候选索引，不复制 Markdown 正文；引入前必须有召回率或延迟数据证明收益。
- 不引入意图分类器、向量库或知识图谱作为本次去重功能的前置依赖。

## Evidence

- Active Memory 执行日志：`/Users/illusion/Downloads/memory/active_memory.jsonl`
- 主题卡和来源：`/Users/illusion/Downloads/memory/active_memory_topics/`
- 日记库：`/Users/illusion/note/日记/`
- 召回实现：[`nanobot/agent/active_memory.py`](../../../nanobot/agent/active_memory.py)
- 共用日记搜索：[`nanobot/agent/diary_search.py`](../../../nanobot/agent/diary_search.py)
- 连续记忆测试：[`tests/agent/test_active_memory_continuity.py`](../../../tests/agent/test_active_memory_continuity.py)

## References

- Mem0 memory evaluation and audit-oriented memory updates: https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/memory-evaluation.mdx
- Mem0 entity extraction and matching: https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/how-it-works.mdx
- Letta core memory blocks and archival memory separation: https://github.com/letta-ai/skills/blob/main/letta/agent-development/references/memory-architecture.md
- Graphiti temporal facts, provenance and hybrid retrieval: https://github.com/getzep/graphiti
- LangMem semantic, episodic and procedural memory separation: https://github.com/langchain-ai/langmem/blob/main/docs/docs/concepts/conceptual_guide.md

## Verify

- [ ] 主题卡命中时，来源范围内的普通片段不再重复注入。
- [ ] 主题卡来源范围外的新日记片段仍能注入。
- [ ] 无主题卡时，现有排序、时间分层和最多 10 条结果保持不变。
- [ ] 来源不完整时不误删普通召回。
- [ ] 有效 `source_files`、嵌套相对路径和来源不完整场景都有测试证据。
- [ ] 越界绝对路径或非法来源字段不会触发过滤。
- [ ] Active Memory 相关测试通过，Ruff 和 `git diff --check` 通过。

## Status

- State: done
- Archived: yes
