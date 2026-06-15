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
            "检索你与焰之间被裁出当前上下文的原始对话全文（双方原话，非摘要、非日记提炼）。"
            "查「当时怎么说的」「聊过什么」「原话/讨论细节」时用此工具，勿与以用户视角书写的日记混淆。"
            "只要用户话语涉及过去的对话内容（时间词如上周/之前/上次/当时，或延续旧话题、引用早前结论），"
            "即主动调用以补充上下文，无需用户明确要求检索。"
            "支持中文/英文关键词；多个关键词用空格分隔时，优先返回全部命中（AND），不足时补充任一命中（OR）。"
            "可选按会话来源或时间范围过滤。"
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
                    "description": "最多返回条数（默认 10，最大 100）",
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
        limit: int = 10,
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

        and_results = [r for r in results if r.get("match_type") == "and"]
        or_results = [r for r in results if r.get("match_type") == "or"]
        lines = [f"检索「{query}」，共 {len(results)} 条结果：\n"]
        if and_results:
            lines.append(f"全部匹配（AND，{len(and_results)} 条）：")
            lines.append(json.dumps(and_results, ensure_ascii=False, indent=2))
        if or_results:
            lines.append(f"部分匹配（OR，{len(or_results)} 条）：")
            lines.append(json.dumps(or_results, ensure_ascii=False, indent=2))
        return "\n".join(lines)
