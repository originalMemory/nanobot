# Spec: unified-history-search

## Why
- `search_chat` / `search_diary` 分工靠模型自行判断，漏调、只调一个的情况多
- 用户提及过去时本应同时补「原始对话」和「日记提炼」，两次 tool call 成本高、触发率低
- 合并为单工具可简化 description、提高主动检索概率；返回带来源标识即可区分数据

## Scope
- 本次要做
  - 新建 `memory_search` 工具，并行查 `SessionHistoryStore` + `HistoricalMemoryIndex`（日记未启用时只查对话）
  - 返回分「原始对话」「日记笔记」两段，靠段落标题区分来源
  - 合并参数：`query` + `session_key`（仅对话）+ `since`/`until`（对话 + 日记）+ 统一 `limit`
  - 统一 description：提及过去即主动调用，一次覆盖两类历史
  - `loop.py` 手动注册；删除 `search_chat.py`、`search_diary.py`
  - 更新 `docs/memory.md` 中工具名引用
- 本次不做
  - 改 AND/OR 关键词检索策略（仅加时间过滤参数）
  - 旧工具名 alias / 兼容层
  - webui / electron 改动
  - 用户工作区 `MEMORY.md`（NAS 上由用户/Dream 维护）

## Plan
- [x] 新建 `agent/tools/memory_search.py`：`MemorySearchTool`；`loop.py` 手动注册并传入 `history_store`
  - `_plugin_discoverable = False`
  - `execute`：`asyncio.gather` + `asyncio.to_thread` 并行检索对话与日记
  - 输出：`## 原始对话` / `## 日记笔记`
- [x] `HistoricalMemoryIndex.search` 增加 `since`/`until`（按 `date` YYYY-MM-DD 过滤，可只传其一）
- [x] 删除 `search_chat.py`、`search_diary.py`；移除 `loop.py` 对 `SearchChatTool` 的 import/注册
- [x] 更新 `docs/memory.md`：`search_diary` → `memory_search`，说明双来源返回格式
- [x] 新增 `tests/agent/test_memory_search.py`、`test_historical_memory.py::test_search_since_until_date_filter`

## Apply Notes
- 工具名：`memory_search`；类名 `MemorySearchTool`；`loop.py` 直接注入 `history_store`，**未**挂 `ToolContext`
- `limit` 默认 10；对话最大 100，日记最大 20（受 `search_top_k` 约束）
- 并行：`history_store.search` 与 `index.search` 各包一层 `asyncio.to_thread`，`asyncio.gather` 等待
- 时间过滤：
  - 对话段：`msg_timestamp`；`until` 纯日期补 `T23:59:59`
  - 日记段：`date` 列按天；`since`/`until` 取 ISO 前 10 位；可只传其一
  - `session_key` 仅过滤对话
- 返回靠段落标题 `## 原始对话` / `## 日记笔记` 区分来源，条目内不再重复标注
- diary 索引未启用/构建中/失败：对话照常，日记段简短状态，不整工具失败

## Verify
- [x] agent 工具列表仅有 `memory_search`，无 `search_chat`/`search_diary`
- [x] `historicalMemory` 关闭时，只返回「原始对话」段
- [x] `historicalMemory` 开启且索引就绪时，同一 query 返回「原始对话」+「日记笔记」，来源可区分
- [x] `session_key` 仅过滤对话；`since`/`until` 同时过滤对话与日记
- [x] 对话与日记检索并行发起（`test_chat_and_diary_search_run_in_parallel`）
- [x] `pytest tests/agent/test_memory_search.py tests/agent/test_historical_memory.py::test_search_since_until_date_filter` 通过

## Status
- State: done
- Archived: yes
