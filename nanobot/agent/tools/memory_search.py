"""历史记忆检索工具。默认搜日记/笔记，可选搜原始对话。"""

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
    """检索日记笔记（默认）与原始对话（可选）。"""

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
            "检索历史记忆：默认只搜日记/笔记（以用户视角提炼的生活记录）。"
            "支持中文/英文关键词；多个关键词用空格分隔时，优先返回全部命中（AND），不足时补充任一命中（OR）。"
            "since/until 过滤日记日期。"
            "需要查阅原始对话细节时传 include_chat=true，会额外搜索被裁出上下文的原始对话。"
            "\n\n"
            "触发时机：\n"
            "- 引用过去（之前/上次/记得/聊过/说过）→ 搜索\n"
            "- 特定实体（角色名/游戏名/手办名/歌曲名等，需要查历史背景）→ 搜索\n"
            "- 因果关系（为什么/怎么回事，需要追溯上下文）→ 搜索\n"
            "- 即时请求（出图/天气/记账/问候）→ 不搜索\n"
            "- 当前上下文已有完整信息 → 不搜索"
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
                "include_chat": {
                    "type": "boolean",
                    "description": "是否额外搜索原始对话（默认 false，只搜日记）。需要查阅被裁出的原始对话细节时设为 true。",
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
        include_chat: bool = False,
    ) -> str:
        lines = [f"检索「{query}」：\n"]

        # 日记搜索（默认）
        if self._diary_enabled():
            diary_result = await self._search_diary(
                query, since=since, until=until, limit=limit,
            )
            lines.extend(self._format_diary_section(query, diary_result.hits, diary_result.status))

        # 原始对话搜索（仅 include_chat=true 时）
        if include_chat:
            chat_limit = max(1, min(limit, _CHAT_MAX_LIMIT))
            chat_results = await asyncio.to_thread(
                self._history_store.search,
                query,
                session_key=session_key,
                since=since,
                until=until,
                limit=chat_limit,
            )
            if self._diary_enabled():
                lines.append("")
            lines.extend(self._format_chat_section(query, chat_results))

        if not self._diary_enabled() and not include_chat:
            lines.append("日记搜索未启用（historicalMemory 配置缺失）。")

        return "\n".join(lines)
