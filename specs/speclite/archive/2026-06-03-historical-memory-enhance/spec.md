# Spec: historical-memory-enhance

## Why
- 索引只在启动时构建一次，久远日记写入后不会自动入库
- 当前 `paths` 只支持平铺路径列表，无法区分日记与普通笔记，非日记文档（手办记录、网页剪藏、工作文档）的 frontmatter 数据被丢弃，导致搜索缺失

## Scope
本次做：
- `HistoricalMemoryConfig` 改为单根 `root` + `diary_path` 子目录标记，删除旧 `paths` 列表
- FTS 表加 `doc_type` 列（UNINDEXED），`diary` 或 `note`
- diary 类型：文件名取日期，提取 `概要`/`心情`，body 入 FTS
- note 类型：frontmatter `created`/`date` 字段取日期（fallback mtime），**全量** frontmatter 值 + body 入 FTS
- `recent()` 加 `WHERE doc_type='diary'` 过滤
- `HistoricalMemoryConfig` 加 `refresh_interval_m: int`（默认 1440，即 24h）
- `commands.py` 启动后开一个独立 asyncio Task，sleep(interval) 后循环调 `refresh_async()`

本次不做：
- 旧 `paths` / 旧 DB 兼容
- 多根目录 / 多 source 配置
- `exclude` 排除列表
- jieba / trigram tokenizer 改动
- `diary_path` 支持 glob 通配

## Plan
- [x] `HistoricalMemoryConfig` 字段：删 `paths`，加 `root`、`diary_path`、`refresh_interval_m`
- [x] `HistoricalMemoryIndex.__init__` 读 `root`+`diary_path` 构建扫描逻辑
- [x] FTS schema 加 `doc_type` 列
- [x] `_index_file` 按 `doc_type` 分支：note 类型提取全量 frontmatter 值 + `created` 日期
- [x] `recent()` 加 `doc_type='diary'` 过滤
- [x] `commands.py` 加周期刷新 Task
- [x] 单元测试：note 类型 frontmatter 全量索引；`recent()` 不含 note 类型

## Apply Notes
- `doc_type` 判断逻辑：`file.is_relative_to(root / diary_path)` → `diary`，否则 `note`；`diary_path` 为空时全部为 `note`
- 全量 frontmatter 值提取：遍历 `_parse_frontmatter` 返回的 fields dict，过滤掉 wikilink 图片格式 `[[...]]` 的值，其余拼成空格分隔字符串并 `_segment_text`
- note 日期提取：优先 frontmatter `created` 或 `date` 字段（取前 10 字符 `YYYY-MM-DD`），fallback mtime
- `refresh_interval_m` 最小值 60，防止过于频繁

## Verify
- [x] 配置 `root: ~/note`，`diary_path: 日记` 后，`recent()` 只返回日记目录下的文件
- [x] 手办记录的 `figureSource` 值可被搜索命中（`search("紫罗兰永恒花园")`）
- [x] 启动后约 `refresh_interval_m` 分钟后日志出现第二次 "历史记忆索引完成"

## Status
- State: done
- Archived: yes
