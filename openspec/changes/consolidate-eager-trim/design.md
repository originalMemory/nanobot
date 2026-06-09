## Context

当前 session 生命周期分为两个独立阶段：
1. **Consolidation**（`maybe_consolidate_by_tokens` / `compact_idle_session`）：LLM 摘要写入 `history.jsonl`，推进 `last_consolidated`，但消息仍留在 session 文件。
2. **Trim**（`enforce_file_cap`）：消息数超过 `FILE_MAX_MESSAGES`（2000）后才物理删除。

为弥补这种延迟，`session-trim-archive` 新增了 `SessionArchiver` + `sessions/archive/*.jsonl`；`session-trim-consolidated-prefix` 在 `enforce_file_cap` 里加了"优先裁 consolidated prefix"的第一阶段逻辑。这两块改动均为后加，与上游 fork 存在冲突风险，因此整体回滚后以更简单的新设计替代。

**新设计核心原则**：consolidation 完成即 trim，"已整合 = 已删除 = 已归档"三件同步完成。

## Goals / Non-Goals

**Goals:**
- 回滚 `session-trim-archive` 和 `session-trim-consolidated-prefix` 的全部改动，恢复上游友好状态
- consolidation 推进 `last_consolidated` 后立即 `session.messages = session.messages[end_idx:]`，`last_consolidated = 0`
- 裁掉的原始消息同步写入 `sessions/history.db`（SQLite），每条消息一行
- 提供 `search_session_history` tool，支持关键词 + session + 时间过滤
- `compact_idle_session` 对齐同一逻辑

**Non-Goals:**
- 不改 `history.jsonl` 的 LLM 摘要逻辑（context injection 路径不变）
- 不提供 Web UI 或 REST API
- 不做 SQLite 数据过期自动清理（后续另议）
- 不迁移现有 `sessions/archive/*.jsonl` 文件

## Decisions

### 1. 为何不保留 JSONL archive，仅加 SQLite？

保留 `SessionArchiver`（JSONL）和新增 SQLite 会形成双写，职责重复。JSONL 的唯一价值是"原始备份"，而 SQLite 同样提供这个能力且可搜索。回滚后统一到 SQLite 更干净。

备选：JSONL + SQLite 双写 → 否决，冗余且增加维护负担。

### 2. SQLite Schema：消息粒度 vs 批量粒度

每条消息独立一行（细粒度），而不是每次 trim 一条记录（批量）。

原因：search tool 需要按关键词定位到具体消息；批量粒度只能找到"某次 trim"而无法定位单条消息。

Schema：
```sql
CREATE TABLE session_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT    NOT NULL,
    trimmed_at  TEXT    NOT NULL,  -- ISO8601 UTC
    reason      TEXT    NOT NULL,  -- 'consolidation' | 'idle_compact'
    role        TEXT    NOT NULL,  -- 'user' | 'assistant' | 'system' | 'tool'
    content_text TEXT,             -- 纯文本内容，用于全文搜索（可为空）
    raw_json    TEXT    NOT NULL   -- 完整消息 JSON
);
CREATE INDEX idx_sk   ON session_messages(session_key);
CREATE INDEX idx_time ON session_messages(trimmed_at);
```

`content_text` 提取规则（nanobot 混用 OpenAI / Anthropic 两种格式）：
- `content` 是 `str`：直接使用
- `content` 是 `list[block]`，遍历：
  - `{"type":"text","text":"..."}` → 拼接所有 text 值
  - `{"type":"tool_use","name":"...","input":{...}}` → `name + ": " + json.dumps(input)[:200]`
  - `{"type":"tool_result","content":"..."}` → 取 content 值（Anthropic 格式的工具结果放在 user 消息里）
- `role="tool"` 且 content 为 str（OpenAI 格式工具结果）：直接使用
- 以上均失败：fallback `raw_json[:500]`

### 3. 归档时机：consolidation 完成后同步写入，还是异步？

