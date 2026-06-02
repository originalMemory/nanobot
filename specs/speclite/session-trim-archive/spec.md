# Spec: session-trim-archive

## Why
- `enforce_file_cap` 裁剪时，`last_consolidated` 内的消息直接丢弃，无任何持久化
- AutoCompact `compact_idle_session` 同理，`messages[0:last_consolidated]` 静默消失
- 一旦需要回溯（debug、审计、复盘长对话），数据不可恢复

## Scope
- 本次要做
  - `enforce_file_cap` / `compact_idle_session` 裁掉的**所有**消息写入 archive 文件，不区分是否已 consolidated
  - archive 文件按大小/条数自动 rotate，防止单文件膨胀
  - 原始 JSON 格式，保留 tool_use / tool_result 等完整结构
- 本次不做
  - 不改变现有 `raw_archive` → `history.jsonl` 逻辑（LLM 可读摘要仍照旧）
  - 不提供查询/搜索 API，仅做持久化备份
  - 不做自动清理/过期删除（后续需求另议）

## Plan
- [x] 在 `sessions/` 同级新建 `sessions/archive/` 目录
- [x] 新增 `SessionArchiver` 类：接收 `session_key` + `messages list[dict]`，追加写入 `sessions/archive/{safe_key}.jsonl`
- [x] 单文件超过阈值（默认 10MB 或 50000 行）时 rotate 为 `{safe_key}.1.jsonl`，新文件继续写
- [x] 每条 archive 记录带元数据：`{"_type": "trim_archive", "session_key": ..., "trimmed_at": ..., "reason": "file_cap"|"idle_compact", "messages": [...]}`
- [x] `enforce_file_cap`: 在 `dropped` 确定后，**所有** dropped 消息传给 `SessionArchiver`（在现有 `on_archive` 之前）
- [x] `compact_idle_session`: 归档 `session.messages[0:last_consolidated]`（当前被丢弃的部分）+ `archive_msgs`
- [x] 单元测试覆盖：rotate 触发、空消息跳过、reason 标记

## Apply Notes
- archive 写入用 append 模式，不需要原子写（丢几条可接受，不做 tmp+replace）
- rotate 只需 `os.rename` 向后推编号，类似 logrotate
- `sessions/archive/` 放在 workspace 下与 `sessions/` 平级，好处：生命周期跟 workspace 走，`.gitignore` 已忽略 `sessions/`
- 不修改 `Session` 数据类，`SessionArchiver` 是独立工具类
- `enforce_file_cap` 的 `on_archive` callback 保持不变（仍给 `raw_archive` 用），新逻辑是额外调用

## Verify
- [x] `enforce_file_cap` 裁剪后，archive 文件包含所有被裁消息（含 consolidated 部分），JSON 可解析
- [x] `compact_idle_session` 后，丢弃的 `[0:last_consolidated]` 区间消息出现在 archive 中
- [x] 单文件超 10MB 后自动 rotate，旧文件编号递增，新文件从空开始
- [x] archive 记录的 `reason` 字段正确区分 `file_cap` / `idle_compact`
- [x] 现有 `raw_archive` → `history.jsonl` 行为不受影响

## Status
- State: done
- Archived: yes
