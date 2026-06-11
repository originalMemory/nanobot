"""个人日记全文检索工具。"""

from __future__ import annotations

from typing import Any

from nanobot.agent.tools.base import Tool


class SearchDiaryTool(Tool):
    """在配置的日记库中全文检索，支持日记和笔记多种文档类型。"""

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
    def create(cls, ctx: Any) -> "SearchDiaryTool":
        cfg = ctx.historical_memory_config
        return cls(workspace=ctx.workspace, top_k=cfg.search_top_k)

    @property
    def name(self) -> str:
        return "search_diary"

    @property
    def description(self) -> str:
        return (
            "搜个人日记/笔记，包含用户记录的事件、心情、饮食、健康、购物、游戏经历等。"
            "当用户问起『上次什么时候去过植物园』『上个月体脂多少』『之前吃过什么』这类自己记录过的事实类问题时调用。"
            "支持中文关键词（包括 2 字词）、英文词、混合查询。"
            "多个关键词用空格分隔时，优先返回全部关键词都命中（AND）的记录，如「FA 黄泉」；"
            "若 AND 结果不足，再补充任一关键词命中（OR）的记录；"
            "单个关键词按子串匹配，如「鸣潮」。"
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
            return "历史记忆索引未就绪（可能路径配置有误或索引尚未构建）。"

        k = top_k if top_k is not None else self._top_k
        hits = index.search(query, top_k=k)
        if not hits:
            return f"未找到与「{query}」相关的记录。"

        and_hits = [h for h in hits if h.match_type == "and"]
        or_hits = [h for h in hits if h.match_type == "or"]
        lines = [f"检索「{query}」，共 {len(hits)} 条结果：\n"]
        if and_hits:
            lines.append(f"全部匹配（AND，{len(and_hits)} 条）：")
            for i, hit in enumerate(and_hits, 1):
                lines.append(f"  {i}. {hit.format()}")
        if or_hits:
            lines.append(f"部分匹配（OR，{len(or_hits)} 条）：")
            for i, hit in enumerate(or_hits, 1):
                lines.append(f"  {i}. {hit.format()}")
        return "\n".join(lines)
