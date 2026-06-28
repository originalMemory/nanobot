"""Tests for grep-backed memory search tools."""

from __future__ import annotations

from pathlib import Path

import pytest

from nanobot.agent.tools.diary_search import DiarySearchTool
from nanobot.agent.tools.session_search import SessionSearchTool


@pytest.mark.asyncio
async def test_diary_search_formats_hits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    notes = tmp_path / "notes"
    notes.mkdir()

    def fake_grep(*_args):
        return [{"date": "2026-06-01", "snippet": "今天聊了鸣潮", "match_type": "and"}]

    monkeypatch.setattr("nanobot.agent.tools.diary_search._grep_diary", fake_grep)

    result = await DiarySearchTool(str(notes)).execute("鸣潮")

    assert "2026-06-01" in result
    assert "鸣潮" in result


@pytest.mark.asyncio
async def test_session_search_formats_hits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    archive = tmp_path / "archive"
    archive.mkdir()

    def fake_grep(*_args):
        return [{
            "match_type": "and",
            "msg_timestamp": "2026-06-01T08:00:00+08:00",
            "role": "user",
            "content_text": "question 0",
            "session_key": "",
            "cursor": "2026-06.jsonl:1",
        }]

    monkeypatch.setattr("nanobot.agent.tools.session_search._grep_sessions", fake_grep)

    result = await SessionSearchTool(str(archive)).execute("question 0")

    assert "question 0" in result
    assert "2026-06.jsonl:1" in result
