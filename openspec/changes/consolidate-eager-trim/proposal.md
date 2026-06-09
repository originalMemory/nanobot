## Why

`maybe_consolidate_by_tokens` 完成后 `last_consolidated` 已推进，被压缩的前缀消息对 LLM 永远不可见，却继续占用 session 文件，直到 `enforce_file_cap` 超限才被物理删除。这造成 session 文件持续膨胀、`file_cap` 触发逻辑复杂，且两个需求（session-trim-archive、session-trim-consolidated-prefix）的实现都是为了弥补这一延迟裁剪的副作用。

## What Changes

- **回滚** `session-trim-archive`（SessionArchiver + `sessions/archive/*.jsonl`）的所有改动
- **回滚** `session-trim-consolidated-prefix`（`enforce_file_cap` 优先裁 consolidated prefix）的所有改动
- **新增**：consolidation 成功推进 `last_consolidated` 后，立即将已整合前缀物理删除（`session.messages = session.messages[end_idx:]`，`last_consolidated = 0`），同步写入 SQLite 存档
- **新增**：`compact_idle_session` 同步对齐，consolidated prefix 也在整合时立即删除
- **新增**：提供 `search_session_history` tool，支持关键词 + 会话 + 时间范围查询 SQLite 存档

## Capabilities

### New Capabilities

- `session-history-store`：consolidation 时即时裁剪并将消息写入 SQLite（`sessions/history.db`），每条消息一行，带 session_key / trimmed_at / reason / role / content_text / raw_json 字段
- `search-session-history`：Agent 可调用的 tool，在 SQLite 中检索历史会话消息，支持关键词、session_key 过滤、时间范围

### Modified Capabilities

（无，session-trim-archive 和 session-trim-consolidated-prefix 两个能力均整体回滚，不做 delta）

## Impact

- `nanobot/session/archiver.py`：删除 `SessionArchiver` 类及 `sessions/archive/` 目录逻辑
- `nanobot/agent/memory.py`：`Consolidator` 移除 `archiver` 参数和 `on_archive` 调用；`maybe_consolidate_by_tokens` / `compact_idle_session` 在推进 `last_consolidated` 后立即 trim + 写 SQLite
- `nanobot/session/manager.py`（或 `Session`）：`enforce_file_cap` 的 consolidated-prefix 优先裁逻辑回退到回滚前版本
- 新增 `nanobot/session/history_store.py`：SQLite 封装（建表、insert、search）
- 新增 `nanobot/agent/tools/search_history.py`：tool 实现
- 无新外部依赖（`sqlite3` 为 Python 内置）
