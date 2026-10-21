# Spec: active-memory-log-split

## Why

- `active_memory.jsonl` 混写两类记录：请求级流水（injected/skip_*，带 text_preview/keywords/files）与主题卡后台事件（topic_card_*，带 source_count/fingerprint/reason），字段集不同、统计必须先按 action 前缀分流；旧版段缺 timestamp 更难归类。

## Scope

本次做：
- 主题卡后台事件（prefiltered_generic / topic_card_dirty / _build_topic_task 结果 / topic_card_maintenance）改写到独立文件 `memory/topic_cards.jsonl`。
- 请求级流水（injected/skip_*）保持 `memory/active_memory.jsonl`，行内容不变。
- 两个文件各自独立轮转（复用 `_rotate_log_if_needed`）。

本次不做：
- 历史日志迁移（旧 `active_memory.jsonl` 保留原样）。
- 日志行字段增删（topic_card 事件行已有内容不变）。

## Plan

- [ ] `ActiveMemoryHook.__init__` 增加 `_topic_log_path`（`workspace/memory/topic_cards.jsonl`）。
- [ ] 5 处主题卡事件 `_log` 调用改到 `_topic_log_path`（`_maybe_schedule_topic_card` ×2、`_build_topic_task` finally、每日维护 ×2）。
- [ ] 更新测试中的日志路径断言。
- [ ] ruff + active memory 全套测试 + basedpyright + `git diff --check`。

## Apply Notes

- 拆分只改写入路径，不改 `_log` 本身与行内容；`_log_path` 保持请求级流水，避免破坏既有解析。
- dirty 标记目录 `active_memory_topics/` 与日志文件 `topic_cards.jsonl` 名字不同目录层级，不冲突。

## Verify

- [ ] 请求级流水只出现在 `active_memory.jsonl`，主题卡事件只出现在 `topic_cards.jsonl`。
- [ ] 两文件各自轮转；既有测试断言按新路径更新后全绿。

## Status

- State: done
- Archived: yes
