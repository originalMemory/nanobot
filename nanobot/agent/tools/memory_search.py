"""历史记忆检索工具：对外部日记库做 FTS5 全文检索。"""

from __future__ import annotations

from typing import Any

from nanobot.agent.tools.base import Tool


class MemorySearchTool(Tool):
    """在配置的历史记忆库中全文检索，支持日记和笔记多种文档类型。"""

    _scopes = {"core", "subagent"}

    def __init__(self, workspace: str, top_k: int) -> None:
        self._workspace = workspace
        self._top_k = top_k

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        """仅在 historicalMemory.enabled=true 且 root 非空时注册此工具。"""
        cfg = getattr(ctx, "historical_memory_config", None)
        return bool(cfg and cfg.enabled and cfg.root)

    @classmethod
    def create(cls, ctx: Any) -> "MemorySearchTool":
        cfg = ctx.historical_memory_config
        return cls(workspace=ctx.workspace, top_k=cfg.search_top_k)

    @property
    def name(self) -> str:
        return "memory_search"

    @property
    def description(self) -> str:
        return (
            "在历史记忆库中全文检索，覆盖日记和笔记等多种文档类型，返回命中的条目（日期、摘要、关键片段、文档类型）。"
            "当用户提及过去的事件、人物、游戏、情绪或想回忆某段经历时调用此工具。"
            "支持中文关键词（包括 2 字词）、英文词、混合查询。"
            "多个关键词用空格分隔，结果要求全部出现（AND），如「FA 黄泉」同时匹配两个关键词；"
            "单个关键词则精确匹配，如「鸣潮」。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "检索关键词或短语，如「鸣潮」「刘叶」「那段焦虑的日子」",
                    "minLength": 1,
                },
                "top_k": {
                    "type": "integer",
                    "description": f"最多返回条数（默认 {self._top_k}）",
                    "minimum": 1,
                    "maximum": 20,
                },
            },
            "required": ["query"],
        }

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, query: str, top_k: int | None = None) -> str:
        from nanobot.agent.historical_memory import get_index

        index = get_index(self._workspace)
        if index is None:
            return "历史记忆索引尚未初始化，请检查 historicalMemory 配置。"
        if index.is_building:
            return "历史记忆索引正在构建中，请稍后再试。"
        if index.error:
            return f"历史记忆索引构建失败：{index.error}"
        if not index.is_ready:
            return "历史记忆索引未就绪（可能 FTS5 不可用或路径配置有误）。"

        k = top_k if top_k is not None else self._top_k
        hits = index.search(query, top_k=k)
        if not hits:
            return f"未找到与「{query}」相关的记录。"

        lines = [f"检索「{query}」，共 {len(hits)} 条结果：\n"]
        for i, hit in enumerate(hits, 1):
            lines.append(f"{i}. {hit.format()}")
        return "\n".join(lines)
