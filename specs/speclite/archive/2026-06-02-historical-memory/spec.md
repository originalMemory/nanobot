# Spec: historical-memory

## Why
- nanobot 记忆只有「对话沉淀」一条路：对话 → `history.jsonl` → Dream → `SOUL/USER/MEMORY.md`
- 无法接入用户既有的历史记忆（数千个按天分的日记 md），openclaw 可配额外路径，nanobot 不行
- 现状只能 `MEMORY.md` 全文注入 + LLM 自觉 `grep`：数千文件无法全量注入、关键词召回差、无按日预热、无配置入口
- `restrictToWorkspace=true` 时外部目录还读不到（白名单只有 workspace + builtin skills）
- 日记是中文 + Obsidian frontmatter（`概要`/`心情`/`tags`/`天气`），默认 FTS5 分词对中文不可用（实测见 Apply Notes）

## Scope
- 本次要做
  - 新增 `historicalMemory` 配置块：声明外部日记库路径（不动原文件位置）
  - SQLite **FTS5** 索引器：扫描日记 md，解析 frontmatter，按 mtime 增量索引，提供全文检索 + 按日期取最近 N 天
  - 中文分词：默认**字级分词 + unicode61 + phrase 查询**（零依赖，2 字词可命中）；可选 `jieba` 词级、`simple` 扩展（见 Apply Notes 分词对比）
  - `memory_search` 工具：FTS5 检索，返回 `日期 + 概要 + 命中片段`
  - 文件工具只读白名单加入日记库路径（仅 `read_file`/`grep`，**不**给 `edit_file`/`write_file`）
  - 上下文按日预热：system prompt 注入最近 N 天日记（带硬字符上限）
  - 启动时构建/增量更新索引（后台，不阻塞启动）
- 本次不做
  - 向量 / embedding 语义检索（FTS5 验证后另起，列阶段 2）
  - 让 Dream 索引或改写外部日记（日记只读，与 Dream 完全隔离）
  - 文件监听热更新（启动时增量即可，运行中新增靠下次启动 / 手动重建）
  - 写日记能力（本次只读历史，不新增「写今日笔记」）

## Plan
- [x] `config/schema.py`：新增 `HistoricalMemoryConfig`（仿 `DreamConfig`），挂到 `AgentDefaults`，camelCase 别名 `historicalMemory`
  - 字段：`enabled=False`、`paths: list[str]=[]`、`glob="**/*.md"`、`datePattern=r"(\d{4}-\d{2}-\d{2})"`、`preloadRecentDays=2`、`searchTopK=5`、`indexPath: str|None=None`（默认 `workspace/memory/historical.db`）
  - `tokenizer: Literal["char","jieba","trigram","simple"]="char"`；`simpleExtensionPath: str|None=None`（tokenizer=simple 时加载的 `.dylib/.so`）
- [x] 新建 `agent/historical_memory.py`：`HistoricalMemoryIndex`
  - `sqlite3` + FTS5 虚表；表 `docs(path, date, mtime, summary, mood, tags)` + FTS5 `content`（外部内容表或独立列）
  - 分词层 `_segment(text, mode)`：`char`=CJK 拆单字+ASCII 词整块、空格连接；`jieba`=词级；`trigram`/`simple`=交给 FTS5 tokenizer；查询走对应 `_segment_query`（char/jieba 用 phrase 包裹保相邻）
  - frontmatter 解析：抽 `概要`/`心情`/`tags`，正文剥离 Obsidian 噪声（天气 API JSON 块、`![[图片]]` embed、callout 标记）再索引
  - `refresh()`：扫 `paths` 下 `glob`，按 mtime diff 增量 upsert，删除已消失文件
  - `search(query, top_k) -> list[hit]`（hit 含 path/date/summary/snippet）
  - `recent(days) -> list[note]`（按 date 倒序取最近 N 天，note 优先返回 `概要` 而非全文）
  - 从文件名/路径用 `datePattern` 提取日期；提不到则用 mtime 兜底
- [x] 新建 `agent/tools/memory_search.py`：`MemorySearchTool`
  - `create(ctx)` 从 `ctx.config` 读 `historicalMemory`，未启用则不注册
  - 共享一份索引实例（见 Apply Notes），调 `index.search`
  - `_scopes` 含 `core`（必要时 `subagent`）
