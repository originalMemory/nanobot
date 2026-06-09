## 1. 用 v0.2.1 tag 回滚两个 spec 的改动

> v0.2.1 不含 `archiver.py`，`enforce_file_cap` 无第一阶段前缀逻辑，`memory.py` 无 archiver 参数，是干净的上游基线。

- [x] 1.1 精确回滚 trim/archive 改动（非全量 checkout v0.2.1，避免误伤 fork 后续改动）：`enforce_file_cap` 移除 `on_trim` 与第一阶段前缀逻辑；`Consolidator`/`loop.py` 移除 `archiver` 相关代码
- [x] 1.2 删除 `nanobot/session/archiver.py`（v0.2.1 中不存在）
- [x] 1.3 删除 `tests/session/test_session_archiver.py`（v0.2.1 中不存在，后续新建 history_store 测试替代）
- [x] 1.4 确认还原结果：`enforce_file_cap` 只有 `on_archive` 参数，无第一阶段前缀块；`Consolidator` 无 `archiver` 字段

## 2. 新增 SessionHistoryStore（SQLite）

- [x] 2.1 新建 `nanobot/session/history_store.py`，实现 `SessionHistoryStore` 类：
  - `__init__(sessions_dir: Path)`：记录 `sessions/history.db` 路径；非 `Path` 类型（如测试 mock）直接禁用 store；lazy init，首次 `insert`/`search` 时才打开 DB
  - 首次连接时执行 `CREATE TABLE IF NOT EXISTS session_messages (...)`；创建 `idx_sk` / `idx_time` 索引；启用 WAL mode；`check_same_thread=False`
  - `insert_messages(session_key, messages, reason)`：提取每条消息的 `content_text`（text block 拼接，失败 fallback `raw_json[:500]`），批量 insert；捕获所有异常并 log warning
  - `search(query, *, session_key=None, since=None, until=None, limit=20) -> list[dict]`：构造 SQL WHERE clause，LIKE 搜索 `content_text`，返回 `{session_key, trimmed_at, role, content_text, snippet}` 列表；`snippet` 为关键词上下文 ±50 字符，`content_text` 截断至 300 字符
- [x] 2.2 在 `nanobot/session/__init__.py`（或其他合适位置）导出 `SessionHistoryStore`

## 3. 修改 Consolidator 实现即时裁剪

- [x] 3.1 在 `Consolidator.__init__` 中增加 `history_store: SessionHistoryStore | None = None` 参数并保存
- [x] 3.2 修改 `maybe_consolidate_by_tokens`：`archive()` 成功后调用 `_eager_trim_consolidated_prefix(session, end_idx)`（trim + SQLite insert + `last_consolidated = 0` + save），不再先推进 `last_consolidated` 再延迟 trim；保持现有 lock、round loop、summary persist 逻辑不变
- [x] 3.3 修改 `compact_idle_session`：在 `session.messages = kept` 之前，将 `consolidated_prefix + archive_msgs`（即所有被删除的消息）通过 `history_store.insert_messages(session_key, ..., "idle_compact")` 写入，统一在物理裁剪前完成归档
- [x] 3.4 修改 `nanobot/agent/loop.py`：初始化 `SessionHistoryStore(sessions_dir=sessions.sessions_dir)`，传给 `Consolidator(history_store=...)`

## 4. 新增 search_session_history tool

- [x] 4.1 新建 `nanobot/agent/tools/search_history.py`，实现 `SearchSessionHistoryTool`：
  - 继承 tool 基类，name = `search_session_history`
  - 参数：`query: str`（必填）、`session_key: str | None`、`since: str | None`、`until: str | None`、`limit: int = 20`（max 100）
  - 调用 `history_store.search(...)` 返回结果列表
  - 构造函数接收 `history_store: SessionHistoryStore`
- [x] 4.2 在 `loop.py` 的 tool registry 中注册 `SearchSessionHistoryTool(history_store=history_store)`

## 5. 测试

- [x] 5.1 新建 `tests/session/test_history_store.py`：覆盖建表、insert（文本提取正常 + fallback）、search（关键词、session_key 过滤、时间过滤、limit）、SQLite 写失败不抛出
- [x] 5.2 新建 `tests/session/test_eager_trim.py`（或在现有 memory/consolidator 测试中增加）：覆盖 consolidation 后 `session.messages` 长度缩减、`last_consolidated == 0`、`history_store.insert_messages` 被调用且参数正确
- [x] 5.3 运行 `pytest tests/session/ tests/agent/` 确认全部通过（session 53 passed；agent 1191 passed，16 failed 为既有问题如 timezone naive/aware、get_history 调用次数，与本次改动无关）

## 6. 收尾

- [x] 6.1 确认 `nanobot/session/archiver.py` 已删除，无残留引用（`rg SessionArchiver .` 结果为空）
- [x] 6.2 确认 `enforce_file_cap` 已无第一阶段 prefix 逻辑（`rg "last_consolidated > 0" nanobot/session/manager.py` 无匹配）
- [x] 6.3 更新 `docs/memory.md`：补充 `sessions/history.db` 与 `search_session_history` 说明（原文无 `sessions/archive/` 描述）
