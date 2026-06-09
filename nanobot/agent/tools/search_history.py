"""检索 consolidation 裁掉并写入 SQLite 的会话历史。"""

from __future__ import annotations

import json
from typing import Any

from nanobot.agent.tools.base import Tool
from nanobot.session.history_store import SessionHistoryStore


class SearchSessionHistoryTool(Tool):
    """在 sessions/history.db 中检索被整合裁掉的历史消息。"""

    _plugin_discoverable = False
    _scopes = {"core", "subagent"}

    def __init__(self, history_store: SessionHistoryStore) -> None:
        self._history_store = history_store

    @property
    def name(self) -> str:
        return "search_session_history"

    @property
    def description(self) -> str:
        return (
            "在本地会话历史库中检索被整合裁掉的消息原文。"
            "当用户询问过去某次对话里说过什么、做过什么决策、或需要回溯较早的会话细节时调用。"
            "支持关键词搜索，可选按 session_key 或时间范围过滤。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "检索关键词",
                    "minLength": 1,
                },
                "session_key": {
                    "type": "string",
                    "description": "限定会话 key，如 cli:default 或 telegram:123",
                },
                "since": {
                    "type": "string",
                    "description": "起始时间（ISO 日期或日期时间）",
                },
                "until": {
                    "type": "string",
                    "description": "结束时间（ISO 日期或日期时间）",
                },
                "limit": {
                    "type": "integer",
                    "description": "最多返回条数（默认 20，最大 100）",
                    "minimum": 1,
                    "maximum": 100,
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
        session_key: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 20,
    ) -> str:
        results = self._history_store.search(
            query,
            session_key=session_key,
            since=since,
            until=until,
            limit=limit,
        )
        if not results:
            return f"未找到与「{query}」相关的会话历史。"
        return json.dumps(results, ensure_ascii=False, indent=2)