- [x] `agent/tools/filesystem.py` `_FsTool.create`：把 `historicalMemory.paths` 追加进 `extra_read`（即使 restrict 开启也只读放行）；仅 `ReadFileTool`/`GrepTool` 生效，`EditFileTool`/`WriteFileTool` 不加
- [x] `agent/context.py` `build_system_prompt`：末尾加 `# Historical Journals (recent)` 区块，调 `index.recent(preloadRecentDays)`，**注入 `概要` 摘要而非全文**（富文本/天气块太占 context），`truncate_text` 限幅（仿 `# Recent History` 的 `_MAX_HISTORY_CHARS`）；未启用则跳过
- [x] `cli/commands.py`：启动时若 `enabled`，构建 `HistoricalMemoryIndex` 实例，后台 task 跑 `refresh()`，挂到 `ToolContext`（仿 dream 挂载处 ~1054-1067）
- [x] `tests/agent/test_historical_memory.py`：索引增量、日期提取、search/recent、白名单只读
- [x] `docs/memory.md`：新增「历史日记库」章节 + config 示例

## Apply Notes
- 索引实例单例共享：`memory_search` 工具与 `context.py` 预热需用**同一个** `HistoricalMemoryIndex`，避免各自重建。方案：`ToolContext` 加字段 `historical_memory_index`（仿 `file_state_store`），或按 `(paths, index_path)` 做模块级缓存。`ContextBuilder` 也需能拿到同一实例（构造时传入或同缓存键）
- FTS5 用 Python 内置 `sqlite3`，**不引新依赖**；建表前检查 FTS5 可用性，不可用则降级（仅 `read_file`/`grep`，跳过 `memory_search` 与索引）
- **中文分词实测（Python 3.12 / SQLite 3.50.4）**：
  - 默认 `unicode61`：整段中文当 1 个 token，2 字/3 字词均 0 命中，**不可用**
  - `trigram`（内置）：查询词 **<3 字符不命中**（"迁移""值守"等高频 2 字词失效），且索引偏大 → 不作默认
  - **字级分词 + `unicode61` + phrase 查询**：纯标准库 `re`，"迁移""值守""心情"等 2 字词均命中；phrase 引号保相邻避免拆字误命中 → **默认方案**
  - `jieba`（纯 Python，需 pip）：词级，相关性/排序更好；安装则可选启用
  - `simple` 扩展：词+拼音质量最佳，但需各平台编译分发 `.dylib/.so` + `sqlite3.enable_load_extension`（本机可用，但打包负担重）→ 仅高级 opt-in
  - `tokenizer` 配置缺省 `char`；选 `jieba`/`simple` 但环境不满足时**回退 `char` 并 warn**，不报错
- 白名单关键：`resolve_workspace_path` 会 `.resolve()` 真实路径（`filesystem.py:64-70`），外部路径必须显式进 `extra_allowed_dirs`，否则 `restrictToWorkspace=true` 时被拒
- 写保护：日记库路径**只**进读类工具白名单，确保 agent / Dream 物理上改不到日记
- 预热区块必须有硬上限（数千文件 / 长日记不能撑爆 context）；超限 `truncate_text` 截断
- 首次全量索引数千文件可能耗时：放后台 task，索引未就绪时 `memory_search` 返回「索引构建中」而非阻塞
- 日期提取以文件名优先（实测样例 `日记/2026/05/2026-05-30 周六.md`，文件名前缀 `YYYY-MM-DD`），失败回退目录路径，再失败用 mtime
- 索引清洗：天气 API JSON 块、`![[...]]` 图片 embed、表格骨架等噪声不进 FTS（避免污染相关性）；`概要` 是人工摘要，检索/预热价值最高，单独存列

## Verify
- [x] 配 `historicalMemory.enabled=true` + `paths` 后，`memory_search("关键词")` 命中对应日记，返回日期/概要/片段
- [x] 默认 `char` 分词下，2 字中文词（如"迁移""值守""心情"）能命中；英文/数字（如"nanobot"）也能命中（实测 3183 文件，鸣潮/绯雪/刘叶/暗色神具的魔王全部命中）
- [-] `tokenizer=jieba`/`simple` 但依赖/扩展缺失时回退 `char` 并 warn，不崩溃（配置字段预留，降级逻辑列阶段 2）
- [x] 最近 `preloadRecentDays` 天日记自动出现在 system prompt 的 `# Historical Journals` 区块，且不超字符上限
- [x] `restrictToWorkspace=true` 时 `read_file`/`grep` 能读日记库；`edit_file`/`write_file` 对日记库路径被拒（`_allow_historical_dirs` 类属性控制）
- [x] 修改一篇日记后重启，`refresh()` 仅更新该文件（mtime 增量），其余不重建
- [x] `enabled=false` 或 `paths=[]` 时：不注册 `memory_search`、不注入预热区块、不建索引，行为与现状一致
- [x] FTS5 不可用环境下优雅降级，不崩溃（`_check_fts5()` + `is_ready=True` 标记）
- [x] Dream 跑一轮后，外部日记内容/文件未被改写（日记库不在 Dream 工具的 `allowed_dir` 内，WriteFileTool 也排除）

## Status
- State: done
- Archived: yes
