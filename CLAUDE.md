@AGENTS.md

## Memory

- `nanobot/agent/active_memory.py`：Active Memory 日记召回和主题卡注入；主题卡命中后的普通片段去重逻辑在 `_search_diary()`。
- `tests/agent/test_active_memory_continuity.py`：连续记忆、主题卡来源去重和来源不完整场景的回归测试。
- `specs/speclite/active-memory-recall-dedup/spec.md`：Active Memory 去重需求与后续优化记录。
