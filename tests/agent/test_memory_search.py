"""memory_search 工具单元测试。"""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from nanobot.agent.historical_memory import SearchHit
from nanobot.agent.tools.memory_search import MemorySearchTool


def _chat_row() -> dict:
    return {
        "session_key": "cli:default",
        "trimmed_at": "2026-06-01T10:00:00",
        "msg_timestamp": "2026-06-01T09:00:00",
        "role": "user",
        "content_text": "上周菜谱规划",
        "snippet": "上周菜谱规划",
        "match_type": "and",
    }


@pytest.fixture
def history_store() -> MagicMock:
    return MagicMock()


@pytest.fixture
def tool(history_store: MagicMock) -> MemorySearchTool:
    return MemorySearchTool(
        history_store=history_store,
        workspace="/tmp/ws",
        historical_memory_config=None,
    )


@pytest.mark.asyncio
async def test_chat_only_when_diary_disabled(tool: MemorySearchTool, history_store: MagicMock) -> None:
    history_store.search.return_value = [_chat_row()]

    result = await tool.execute("菜谱")

    assert "## 原始对话" in result
    assert "日记笔记" not in result


@pytest.mark.asyncio
async def test_chat_empty_result(tool: MemorySearchTool, history_store: MagicMock) -> None:
    history_store.search.return_value = []

    result = await tool.execute("不存在")

    assert "## 原始对话" in result
    assert "未找到与「不存在」相关的会话历史。" in result
    assert "日记笔记" not in result


@pytest.mark.asyncio
async def test_chat_filters_passed_through(tool: MemorySearchTool, history_store: MagicMock) -> None:
    history_store.search.return_value = []

    await tool.execute(
        "菜谱",
        session_key="cli:default",
        since="2026-06-01",
        until="2026-06-15",
        limit=5,
    )

    history_store.search.assert_called_once_with(
        "菜谱",
        session_key="cli:default",
        since="2026-06-01",
        until="2026-06-15",
        limit=5,
    )


@pytest.mark.asyncio
async def test_diary_section_when_index_ready(history_store: MagicMock) -> None:
    cfg = SimpleNamespace(enabled=True, root="/notes", search_top_k=10)
    tool = MemorySearchTool(
        history_store=history_store,
        workspace="/tmp/ws",
        historical_memory_config=cfg,
    )
    history_store.search.return_value = []

    index = MagicMock()
    index.is_building = False
    index.error = None
    index.is_ready = True
    index.search.return_value = [
        SearchHit(
            path="/notes/2026-06-01.md",
            date="2026-06-01",
            summary="概要",
            snippet="鸣潮",
            match_type="and",
        ),
    ]

    with patch("nanobot.agent.historical_memory.get_index", return_value=index):
        result = await tool.execute("鸣潮")

    assert "## 原始对话" in result
    assert "## 日记笔记" in result
    assert "鸣潮" in result
    index.search.assert_called_once_with("鸣潮", top_k=10, since=None, until=None)


@pytest.mark.asyncio
async def test_diary_since_until_passed_to_index(history_store: MagicMock) -> None:
    cfg = SimpleNamespace(enabled=True, root="/notes", search_top_k=10)
    tool = MemorySearchTool(
        history_store=history_store,
        workspace="/tmp/ws",
        historical_memory_config=cfg,
    )
    history_store.search.return_value = []

    index = MagicMock()
    index.is_building = False
    index.error = None
    index.is_ready = True
    index.search.return_value = []

    with patch("nanobot.agent.historical_memory.get_index", return_value=index):
        await tool.execute("鸣潮", since="2026-06-01", until="2026-06-15")

    index.search.assert_called_once_with(
        "鸣潮",
        top_k=10,
        since="2026-06-01",
        until="2026-06-15",
    )


@pytest.mark.asyncio
async def test_diary_status_when_index_building(history_store: MagicMock) -> None:
    cfg = SimpleNamespace(enabled=True, root="/notes", search_top_k=10)
    tool = MemorySearchTool(
        history_store=history_store,
        workspace="/tmp/ws",
        historical_memory_config=cfg,
    )
    history_store.search.return_value = [_chat_row()]

    index = MagicMock()
    index.is_building = True
    index.error = None
    index.is_ready = False

    with patch("nanobot.agent.historical_memory.get_index", return_value=index):
        result = await tool.execute("菜谱")

    assert "## 原始对话" in result
    assert "## 日记笔记" in result
    assert "索引正在构建中" in result


@pytest.mark.asyncio
async def test_chat_and_diary_search_run_in_parallel(history_store: MagicMock) -> None:
    """对话与日记检索应并行发起，而非等一侧完成后再查另一侧。"""
    cfg = SimpleNamespace(enabled=True, root="/notes", search_top_k=10)
    tool = MemorySearchTool(
        history_store=history_store,
        workspace="/tmp/ws",
        historical_memory_config=cfg,
    )

    chat_done = threading.Event()
    diary_started = threading.Event()

    def slow_chat_search(*_args, **_kwargs):
        time.sleep(0.05)
        chat_done.set()
        return []

    def slow_diary_search(*_args, **_kwargs):
        diary_started.set()
        assert not chat_done.is_set(), "日记检索应在对话检索完成前已开始"
        return []

    index = MagicMock()
    index.is_building = False
    index.error = None
    index.is_ready = True
    index.search.side_effect = slow_diary_search
    history_store.search.side_effect = slow_chat_search

    with patch("nanobot.agent.historical_memory.get_index", return_value=index):
        await tool.execute("并行")

    assert diary_started.is_set()
