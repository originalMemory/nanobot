"""检索 consolidation 裁掉并写入 SQLite 的聊天记录。"""

from __future__ import annotations

import json
from typing import Any

from nanobot.agent.tools.base import Tool
from nanobot.session.history_store import SessionHistoryStore


class SearchChatTool(Tool):
    """在 sessions/history.db 中检索被整合裁掉的聊天记录。"""

    _plugin_discoverable = False
    _scopes = {"core", "subagent"}

    def __init__(self, history_store: SessionHistoryStore) -> None:
        self._history_store = history_store

    @property
    def name(self) -> str:
        return "search_chat"

    @property
    def description(self) -> str:
        return (
            "搜与焰的聊天记录，包含对话中讨论过的决策、菜谱规划、项目讨论、技术问题等。"
            "当用户问起『上周菜谱规划是什么』『之前讨论过什么 bug 』『某个决策是怎么定的』这类对话中提到的事时调用。"
            "支持关键词搜索，可选按会话来源或时间范围过滤。"
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
                    "description": "起始时间（ISO 日期或日期时间），按原始消息时间过滤",
                },
                "until": {
                    "type": "string",
                    "description": "结束时间（ISO 日期或日期时间），按原始消息时间过滤",
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
