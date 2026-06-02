"""历史记忆索引：扫描外部日记 md，建 SQLite FTS5 全文索引，提供检索与按日预热。"""

from __future__ import annotations

import asyncio
import re
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

if TYPE_CHECKING:
    from nanobot.config.schema import HistoricalMemoryConfig


# ---------------------------------------------------------------------------
# 模块级实例注册表（按 workspace 路径 key）
# ---------------------------------------------------------------------------

_registry: dict[str, "HistoricalMemoryIndex"] = {}


def register_index(workspace: str, index: "HistoricalMemoryIndex") -> None:
    """在注册表中保存实例，供工具和 ContextBuilder 按需取用。"""
    _registry[workspace] = index


def get_index(workspace: str) -> "HistoricalMemoryIndex | None":
    """按 workspace 路径取回已注册的索引实例。"""
    return _registry.get(workspace)


# ---------------------------------------------------------------------------
# 字级分词（默认，零依赖）
# ---------------------------------------------------------------------------

_CJK_RE = re.compile(r"[A-Za-z0-9]+|[\u4e00-\u9fff\u3400-\u4dbf]")
_CJK_SPACE_RE = re.compile(r"(?<=[^\x00-\x7f]) (?=[^\x00-\x7f])")


def _segment_text(text: str) -> str:
    """CJK 拆单字、ASCII 词保留整体，用空格连接供 FTS unicode61 tokenizer 索引。"""
    return " ".join(_CJK_RE.findall(text))


def _segment_query(query: str) -> str:
    """把查询词转为 FTS5 表达式。

    - 单个词/短语：转为 phrase（双引号包裹），要求相邻字符连续出现。
    - 多个词（空格分隔）：各自转为 phrase 后用 AND 连接，要求全部出现但不要求连续。
    """
    parts = query.strip().split()
    segments: list[str] = []
    for part in parts:
        tokens = _CJK_RE.findall(part)
        if not tokens:
            continue
        if len(tokens) == 1:
            segments.append(tokens[0])
        else:
            segments.append('"' + " ".join(tokens) + '"')
    return " AND ".join(segments) if segments else query


# ---------------------------------------------------------------------------
# Markdown 清洗与 frontmatter 解析
# ---------------------------------------------------------------------------

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_SCALAR_FIELD_RE = re.compile(r"^(\w+):\s*(.+)$", re.MULTILINE)
_LIST_ITEM_RE = re.compile(r"^[ \t]+-\s+(.+)$", re.MULTILINE)
_NOISE_PATTERNS = [
    re.compile(r"```json[\s\S]*?```"),                   # 天气 API JSON 块
    re.compile(r"```[\s\S]*?```"),                        # 其他代码块
    re.compile(r"!\[\[.*?\]\]"),                          # Obsidian 图片 embed
    re.compile(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]"),        # [[wikilink]] 展开为显示文本
    re.compile(r"^>>.*$", re.MULTILINE),                  # Obsidian 嵌套 callout 内容行（天气详情等）
    re.compile(r">\s*\[!\w+\][-+]?\s*"),                  # callout 标记行
    re.compile(r"<[^>]+>"),                               # HTML 标签
    re.compile(r"^\|[-| ]+\|$", re.MULTILINE),            # Markdown 表格分隔行
]


def _parse_frontmatter(raw: str) -> tuple[dict[str, str], str]:
    """解析 YAML frontmatter，返回 (字段字典, 正文文本)。"""
    m = _FRONTMATTER_RE.match(raw)
    if not m:
        return {}, raw
    fm_block = m.group(1)
    body = raw[m.end():]
    fields: dict[str, str] = {}
    # 单行标量字段
    for key, val in _SCALAR_FIELD_RE.findall(fm_block):
        fields.setdefault(key, val.strip())
    # 多行 list 字段（心情/tags）：找字段名后的缩进列表
    for list_key in ("心情", "tags"):
        marker = f"\n{list_key}:"
        start = fm_block.find(marker)
        if start == -1:
            if fm_block.startswith(f"{list_key}:"):
                start = -len(list_key) - 1  # 开头
            else:
                continue
        # 取该字段到下一个顶级字段之间的文本
        block_start = start + len(marker) + 1
        next_top = re.search(r"\n\w+:", fm_block[block_start:])
        block_end = block_start + next_top.start() if next_top else len(fm_block)
        items = _LIST_ITEM_RE.findall(fm_block[block_start:block_end])
        if items:
            fields[list_key] = ", ".join(items)
    return fields, body


