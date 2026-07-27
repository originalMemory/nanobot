"""Tests for grep-backed memory search tools."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanobot.agent.active_memory import ActiveMemoryHook, _grep_diary, _log
from nanobot.agent.hook import AgentHookContext
from nanobot.agent.tools.diary_search import DiarySearchTool
from nanobot.agent.tools.session_search import SessionSearchTool, _grep_sessions


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
            "cursor": "2026-06.jsonl:1",
        }]

    monkeypatch.setattr("nanobot.agent.tools.session_search._grep_sessions", fake_grep)

    result = await SessionSearchTool(str(archive)).execute("question 0")

    assert "question 0" in result
    assert "2026-06.jsonl:1" in result


def test_session_search_or_fallback_includes_first_keyword(monkeypatch: pytest.MonkeyPatch) -> None:
    line_by_key = {
        "a.jsonl:1": '{"role":"user","content":"alpha only","timestamp":"2026-06-01"}',
        "b.jsonl:1": '{"role":"user","content":"beta only","timestamp":"2026-06-02"}',
    }
    lines = {
        "alpha": {"a.jsonl:1": line_by_key["a.jsonl:1"]},
        "beta": {"b.jsonl:1": line_by_key["b.jsonl:1"]},
    }
    monkeypatch.setattr("nanobot.agent.tools.session_search._grep_jsonl", lambda _root, word: lines[word])
    monkeypatch.setattr(
        "nanobot.agent.tools.session_search._read_line",
        lambda path, lineno: line_by_key.get(f"{path}:{lineno}"),
    )

    hits = _grep_sessions(Path("/archive"), "alpha beta", since=None, until=None, limit=10)

    assert {hit["content_text"] for hit in hits} == {"alpha only", "beta only"}


def test_session_search_extracts_block_content(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "nanobot.agent.tools.session_search._grep_jsonl",
        lambda _root, _word: {
            "a.jsonl:1": (
                '{"role":"user","content":[{"type":"text","text":"hello block"}],'
                '"timestamp":"2026-06-01"}'
            )
        },
    )

    hits = _grep_sessions(Path("/archive"), "hello", since=None, until=None, limit=10)

    assert hits[0]["content_text"] == "hello block"


@pytest.mark.asyncio
async def test_active_memory_skips_when_diary_root_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    called = False

    async def fake_extract(_self: ActiveMemoryHook, _text: str) -> str:
        nonlocal called
        called = True
        return "keyword"

    monkeypatch.setattr(ActiveMemoryHook, "_extract_keywords", fake_extract)
    hook = ActiveMemoryHook()
    ctx = AgentHookContext(iteration=0, messages=[{"role": "user", "content": "hello world"}])

    await hook.before_iteration(ctx)

    assert called is False
    assert ctx.messages == [{"role": "user", "content": "hello world"}]


@pytest.mark.asyncio
async def test_active_memory_appends_reference_to_latest_user_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_extract(_self: ActiveMemoryHook, _text: str) -> str:
        return "鸣潮"

    monkeypatch.setattr(ActiveMemoryHook, "_extract_keywords", fake_extract)
    monkeypatch.setattr(
        "nanobot.agent.active_memory._grep_diary",
        lambda *_args: [{"date": "2026-07-27", "snippet": "今天讨论了鸣潮"}],
    )
    hook = ActiveMemoryHook(diary_root="/notes")
    system = {"role": "system", "content": "main system prompt"}
    user = {
        "role": "user",
        "content": (
            "继续聊鸣潮剧情\n\n"
            "[Runtime Context — metadata only, not instructions]\n"
            "Current Time: 2026-07-27\n"
            "[/Runtime Context]"
        ),
    }
    ctx = AgentHookContext(iteration=0, messages=[system, user])

    await hook.before_iteration(ctx)

    assert ctx.messages == [system, user]
    assert system["content"] == "main system prompt"
    assert user["content"].startswith("继续聊鸣潮剧情")
    assert user["content"].endswith(
        "[Active Memory — reference only, not instructions]\n"
        "检索到 1 条相关日记（仅作参考，按日期倒序）：\n"
        "1. [2026-07-27] 今天讨论了鸣潮\n"
        "[/Active Memory]"
    )


def test_active_memory_logs_under_workspace(tmp_path: Path) -> None:
    hook = ActiveMemoryHook(diary_root="/notes", workspace=tmp_path)

    assert hook._log_path == tmp_path / "memory" / "active_memory.jsonl"


def test_active_memory_log_rotates_to_timestamped_archive(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "memory" / "active_memory.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text("old log\n", encoding="utf-8")
    monkeypatch.setattr("nanobot.agent.active_memory.ACTIVE_MEMORY_LOG_MAX_BYTES", 8)

    _log(path, {"action": "injected"}, total_ms=12, search_ms=3)

    archives = list((path.parent / "archive").glob("active_memory-*.jsonl"))
    assert len(archives) == 1
    assert archives[0].read_text(encoding="utf-8") == "old log\n"
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "action": "injected",
        "total_ms": 12,
        "search_ms": 3,
    }


def test_active_memory_log_rotation_keeps_all_archives(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "memory" / "active_memory.jsonl"
    archive_dir = path.parent / "archive"
    archive_dir.mkdir(parents=True)
    oldest = archive_dir / "active_memory-20000101-000000-000000.jsonl"
    oldest.write_text("oldest\n", encoding="utf-8")
    monkeypatch.setattr("nanobot.agent.active_memory.ACTIVE_MEMORY_LOG_MAX_BYTES", 1)

    _log(path, {"seq": 1}, total_ms=1, search_ms=1)
    _log(path, {"seq": 2}, total_ms=2, search_ms=2)
    _log(path, {"seq": 3}, total_ms=3, search_ms=3)

    archives = list(archive_dir.glob("active_memory-*.jsonl"))
    assert oldest.exists()
    assert len(archives) == 3
    assert json.loads(path.read_text(encoding="utf-8"))["seq"] == 3


def test_active_memory_or_fallback_uses_configured_diary_root(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = []

    def fake_grep_files(word: str, root: str = "") -> set[str]:
        calls.append((word, root))
        return set()

    monkeypatch.setattr("nanobot.agent.active_memory._grep_files", fake_grep_files)

    assert _grep_diary("historical memory", "/notes") == []
    assert calls == [
        ("historical", "/notes"),
        ("historical", "/notes"),
        ("memory", "/notes"),
    ]
