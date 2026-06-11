#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""历史记忆索引：扫描外部笔记 md，建 SQLite 数据库索引，提供检索与按日预热。

支持两种文档类型：
- diary：日记文件，从文件名提取日期，解析 概要/心情 结构化字段
- note ：普通笔记，从 frontmatter created/date 字段提取日期，全量索引 frontmatter 值

检索策略（方案B）：
1. 按关键词 AND 匹配，结果按日期倒序
2. 若 AND 结果不足，补充 OR 匹配结果
3. AND 结果排在 OR 结果之前
"""

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

# 用于过滤 frontmatter 值里的 wikilink 图片（如 [[hash.jpg]]）
_WIKILINK_RE = re.compile(r"^\[\[.*\]\]$")


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


def _extract_date_from_frontmatter(fields: dict[str, str], path: Path) -> str:
    """从 frontmatter created/date 字段提取 YYYY-MM-DD，fallback mtime。

    note 类型文档使用此函数；created 字段可能含时间部分，取前 10 字符。
    """
    for key in ("created", "date"):
        val = fields.get(key, "").strip()
        if len(val) >= 10 and val[:4].isdigit():
            return val[:10]
    try:
        return datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d")
    except OSError:
        return ""


def _extract_frontmatter_text(fields: dict[str, str]) -> str:
    """将全量 frontmatter 值拼成可索引文本，过滤 wikilink 图片格式值。"""
    parts: list[str] = []
    for val in fields.values():
        val = val.strip()
        if not val or _WIKILINK_RE.match(val):
            continue
        parts.append(val)
    return " ".join(parts)


# ---------------------------------------------------------------------------
# 结果数据类
# ---------------------------------------------------------------------------

class SearchHit:
    """单条检索命中。"""

    __slots__ = ("path", "date", "summary", "snippet", "match_type")

    def __init__(self, path: str, date: str, summary: str, snippet: str, match_type: str = "and") -> None:
        self.path = path
        self.date = date
        self.summary = summary
        self.snippet = snippet
        self.match_type = match_type

    def format(self) -> str:
        parts = [f"[{self.date}]"]
        if self.summary:
            parts.append(self.summary)
        if self.snippet:
            parts.append(self.snippet)
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

_SNIPPET_CHARS = 120  # snippet 前后各取多少字符


def _make_snippet(content: str, keywords: list[str], context_chars: int = _SNIPPET_CHARS) -> str:
    """在 content 中找到第一个关键词，提取上下文作为 snippet。"""
    lower_content = content.lower()
    best_pos = -1
    for kw in keywords:
        pos = lower_content.find(kw.lower())
        if pos != -1 and (best_pos == -1 or pos < best_pos):
            best_pos = pos
    if best_pos == -1:
        # 找不到说明 content 为空或异常，取开头
        return content[:context_chars * 2]

    start = max(0, best_pos - context_chars)
    end = min(len(content), best_pos + context_chars)
    snippet = content[start:end]
    # 保留首尾完整字段
    if start > 0:
        snippet = "…" + snippet
    if end < len(content):
        snippet = snippet + "…"
    return snippet


class HistoricalMemoryIndex:
    """
    SQLite 历史笔记索引。

    表结构：
    - ``_files(path TEXT PK, mtime REAL)``：mtime 增量缓存
    - ``docs(path, date, summary, mood, doc_type, content)``：
      普通表，content 列存清洗后的原文

    doc_type：
    - ``diary``：日记文件（位于 diary_path 子目录），从文件名取日期，解析 概要/心情
    - ``note`` ：其他笔记，从 frontmatter created/date 取日期，全量索引 frontmatter 值
    """

    def __init__(self, config: HistoricalMemoryConfig, workspace: Path) -> None:
        self._config = config
        self._workspace = workspace
        self._date_pattern = re.compile(config.date_pattern)
        db_path = workspace / "memory" / "historical.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db_path = db_path

        # 解析根目录和日记子目录
        self._root: Path | None = None
        self._diary_root: Path | None = None
        if config.root:
            self._root = Path(config.root).expanduser().resolve()
            if config.diary_path:
                self._diary_root = self._root / config.diary_path

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
        # 普通表替代 FTS5 虚表
        con.execute("""
            CREATE TABLE IF NOT EXISTS docs (
                path     TEXT PRIMARY KEY,
                date     TEXT,
                summary  TEXT,
                mood     TEXT,
                doc_type TEXT,
                content  TEXT
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
        """遍历根目录，返回匹配 glob 的文件列表，排除备份/冲突目录。"""
        if self._root is None or not self._root.exists():
            if self._root is not None:
                logger.warning("历史记忆路径不存在，跳过: {}", self._root)
            return []
        # 排除隐藏目录（.开头的目录）下的所有文件，如 .stversions、.trash 等
        # 同时排除文件名含 sync-conflict 的冲突文件
        return [
            p for p in sorted(self._root.rglob(self._config.glob))
            if p.is_file()
            and not any(part.startswith(".") for part in p.relative_to(self._root).parts[:-1])
            and "sync-conflict" not in p.name
        ]

    def _doc_type(self, path: Path) -> str:
        """判断文件类型：位于 diary_root 下为 'diary'，否则为 'note'。"""
        if self._diary_root is not None:
            try:
                path.relative_to(self._diary_root)
                return "diary"
            except ValueError:
                pass
        return "note"

    # -- 单文件索引 -----------------------------------------------------------

    def _index_file(self, con: sqlite3.Connection, path: Path) -> None:
        """解析并索引单个 md 文件（INSERT OR REPLACE）。"""
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return

        fields, body = _parse_frontmatter(raw)
        clean_text = _clean_body(body)
        doc_type = self._doc_type(path)

        if doc_type == "diary":
            summary = fields.get("概要", "")
            mood = fields.get("心情", "")
            date_str = _extract_date(path, self._date_pattern)
            # 摘要 + 正文合并后索引
            index_content = f"{summary} {clean_text}"
        else:
            summary = ""
            mood = ""
            date_str = _extract_date_from_frontmatter(fields, path)
            # 全量 frontmatter 值 + 正文一并索引
            fm_text = _extract_frontmatter_text(fields)
            index_content = f"{fm_text} {clean_text}"

        path_str = str(path)
        con.execute(
            "INSERT OR REPLACE INTO docs(path, date, summary, mood, doc_type, content) VALUES (?,?,?,?,?,?)",
            (path_str, date_str, summary, mood, doc_type, index_content),
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
        """全文检索，返回最多 top_k 条命中（含日期/摘要/snippet）。

        策略：
        1. 先按关键词 AND（全部匹配）检索
        2. 若结果不足 top_k，用 OR（任一匹配）补充
        3. AND 结果排在 OR 结果之前，各组内按日期倒序
        """
        if not self._ready:
            return []
        k = top_k if top_k is not None else self._config.search_top_k
        keywords = query.strip().split()
        if not keywords:
            return []

        con = self._read_connect()

        # 辅助函数：执行 LIKE 查询
        def _query(operator: str, limit: int | None = None) -> list[tuple[str, str, str, str]]:
            clauses = [f"content LIKE ? COLLATE NOCASE" for _ in keywords]
            sql = (
                f"SELECT path, date, summary, content FROM docs "
                f"WHERE {' {} '.format(operator).join(clauses)} "
                f"ORDER BY date DESC"
            )
            params: list[str | int] = [f"%{kw}%" for kw in keywords]
            if limit is not None:
                sql += " LIMIT ?"
                params.append(limit)
            try:
                return con.execute(sql, params).fetchall()
            except sqlite3.OperationalError as e:
                logger.warning("历史记忆检索出错 (query={!r}): {}", query, e)
                return []

        # Step 1: AND 查询（SQL 层限制条数，避免大库全表扫描）
        and_rows = _query("AND", limit=k)
        and_hits = []
        for path, date_str, summary, content in and_rows:
            snippet = _make_snippet(content, keywords)
            and_hits.append(SearchHit(path=path, date=date_str or "", summary=summary or "", snippet=snippet, match_type="and"))

        # Step 2: OR 补充（排除 AND 已命中的路径）
        and_paths = {h.path for h in and_hits}
        if len(and_hits) < k:
            or_rows = _query("OR")
            or_hits = []
            for path, date_str, summary, content in or_rows:
                if path in and_paths:
                    continue
                snippet = _make_snippet(content, keywords)
                or_hits.append(SearchHit(path=path, date=date_str or "", summary=summary or "", snippet=snippet, match_type="or"))
                if len(and_hits) + len(or_hits) >= k:
                    break
            result = and_hits + or_hits
        else:
            result = and_hits[:k]

        return result

    def recent(self, days: int) -> list[RecentNote]:
        """返回最近 days 天的日记摘要（按 date 倒序，仅 doc_type='diary'）。"""
        if not self._ready or days <= 0:
            return []
        cutoff = (date.today() - timedelta(days=days - 1)).strftime("%Y-%m-%d")
        con = self._read_connect()
        try:
            rows = con.execute(
                """
                SELECT path, date, summary, mood FROM docs
                WHERE date >= ? AND doc_type = 'diary'
                ORDER BY date DESC
                """,
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

    def reset_db(self) -> None:
        """删除索引数据库，下次 refresh 时重建。"""
        self._ready = False
        db_path = str(self._db_path)
        if self._read_con:
            self._read_con.close()
            self._read_con = None
        try:
            import os
            os.remove(db_path)
            logger.info("历史记忆索引数据库已删除: {}", db_path)
        except FileNotFoundError:
            pass
