"""Tests for consolidation eager trim + history store persistence."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.agent.memory import Consolidator, MemoryStore
from nanobot.session.history_store import SessionHistoryStore
from nanobot.session.manager import Session


def _archived_contents(history_store: SessionHistoryStore) -> list[str]:
    archive_dir = history_store._archive_dir
    assert archive_dir is not None
    return [
        json.loads(line)["content"]
        for path in archive_dir.glob("*.jsonl")
        for line in path.read_text(encoding="utf-8").splitlines()
    ]


@pytest.fixture
def store(tmp_path):
    return MemoryStore(tmp_path)


@pytest.fixture
def history_store(tmp_path):
    return SessionHistoryStore(tmp_path / "sessions")


@pytest.fixture
def mock_provider():
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(
        return_value=MagicMock(content="summary text", finish_reason="stop"),
    )
    provider.generation.max_tokens = 100
    return provider


@pytest.fixture
def consolidator(store, mock_provider, history_store):
    sessions = MagicMock()
    sessions.save = MagicMock()
    cache: dict[str, Session] = {}

    def get_or_create(key: str) -> Session:
        return cache[key]

    sessions.get_or_create = MagicMock(side_effect=get_or_create)
    sessions.invalidate = MagicMock()
    sessions._cache = cache

    consolidator = Consolidator(
        store=store,
        provider=mock_provider,
        model="test-model",
        sessions=sessions,
        context_window_tokens=10000,
        build_messages=MagicMock(return_value=[]),
        get_tool_definitions=MagicMock(return_value=[]),
        max_completion_tokens=100,
        history_store=history_store,
    )
    consolidator._cache = cache
    return consolidator


class TestEagerTrim:
    async def test_maybe_consolidate_trims_messages_and_writes_history(
        self, consolidator, mock_provider, history_store,
    ):
        session = Session(key="cli:test")
        for i in range(12):
            session.add_message("user", f"question {i}")
            session.add_message("assistant", f"answer {i}")
        consolidator._cache["cli:test"] = session

        estimates = [9000, 100]
        consolidator.estimate_session_prompt_tokens = MagicMock(
            side_effect=lambda _session: (estimates.pop(0), "mock"),
        )
        consolidator.pick_consolidation_boundary = MagicMock(return_value=(4, 100))
        consolidator.archive = AsyncMock(return_value="summary")

        await consolidator.maybe_consolidate_by_tokens(session)

        assert len(session.messages) == 20
        assert session.last_consolidated == 0
        assert "question 0" in _archived_contents(history_store)

    async def test_compact_idle_session_writes_trimmed_messages(
        self, consolidator, mock_provider, history_store,
    ):
        session = Session(key="cli:idle")
        session.last_consolidated = 2
        session.messages = [
            {"role": "user", "content": "old-0"},
            {"role": "assistant", "content": "old-1"},
            {"role": "user", "content": "mid-2"},
            {"role": "assistant", "content": "mid-3"},
            {"role": "user", "content": "keep-4"},
            {"role": "assistant", "content": "keep-5"},
        ]
        consolidator._cache["cli:idle"] = session
        consolidator.archive = AsyncMock(return_value="summary")

        await consolidator.compact_idle_session("cli:idle", max_suffix=2)

        assert len(session.messages) == 2
        assert session.last_consolidated == 0
        assert session.messages[-1]["content"] == "keep-5"
        archived = _archived_contents(history_store)
        assert "old-0" in archived
        assert "mid-2" in archived
        assert "keep-4" not in archived

    async def test_eager_trim_without_history_store_still_shortens_messages(
        self, store, mock_provider,
    ):
        sessions = MagicMock()
        sessions.save = MagicMock()
        cache: dict[str, Session] = {}

        sessions.get_or_create = MagicMock(side_effect=lambda key: cache[key])
        sessions.invalidate = MagicMock()

        consolidator = Consolidator(
            store=store,
            provider=mock_provider,
            model="test-model",
            sessions=sessions,
            context_window_tokens=10000,
            build_messages=MagicMock(return_value=[]),
            get_tool_definitions=MagicMock(return_value=[]),
            max_completion_tokens=100,
            history_store=None,
        )

        session = Session(key="cli:no-store")
        for i in range(12):
            session.add_message("user", f"question {i}")
            session.add_message("assistant", f"answer {i}")
        cache["cli:no-store"] = session

        consolidator.estimate_session_prompt_tokens = MagicMock(
            side_effect=[(9000, "mock"), (100, "mock")],
        )
        consolidator.pick_consolidation_boundary = MagicMock(return_value=(4, 100))
        consolidator.archive = AsyncMock(return_value="summary")

        await consolidator.maybe_consolidate_by_tokens(session)

        assert len(session.messages) == 20
        assert session.last_consolidated == 0
