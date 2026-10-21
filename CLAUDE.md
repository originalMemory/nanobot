@AGENTS.md

## Memory

- `nanobot/agent/active_memory.py`：Active Memory 日记召回和主题卡注入；主题卡命中后的普通片段去重逻辑在 `_search_diary()`。
- 主题卡改为「dirty 标记 + 懒触发批量」：命中/新建只写 `active_memory_topics/dirty/`，由 `_maybe_trigger_batch()`（dirty 非空且距上次批量 ≥ 24h，`maintenance.stamp` 记录）调度一次 `process_dirty_topics()` 单次批处理（`_build_topic_task` 内含 fingerprint 校验、no_save 缓存、retry cooldown 与 unchanged_evidence 检查）；不注册常驻定时器（`schedule_background` 的 shutdown gather 不 cancel 无限任务）。泛化词由 `GENERIC_TOPIC_TERMS` 送审前预筛（`prefiltered_generic`），`_validate_keywords` 过滤未知名单字词（known 名称含 related_entities）。
- 日志拆分：请求级流水写 `memory/active_memory.jsonl`，主题卡后台事件（prefiltered_generic / topic_card_dirty / 判定建卡结果 / topic_card_maintenance）写 `memory/topic_cards.jsonl`（`_topic_log_path`）。
- `tests/agent/test_active_memory_continuity.py`：连续记忆、主题卡来源去重和来源不完整场景的回归测试；`tests/agent/test_active_memory_topic_maintenance.py`：泛化词预筛、单字过滤、dirty 队列与批量幂等回归。
- `specs/speclite/active-memory-recall-dedup/spec.md`：Active Memory 去重需求与后续优化记录。
- `specs/speclite/active-memory-topic-maintenance/spec.md`：主题卡维护策略（预筛/dirty/批量）需求与验收。
- `specs/speclite/active-memory-log-split/spec.md`：日志文件拆分需求与验收。
