"""日记搜索工具（grep 实现）。

用 grep 搜索 Obsidian 日记 markdown 文件，替代旧数据库索引查询。
"""

from __future__ import annotations

import asyncio
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from nanobot.agent.tools.base import Tool

_DEFAULT_LIMIT = 10
_MAX_LIMIT = 20


def canonical_diary_files(files: set[str]) -> set[str]:
    """冲突副本不作记忆证据，同一文件的链接只保留一份。"""
    canonical: dict[Path, str] = {}
    for filename in sorted(files):
        path = Path(filename)
        if ".sync-conflict-" not in path.name:
            canonical.setdefault(path.resolve(), filename)
    return set(canonical.values())


def diary_body(content: str) -> str:
    """去掉日记元数据、引言、天气与导航，保留生活正文。"""
    content = re.sub(r"\A---\s*\n.*?\n---[^\n]*(?:\n|$)", "", content, count=1, flags=re.S)
    content = re.split(r"(?m)^# 天气\s*$", content, maxsplit=1)[0]
    lines = []
    quote = False
    for line in content.splitlines():
        if re.match(r">\s*\[!quote\]", line):
            quote = True
        if quote and not line.startswith(">"):
            quote = False
        if quote or line.startswith(("概要:", "<< ", "<div ")):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def contains_diary_term(text: str, term: str) -> bool:
    """英文/数值词匹配完整标识，避免 115 命中 1150 或附件哈希。"""
    if not term:
        return False
    pattern = re.escape(term)
    if term[0].isascii() and term[0].isalnum():
        pattern = r"(?<![0-9A-Za-z_])" + pattern
    if term[-1].isascii() and term[-1].isalnum():
        pattern += r"(?![0-9A-Za-z_])"
    return re.search(pattern, text, re.IGNORECASE) is not None


def diary_excerpt(content: str, words: list[str], *, limit: int = 400) -> str:
    """按命中词覆盖选择完整段落，长段落截取命中附近。"""
    paragraphs = re.split(r"\n\s*\n", diary_body(content))
    ranked = sorted(
        ((sum(contains_diary_term(p, w) for w in words), i, p)
         for i, p in enumerate(paragraphs)),
        key=lambda item: (-item[0], item[1]),
    )
    selected = []
    for count, _, paragraph in ranked:
        if not count:
            break
        paragraph = " ".join(paragraph.split())
        if len(paragraph) > limit:
            folded = paragraph.casefold()
            offset = min((folded.find(w.casefold()) for w in words
                          if w.casefold() in folded), default=0)
            paragraph = paragraph[max(0, offset - 60):max(0, offset - 60) + limit]
        selected.append(paragraph)
        if sum(map(len, selected)) >= limit:
            break
    return "\n".join(selected)[:limit]


def search_diary_files(
    root: str | Path, word: str, *, include_conflicts: bool = False,
) -> set[str]:
    """完整字面扫描；读取/搜索失败抛出，不能冒充空证据。"""
    if not Path(root).is_dir():
        raise OSError("日记目录不可读")
    rg = shutil.which("rg")
    command = (
        [rg, "-l", "-i", "-F", "-g", "*.md", "--", word, str(root)]
        if rg else ["grep", "-rilF", "--include=*.md", "--", word, str(root)]
    )
    result = subprocess.run(command, capture_output=True, text=True, timeout=10)
    if result.returncode not in (0, 1):
        raise subprocess.CalledProcessError(result.returncode, command, output=result.stdout)
    files = set(result.stdout.splitlines())
    return files if include_conflicts else canonical_diary_files(files)