同步写入，在物理 trim 的同一临界区内完成 SQLite insert，随后 `last_consolidated = 0` 并 `save`。

实现顺序：`archive()` → `_eager_trim_consolidated_prefix()`（trim + insert + save）。不再先推进 `last_consolidated` 再延迟 trim。

原因：若异步写入，crash 窗口可能导致消息已从 session 删除但未写 SQLite。同步写入即使 SQLite 失败也只 log warning，不阻塞对话——数据可接受有少量丢失。

`SessionHistoryStore` 采用 lazy init：仅在首次 `insert` / `search` 时打开 `history.db`，避免测试 mock `sessions_dir` 时在仓库根目录误建 SQLite 文件；非 `Path` 类型的 `sessions_dir` 直接禁用 store。

### 4. `enforce_file_cap` 的回滚范围

回滚"第一阶段优先裁 consolidated prefix"逻辑与 `on_trim` 回调。`enforce_file_cap` 在正常路径下极少触发（consolidation 已即时删除前缀），仅作为超长 unconsolidated tail 的最后兜底。

保留 `on_archive`（upstream 已有）：file_cap 仍可将未整合前缀 raw-dump 到 `history.jsonl`，但不写入 SQLite，`search_session_history` 无法检索这部分消息。

### 5. search_session_history tool 的查询接口

```
search_session_history(
    query: str,           # 关键词（LIKE 搜索 content_text）
    session_key: str | None,  # 指定会话（可选）
    since: str | None,    # ISO 日期，起始时间（可选）
    until: str | None,    # ISO 日期，结束时间（可选）
    limit: int = 20,      # 最多返回条数
) -> list[dict]
```

返回结构：`[{session_key, trimmed_at, role, content_text, snippet}, ...]`，`snippet` 为关键词高亮上下文（±50 字符）。

## Risks / Trade-offs

- **已有 archive 数据丢失入口**：回滚后 `sessions/archive/*.jsonl` 不再新增数据，历史文件保留但不迁移。→ 可接受，这些文件本来就没有搜索工具，价值有限。
- **SQLite 并发写**：多 channel 并发触发 consolidation 时同时写 SQLite。→ 用 `check_same_thread=False` + WAL mode，SQLite 内置行级锁足够处理此场景。
- **content_text 提取不完整**：tool_use / tool_result 结构复杂。→ 提取失败时 fallback 为 `raw_json[:500]`，不影响写入。
- **session.messages 物理缩短后，`retain_recent_legal_suffix` 的 `already_consolidated` 计算需核查**：eager trim 后 `last_consolidated` 永远为 0，`retain_recent_legal_suffix` 里的相关分支应当直接跳过。

## Migration Plan

1. 回滚 `session-trim-archive` 改动：删除 `nanobot/session/archiver.py`，移除 `Consolidator.archiver`，移除 `loop.py` 中的 `SessionArchiver` 初始化和传参
2. 回滚 `session-trim-consolidated-prefix` 改动：恢复 `Session.enforce_file_cap` 至原始版本（移除第一阶段与 `on_trim`）；保留 `on_archive`
3. 新增 `nanobot/session/history_store.py`（`SessionHistoryStore`）
4. 修改 `Consolidator`：`maybe_consolidate_by_tokens` 和 `compact_idle_session` 在推进 `last_consolidated` 后即时 trim + 调用 `history_store.insert_messages()`
5. 新增 `nanobot/agent/tools/search_history.py`，注册到 tool registry
6. 补充测试：eager trim 后 session 长度缩短、SQLite 有对应记录、search tool 返回正确结果

**Rollback**：若新方案有问题，删除 `history_store.py` + `search_history.py`，恢复 `memory.py` 中的 trim 时机即可。SQLite 文件留存不影响功能。

## Resolved Questions

- `enforce_file_cap` 的 `on_archive` 在上游原版中存在，已保留；`on_trim` 为后加改动，已移除。
