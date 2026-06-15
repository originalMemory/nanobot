"""合并检索原始对话与日记笔记的历史记忆工具。"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from nanobot.agent.historical_memory import SearchHit
from nanobot.agent.tools.base import Tool
from nanobot.session.history_store import SessionHistoryStore

_CHAT_MAX_LIMIT = 100
_DIARY_MAX_LIMIT = 20
_DEFAULT_LIMIT = 10


@dataclass
class _DiarySearchResult:
    hits: list[SearchHit] | None
    status: str | None


class MemorySearchTool(Tool):
    """并行检索裁出的原始对话与用户视角日记笔记。"""

    _plugin_discoverable = False
    _scopes = {"core", "subagent"}

    def __init__(
        self,
        history_store: SessionHistoryStore,
        workspace: str,
        historical_memory_config: Any | None = None,
    ) -> None:
        self._history_store = history_store
        self._workspace = workspace
        self._historical_memory_config = historical_memory_config

    @property
    def name(self) -> str:
        return "memory_search"

    @property
    def description(self) -> str:
        return (
            "检索历史记忆：同时查裁出上下文的原始对话（双方原话）和以用户视角提炼的日记/笔记（生活记录）。"
            "只要用户话语涉及过去（时间词、回忆、延续旧话题、引用早前结论或生活事实），"
            "即主动调用以补充背景，无需用户明确要求检索。"
            "返回分「原始对话」与「日记笔记」两段并标注来源。"
            "支持中文/英文关键词；多个关键词用空格分隔时，优先返回全部命中（AND），不足时补充任一命中（OR）。"
            "session_key 仅过滤对话段；since/until 可同时过滤对话时间与日记日期。"
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
                "session_key": {
                    "type": "string",
                    "description": "限定会话 key（仅过滤对话段），如 cli:default 或 telegram:123",
                },
                "since": {
                    "type": "string",
                    "description": "起始时间（ISO 日期或日期时间）；过滤对话消息时间与日记日期",
                },
                "until": {
                    "type": "string",
                    "description": "结束时间（ISO 日期或日期时间）；过滤对话消息时间与日记日期",
                },
                "limit": {
                    "type": "integer",
                    "description": "每类来源最多返回条数（默认 10；对话最大 100，日记最大 20）",
                    "minimum": 1,
                    "maximum": 100,
                },
            },
            "required": ["query"],
        }

    @property
    def read_only(self) -> bool:
        return True

    def _diary_enabled(self) -> bool:
        cfg = self._historical_memory_config
        return bool(cfg and cfg.enabled and cfg.root)

    def _diary_top_k(self, limit: int) -> int:
        cfg = self._historical_memory_config
        default_k = cfg.search_top_k if cfg else _DEFAULT_LIMIT
        return max(1, min(limit, default_k, _DIARY_MAX_LIMIT))

    def _format_chat_section(self, query: str, results: list[dict[str, Any]]) -> list[str]:
        lines = ["## 原始对话"]
        if not results:
            lines.append(f"未找到与「{query}」相关的会话历史。")
            return lines

        and_results = [r for r in results if r.get("match_type") == "and"]
        or_results = [r for r in results if r.get("match_type") == "or"]
        lines.append(f"共 {len(results)} 条：")
        if and_results:
            lines.append(f"全部匹配（AND，{len(and_results)} 条）：")
            lines.append(json.dumps(and_results, ensure_ascii=False, indent=2))
        if or_results:
            lines.append(f"部分匹配（OR，{len(or_results)} 条）：")
            lines.append(json.dumps(or_results, ensure_ascii=False, indent=2))
        return lines

    def _diary_status_message(self, index: Any | None) -> str | None:
        if index is None:
            return "历史记忆索引尚未初始化，请检查 historicalMemory 配置。"
        if index.is_building:
            return "历史记忆索引正在构建中，请稍后再试。"
        if index.error:
            return f"历史记忆索引构建失败：{index.error}"
        if not index.is_ready:
            return "历史记忆索引未就绪（可能路径配置有误或索引尚未构建）。"
        return None

    def _format_diary_section(self, query: str, hits: list[SearchHit] | None, status: str | None) -> list[str]:
        lines = ["## 日记笔记"]
        if status:
            lines.append(status)
            return lines
        if not hits:
            lines.append(f"未找到与「{query}」相关的记录。")
            return lines

        and_hits = [h for h in hits if h.match_type == "and"]
        or_hits = [h for h in hits if h.match_type == "or"]
        lines.append(f"共 {len(hits)} 条：")
        if and_hits:
            lines.append(f"全部匹配（AND，{len(and_hits)} 条）：")
            for i, hit in enumerate(and_hits, 1):
                lines.append(f"  {i}. {hit.format()}")
        if or_hits:
            lines.append(f"部分匹配（OR，{len(or_hits)} 条）：")
            for i, hit in enumerate(or_hits, 1):
                lines.append(f"  {i}. {hit.format()}")
        return lines

    async def _search_diary(
        self,
        query: str,
        *,
        since: str | None,
        until: str | None,
        limit: int,
    ) -> _DiarySearchResult:
        from nanobot.agent.historical_memory import get_index

        index = get_index(self._workspace)
        status = self._diary_status_message(index)
        if status is not None or index is None:
            return _DiarySearchResult(hits=None, status=status)
        hits = await asyncio.to_thread(
            index.search,
            query,
            top_k=self._diary_top_k(limit),
            since=since,
            until=until,
        )
        return _DiarySearchResult(hits=hits, status=None)

    async def execute(
        self,
        query: str,
        session_key: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = _DEFAULT_LIMIT,
    ) -> str:
        chat_limit = max(1, min(limit, _CHAT_MAX_LIMIT))
        chat_coro = asyncio.to_thread(
            self._history_store.search,
            query,
            session_key=session_key,
            since=since,
            until=until,
            limit=chat_limit,
        )

        if self._diary_enabled():
            chat_results, diary_result = await asyncio.gather(
                chat_coro,
                self._search_diary(query, since=since, until=until, limit=limit),
            )
        else:
            chat_results = await chat_coro
            diary_result = _DiarySearchResult(hits=None, status=None)

        lines = [f"检索「{query}」：\n", *self._format_chat_section(query, chat_results)]
        if self._diary_enabled():
            lines.append("")
            lines.extend(self._format_diary_section(query, diary_result.hits, diary_result.status))

        return "\n".join(lines)