class DiarySearchTool(Tool):
    """用 grep 搜索日记/笔记 markdown 文件。"""

    _plugin_discoverable = False
    _scopes = {"core", "subagent"}

    def __init__(self, diary_root: str) -> None:
        self._diary_root = Path(diary_root)

    @property
    def name(self) -> str:
        return "diary_search"

    @property
    def description(self) -> str:
        return (
            "检索日记/笔记（以用户视角提炼的生活记录）。"
            "支持中文/英文关键词；多个关键词用空格分隔时，优先返回全部命中（AND），不足时补充任一命中（OR）。"
            "since/until 过滤日记日期。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "检索关键词或短语",
                    "minLength": 1,
                },
                "since": {
                    "type": "string",
                    "description": "起始日期（YYYY-MM-DD），过滤日记日期",
                },
                "until": {
                    "type": "string",
                    "description": "结束日期（YYYY-MM-DD），过滤日记日期",
                },
                "limit": {
                    "type": "integer",
                    "description": "最多返回条数（默认 10，最大 20）",
                    "minimum": 1,
                    "maximum": _MAX_LIMIT,
                },
            },
            "required": ["query"],
        }

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        query: str,
        since: str | None = None,
        until: str | None = None,
        limit: int = _DEFAULT_LIMIT,
    ) -> str:
        limit = min(limit, _MAX_LIMIT)
        lines = [f"检索「{query}」：\n"]

        if not self._diary_root.exists():
            lines.append(f"日记目录不存在: {self._diary_root}")
            return "\n".join(lines)

        hits = await asyncio.to_thread(
            _grep_diary, self._diary_root, query, since, until, limit
        )

        if not hits:
            lines.append(f"未找到与「{query}」相关的日记记录。")
            return "\n".join(lines)

        and_hits = [h for h in hits if h.get("match_type") == "and"]
        or_hits = [h for h in hits if h.get("match_type") == "or"]
        lines.append(f"共 {len(hits)} 条：")
        if and_hits:
            lines.append(f"全部匹配（AND，{len(and_hits)} 条）：")
            for i, h in enumerate(and_hits, 1):
                lines.append(f"  {i}. {h['date']} {h['snippet']}")
        if or_hits:
            lines.append(f"部分匹配（OR，{len(or_hits)} 条）：")
            for i, h in enumerate(or_hits, 1):
                lines.append(f"  {i}. {h['date']} {h['snippet']}")
        return "\n".join(lines)


# ── grep 搜索逻辑 ────────────────────────────────────


def _grep_diary(
    root: Path,
    query: str,
    since: str | None,
    until: str | None,
    limit: int,
) -> list[dict[str, str]]:
    """grep AND→OR 搜日记 markdown 文件。"""
    words = [w for w in query.split() if w]
    if not words or limit <= 0:
        return []

    # 搜文件
    all_files = _grep_files(root, words[0])
    for w in words[1:]:
        all_files = {f for f in all_files if _file_contains(f, w)}

    and_files = set(all_files)

    # 日期/正文过滤后才知道有效 AND 数量，先准备 OR 候选供补位。
    for word in words:
        all_files.update(_grep_files(root, word))

    # 按日期倒序
    sorted_files = sorted(all_files, reverse=True)
    sorted_files.sort(key=lambda path: path not in and_files)

    results = []
    for f in sorted_files:
        basename = Path(f).name
        date = basename[:10]
        # 日期过滤
        if since and date < since:
            continue
        if until and date > until:
            continue
        snippet = _extract_snippet(f, words)
        if not snippet:
            continue
        match_type = "and" if f in and_files else "or"
        results.append({"date": date, "snippet": snippet, "match_type": match_type})
        if len(results) >= limit:
            break

    return results


def _grep_files(root: Path, word: str) -> set[str]:
    try:
        return search_diary_files(root, word)
    except subprocess.CalledProcessError as exc:
        return canonical_diary_files(set((exc.output or "").splitlines()))
    except (OSError, subprocess.SubprocessError):
        return set()


def _file_contains(filepath: str, word: str) -> bool:
    try:
        r = subprocess.run(
            ["grep", "-liF", "--", word, filepath],
            capture_output=True, text=True, timeout=10,
        )
        return r.returncode == 0
    except Exception:
        return False


def _extract_snippet(filepath: str, words: list[str]) -> str:
    try:
        return diary_excerpt(Path(filepath).read_text(encoding="utf-8"), words)
    except (OSError, UnicodeError):
        return ""
