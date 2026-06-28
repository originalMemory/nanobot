"""会话历史搜索工具（grep 实现）。

用 grep 搜索导出的会话历史 jsonl 文件，替代旧 SQLite LIKE 查询。
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from typing import Any

from nanobot.agent.tools.base import Tool
from nanobot.session.history_store import extract_content_text

_DEFAULT_LIMIT = 10
_MAX_LIMIT = 100


class SessionSearchTool(Tool):
    """用 grep 搜索裁剪出上下文的原始对话。"""

    _plugin_discoverable = False
    _scopes = {"core", "subagent"}

    def __init__(self, archive_dir: str) -> None:
        self._archive_dir = Path(archive_dir)

    @property
    def name(self) -> str:
        return "session_search"

    @property
    def description(self) -> str:
        return (
            "检索历史对话（被裁出上下文的原始对话）。"
            "支持中文/英文关键词；多个关键词用空格分隔时，优先返回全部命中（AND），不足时补充任一命中（OR）。"
            "since/until 过滤对话消息时间。"
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
                    "description": "起始时间（ISO 日期或日期时间），过滤对话消息时间",
                },
                "until": {
                    "type": "string",
                    "description": "结束时间（ISO 日期或日期时间），过滤对话消息时间",
                },
                "limit": {
                    "type": "integer",
                    "description": "最多返回条数（默认 10，最大 100）",
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

        if not self._archive_dir.exists():
            lines.append(f"会话历史目录不存在: {self._archive_dir}")
            return "\n".join(lines)

        hits = await asyncio.to_thread(
            _grep_sessions, self._archive_dir, query, since, until, limit
        )

        if not hits:
            lines.append(f"未找到与「{query}」相关的会话历史。")
            return "\n".join(lines)

        and_hits = [h for h in hits if h.get("match_type") == "and"]
        or_hits = [h for h in hits if h.get("match_type") == "or"]
        lines.append(f"共 {len(hits)} 条：")
        if and_hits:
            lines.append(f"全部匹配（AND，{len(and_hits)} 条）：")
            lines.append(json.dumps(and_hits, ensure_ascii=False, indent=2))
        if or_hits:
            lines.append(f"部分匹配（OR，{len(or_hits)} 条）：")
            lines.append(json.dumps(or_hits, ensure_ascii=False, indent=2))
        return "\n".join(lines)


# ── grep 搜索逻辑 ────────────────────────────────────


def _grep_sessions(
    archive_dir: Path,
    query: str,
    since: str | None,
    until: str | None,
    limit: int,
) -> list[dict[str, Any]]:
    """grep 搜会话 jsonl 文件。AND→OR fallback。"""
    words = [w for w in query.split() if w]
    if not words:
        return []

    # 第一个词的行号
    base_lines = _grep_jsonl(archive_dir, words[0])
    if not base_lines:
        return []

    # AND：所有词都出现在同一行
    and_lines = set(base_lines.keys())
    for w in words[1:]:
        w_lines = set(_grep_jsonl(archive_dir, w).keys())
        and_lines &= w_lines

    # OR 补充
    if len(and_lines) < limit:
        all_keys = set(and_lines)
        for w in words:
            for key in _grep_jsonl(archive_dir, w):
                if key not in all_keys:
                    all_keys.add(key)
                    if len(all_keys) >= limit * 3:
                        break
        candidate_keys = all_keys
    else:
        candidate_keys = and_lines

    # 解析每行，过滤并格式化
    results: list[dict[str, Any]] = []
    for key in candidate_keys:
        data = base_lines.get(key)
        if data is None:
            # OR 补充的行，从文件读
            file_path, line_no = key.rsplit(":", 1)
            data = _read_line(Path(file_path), int(line_no))
            if not data:
                continue

        parsed = _parse_jsonl_line(data)
        if not parsed:
            continue

        # 时间过滤
        ts = parsed.get("timestamp", "")
        if since and ts < since:
            continue
        if until and ts > until:
            continue

        content_text = extract_content_text(parsed) or str(parsed.get("content", ""))
        match_type = "and" if key in and_lines else "or"
        results.append({
            "match_type": match_type,
            "msg_timestamp": ts,
            "role": parsed.get("role", ""),
            "content_text": content_text[:300],
            "cursor": f"{Path(key.rsplit(':', 1)[0]).name}:{key.rsplit(':', 1)[1]}",
        })

    # 按时间倒序
    results.sort(key=lambda r: r.get("msg_timestamp", ""), reverse=True)
    return results[:limit]


def _grep_jsonl(archive_dir: Path, word: str) -> dict[str, str]:
    """grep 搜 jsonl 文件，返回 {filepath:lineno: line_content}。"""
    try:
        r = subprocess.run(
            ["grep", "-rn", "--include=*.jsonl", word, str(archive_dir)],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0 or not r.stdout:
            return {}
        result = {}
        for line in r.stdout.strip().split("\n"):
            if ":" not in line:
                continue
            parts = line.split(":", 2)
            if len(parts) < 3:
                continue
            filepath, lineno, content = parts[0], parts[1], parts[2]
            result[f"{filepath}:{lineno}"] = content
        return result
    except Exception:
        return {}


def _read_line(filepath: Path, lineno: int) -> str | None:
    """读取指定行。"""
    try:
        with open(filepath, encoding="utf-8") as f:
            for i, line in enumerate(f, 1):
                if i == lineno:
                    return line.strip()
        return None
    except Exception:
        return None


def _parse_jsonl_line(line: str) -> dict[str, Any] | None:
    """解析 jsonl 行。"""
    try:
        return json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return None
