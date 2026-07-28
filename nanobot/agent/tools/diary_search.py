"""日记搜索工具（grep 实现）。

用 grep 搜索 Obsidian 日记 markdown 文件，替代旧数据库索引查询。
"""

from __future__ import annotations

import asyncio
import re
import subprocess
from pathlib import Path
from typing import Any

from nanobot.agent.tools.base import Tool

_DEFAULT_LIMIT = 10
_MAX_LIMIT = 20


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
    if not words:
        return []

    # 搜文件
    all_files = _grep_files(root, words[0])
    for w in words[1:]:
        all_files = {f for f in all_files if _file_contains(f, w)}

    and_files = set(all_files)

    # AND 不足 → OR 补充
    if len(all_files) < limit:
        or_files: set[str] = set()
        for w in words:
            or_files.update(_grep_files(root, w))
        extra = [f for f in or_files if f not in all_files]
        all_files.update(extra)

    # 按日期倒序
    sorted_files = sorted(all_files, reverse=True)[:limit]

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

    return results


def _grep_files(root: Path, word: str) -> set[str]:
    try:
        r = subprocess.run(
            ["grep", "-rl", "--include=*.md", word, str(root)],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0 and r.stdout.strip():
            return {f for f in r.stdout.strip().split("\n") if f.strip()}
    except Exception:
        pass
    return set()


def _file_contains(filepath: str, word: str) -> bool:
    try:
        r = subprocess.run(
            ["grep", "-l", word, filepath],
            capture_output=True, text=True, timeout=10,
        )
        return r.returncode == 0
    except Exception:
        return False


def _extract_snippet(filepath: str, words: list[str]) -> str:
    pattern = "|".join(re.escape(w) for w in words)
    try:
        r = subprocess.run(
            ["grep", "-m", "3", "-B", "1", "-A", "1", "-E", pattern, filepath],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0 or not r.stdout:
            return ""
        lines = r.stdout.strip().split("\n")
        cleaned = [
            line for line in lines
            if not line.strip().startswith("概要:")
            and line.strip() not in ("---", "--", "")
        ]
        return " ".join(cleaned)[:200]
    except Exception:
        return ""