def _clean_body(body: str) -> str:
    """去除正文中 Obsidian 噪声，保留可读文本。"""
    text = body
    for pat in _NOISE_PATTERNS:
        text = pat.sub(" ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ---------------------------------------------------------------------------
# 日期提取
# ---------------------------------------------------------------------------

def _extract_date(path: Path, pattern: re.Pattern[str]) -> str:
    """从文件名或路径字符串提取 YYYY-MM-DD，失败时用 mtime 兜底。"""
    for candidate in (path.name, str(path)):
        hit = pattern.search(candidate)
        if hit:
            return hit.group(1)
    try:
        return datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d")
    except OSError:
        return ""


# ---------------------------------------------------------------------------
# 结果数据类
# ---------------------------------------------------------------------------

class SearchHit:
    """单条检索命中。"""

    __slots__ = ("path", "date", "summary", "snippet")

    def __init__(self, path: str, date: str, summary: str, snippet: str) -> None:
        self.path = path
        self.date = date
        self.summary = summary
        self.snippet = snippet

    def format(self) -> str:
        parts = [f"[{self.date}]"]
        if self.summary:
            parts.append(self.summary)
        if self.snippet:
            clean = _CJK_SPACE_RE.sub("", self.snippet)
            parts.append(f"…{clean}…")
        parts.append(f"({self.path})")
        return " | ".join(parts)


class RecentNote:
    """按日预热用的日记摘要条目。"""

    __slots__ = ("path", "date", "summary", "mood")

    def __init__(self, path: str, date: str, summary: str, mood: str) -> None:
        self.path = path
        self.date = date
        self.summary = summary
        self.mood = mood

    def format(self) -> str:
        parts = [f"[{self.date}]"]
        if self.summary:
            parts.append(self.summary)
        if self.mood:
            parts.append(f"心情: {self.mood}")
        parts.append(f"({self.path})")
        return " | ".join(parts)


# ---------------------------------------------------------------------------
# HistoricalMemoryIndex
# ---------------------------------------------------------------------------

_FTS5_AVAILABLE: bool | None = None


def _check_fts5() -> bool:
    global _FTS5_AVAILABLE
    if _FTS5_AVAILABLE is None:
        try:
            c = sqlite3.connect(":memory:")
            c.execute("CREATE VIRTUAL TABLE _t USING fts5(x)")
            c.close()
            _FTS5_AVAILABLE = True
        except Exception:
            _FTS5_AVAILABLE = False
    return _FTS5_AVAILABLE


class HistoricalMemoryIndex:
    """
    SQLite FTS5 历史日记索引。

    表结构：
    - ``_files(path TEXT PK, mtime REAL)``：mtime 增量缓存
    - ``docs(path, date, summary, mood, content, tokenize='unicode61')``：
      FTS5 虚表，content 列存字级分词后的文本，其余列 UNINDEXED
    """

    def __init__(self, config: HistoricalMemoryConfig, workspace: Path) -> None:
        self._config = config
        self._workspace = workspace
        self._date_pattern = re.compile(config.date_pattern)
        db_path = (
            Path(config.index_path).expanduser()
            if config.index_path
            else workspace / "memory" / "historical.db"
        )
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db_path = db_path
        # 读连接：仅在事件循环主线程中使用（search / recent）
        self._read_con: sqlite3.Connection | None = None
        self._ready = False
        self._building = False
        self._error: str | None = None

    # -- 连接与建表 -----------------------------------------------------------

    @staticmethod
    def _init_schema(con: sqlite3.Connection) -> None:
        con.execute("""
            CREATE TABLE IF NOT EXISTS _files (
                path  TEXT PRIMARY KEY,
                mtime REAL NOT NULL
            )
        """)
        # FTS5 虚表：path/date/summary/mood 是 UNINDEXED（只用于过滤/返回），
        # content 列存字级分词文本供全文检索
        con.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
                path    UNINDEXED,
                date    UNINDEXED,
                summary UNINDEXED,
                mood    UNINDEXED,
                content,
                tokenize = 'unicode61'
            )
        """)
        con.commit()

    def _read_connect(self) -> sqlite3.Connection:
        """返回读连接（懒建）。设置 check_same_thread=False 以支持跨协程调用。"""
        if self._read_con is None:
            self._read_con = sqlite3.connect(str(self._db_path), check_same_thread=False)
            self._read_con.execute("PRAGMA journal_mode=WAL")
            self._read_con.execute("PRAGMA synchronous=NORMAL")
            self._init_schema(self._read_con)
        return self._read_con

    # -- 文件扫描 -------------------------------------------------------------

    def _iter_paths(self) -> list[Path]:
        """遍历所有配置根目录，返回匹配 glob 的文件列表。"""
        result: list[Path] = []
        for root_str in self._config.paths:
            root = Path(root_str).expanduser().resolve()
            if not root.exists():
                logger.warning("历史记忆路径不存在，跳过: {}", root)
                continue
            for p in sorted(root.rglob(self._config.glob)):
                if p.is_file():
                    result.append(p)
        return result

    # -- 单文件索引 -----------------------------------------------------------

    def _index_file(self, con: sqlite3.Connection, path: Path) -> None:
        """解析并索引单个 md 文件（先删再插实现 upsert）。"""
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return
        fields, body = _parse_frontmatter(raw)
        summary = fields.get("概要", "")
        mood = fields.get("心情", "")
        date_str = _extract_date(path, self._date_pattern)
        clean_text = _clean_body(body)
        # 字级分词：摘要 + 正文合并后索引，提升摘要字段的召回权重
        fts_content = _segment_text(f"{summary} {clean_text}")

        path_str = str(path)
        # FTS5 虚表不支持 UPDATE，用 DELETE + INSERT 实现 upsert
        con.execute("DELETE FROM docs WHERE path = ?", (path_str,))
        con.execute(
            "INSERT INTO docs(path, date, summary, mood, content) VALUES (?,?,?,?,?)",
            (path_str, date_str, summary, mood, fts_content),
        )
        con.execute(
            "INSERT OR REPLACE INTO _files(path, mtime) VALUES (?,?)",
            (path_str, path.stat().st_mtime),
        )

    # -- 增量更新 -------------------------------------------------------------

    def refresh(self) -> int:
        """
        增量更新索引：新增/修改文件 upsert，已消失文件删除。

        在后台线程中执行，使用独立写连接，不与主线程读连接共享。
        返回变更文件数量。
        """
        if not _check_fts5():
            logger.warning("SQLite FTS5 不可用，历史记忆索引跳过构建")
            self._ready = True  # 标记 ready 避免无限重试；检索会返回空
            return 0

        self._building = True
        self._error = None
        # 后台线程专用写连接，生命周期仅限于本次 refresh，不与读连接共享
        con = sqlite3.connect(str(self._db_path))
        changed = 0
        try:
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("PRAGMA synchronous=NORMAL")
            self._init_schema(con)

            all_paths = self._iter_paths()
            current_paths = {str(p) for p in all_paths}

            # 读取 mtime 缓存
            cached: dict[str, float] = dict(
                con.execute("SELECT path, mtime FROM _files").fetchall()
            )
            # 删除已不存在的文件
            removed = set(cached) - current_paths
            for path_str in removed:
                con.execute("DELETE FROM docs WHERE path = ?", (path_str,))
                con.execute("DELETE FROM _files WHERE path = ?", (path_str,))
                changed += 1

            # 新增或变更的文件
            for p in all_paths:
                path_str = str(p)
                try:
                    mtime = p.stat().st_mtime
                except OSError:
                    continue
                if cached.get(path_str) == mtime:
                    continue  # mtime 未变，跳过
                self._index_file(con, p)
                changed += 1
                if changed % 200 == 0:
                    con.commit()  # 分批提交，避免大事务

            con.commit()
            self._ready = True
            logger.info(
                "历史记忆索引完成：变更 {} 文件，共 {} 文件",
                changed,
                len(all_paths),
            )
        except Exception as exc:
            self._error = str(exc)
            logger.exception("历史记忆索引构建失败")
        finally:
            con.close()
            self._building = False
        return changed

    async def refresh_async(self) -> int:
        """在线程池中执行 refresh()，不阻塞事件循环。"""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self.refresh)

    # -- 检索 -----------------------------------------------------------------

    def search(self, query: str, top_k: int | None = None) -> list[SearchHit]:
        """全文检索，返回最多 top_k 条命中（含日期/摘要/snippet）。"""
        if not self._ready:
            return []
        k = top_k if top_k is not None else self._config.search_top_k
        con = self._read_connect()
        fts_query = _segment_query(query)
        try:
            rows = con.execute(
                """
                SELECT path, date, summary,
                       snippet(docs, 4, '>', '<', '...', 16)
                FROM docs
                WHERE content MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (fts_query, k),
            ).fetchall()
        except sqlite3.OperationalError as e:
            logger.warning("历史记忆检索出错 (query={!r}): {}", query, e)
            return []
        return [
            SearchHit(path=r[0], date=r[1] or "", summary=r[2] or "", snippet=r[3] or "")
            for r in rows
        ]

    def recent(self, days: int) -> list[RecentNote]:
        """返回最近 days 天的日记摘要（按 date 倒序）。"""
        if not self._ready or days <= 0:
            return []
        cutoff = (date.today() - timedelta(days=days - 1)).strftime("%Y-%m-%d")
        con = self._read_connect()
        try:
            rows = con.execute(
                "SELECT path, date, summary, mood FROM docs WHERE date >= ? ORDER BY date DESC",
                (cutoff,),
            ).fetchall()
        except sqlite3.OperationalError as e:
            logger.warning("历史记忆 recent 查询出错: {}", e)
            return []
        return [
            RecentNote(path=r[0], date=r[1] or "", summary=r[2] or "", mood=r[3] or "")
            for r in rows
        ]

    @property
    def is_ready(self) -> bool:
        return self._ready

    @property
    def is_building(self) -> bool:
        return self._building

    @property
    def error(self) -> str | None:
        """索引构建失败时的错误信息，成功或未构建时为 None。"""
        return self._error
