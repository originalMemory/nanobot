"""Tests for grep-backed memory search tools."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.agent.active_memory import (
    ActiveMemoryHook,
    DiarySearchResult,
    _grep_diary,
    _log,
    _search_diary,
)
from nanobot.agent.hook import AgentHookContext
from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.context import (
    RequestContext,
    bind_request_context,
    current_request_context,
    reset_request_context,
)
from nanobot.agent.tools.diary_search import DiarySearchTool
from nanobot.agent.tools.session_search import SessionSearchTool, _grep_sessions
from nanobot.providers.base import LLMResponse
from nanobot.providers.fallback_provider import FallbackProvider


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
        "nanobot.agent.active_memory._search_diary",
        lambda *_args: DiarySearchResult(
            hits=[{"date": "2026-07-27", "snippet": "今天讨论了鸣潮"}],
            candidates=[],
        ),
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
            "检索到 1 条相关日记（仅作参考）：\n"
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
    record = json.loads(path.read_text(encoding="utf-8"))
    assert record.pop("timestamp")
    assert record.pop("rule_version") == 2
    assert record == {
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
    assert calls == [("historical", "/notes"), ("memory", "/notes")]


def test_active_memory_ranks_keyword_coverage_before_recency(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    older = tmp_path / "2025-01-01 周三.md"
    newer = tmp_path / "2026-01-01 周四.md"
    older.write_text("概要: 同时聊鸣潮和今汐\n鸣潮 今汐", encoding="utf-8")
    newer.write_text("概要: 最近只聊鸣潮\n鸣潮", encoding="utf-8")

    def fake_files(word: str, _root: str) -> set[str]:
        return {str(older), str(newer)} if word == "鸣潮" else {str(older)}

    monkeypatch.setattr("nanobot.agent.active_memory._grep_files", fake_files)
    result = _search_diary("鸣潮 今汐", str(tmp_path))

    assert result.hits[0]["date"] == "2025-01-01"
    assert result.hits[0]["match_count"] == 2


def test_active_memory_high_frequency_topic_keeps_recent_and_historical_results(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    files = set()
    for index in range(24):
        year = 2024 + index // 12
        month = index % 12 + 1
        path = tmp_path / f"{year:04d}-{month:02d}-01 周一.md"
        path.write_text(f"概要: 第 {index} 条鸣潮记录\n鸣潮", encoding="utf-8")
        files.add(str(path))
    monkeypatch.setattr(
        "nanobot.agent.active_memory._grep_files",
        lambda _word, _root: files,
    )

    result = _search_diary("鸣潮", str(tmp_path))

    assert [hit["date"] for hit in result.hits[:6]] == [
        "2025-12-01", "2025-11-01", "2025-10-01",
        "2025-09-01", "2025-08-01", "2025-07-01",
    ]
    assert any(hit["date"].startswith("2024-") for hit in result.hits[6:])


def test_short_term_dense_keyword_can_reach_model_review(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    files = set()
    for day in range(1, 21):
        path = tmp_path / f"2026-08-{day:02d} 周一.md"
        path.write_text("概要: 临时活动\n活动", encoding="utf-8")
        files.add(str(path))
    monkeypatch.setattr(
        "nanobot.agent.active_memory._grep_files",
        lambda _word, _root: files,
    )

    result = _search_diary("活动", str(tmp_path))

    assert result.topic == "活动"
    assert result.topic_card is None


def test_long_term_candidate_is_not_filtered_by_summary_ratio(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    files = set()
    for index in range(20):
        year = 2024 + index // 12
        month = index % 12 + 1
        path = tmp_path / f"{year:04d}-{month:02d}-01 周一.md"
        summary = "真人照片" if index == 0 else "普通日常"
        path.write_text(f"概要: {summary}\n看了真人图片", encoding="utf-8")
        files.add(str(path))
    monkeypatch.setattr(
        "nanobot.agent.active_memory._grep_files",
        lambda _word, _root: files,
    )

    result = _search_diary("真人", str(tmp_path))

    assert result.topic == "真人"


def test_active_memory_with_topic_card_preserves_keyword_coverage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    (topic_dir / "card.json").write_text(json.dumps({
        "topic": "鸣潮",
        "aliases": [],
        "source_count": 50,
        "summary": "长期摘要",
    }, ensure_ascii=False), encoding="utf-8")
    older = tmp_path / "2024-01-01 周一.md"
    newer = tmp_path / "2026-01-01 周四.md"
    older.write_text("概要: 鸣潮今汐旧记录\n鸣潮 今汐", encoding="utf-8")
    newer.write_text("概要: 鸣潮近期记录\n鸣潮", encoding="utf-8")

    def fake_files(word: str, _root: str) -> set[str]:
        return {str(older), str(newer)} if word == "鸣潮" else {str(older)}

    monkeypatch.setattr("nanobot.agent.active_memory._grep_files", fake_files)
    result = _search_diary("鸣潮 今汐", str(tmp_path), topic_dir)

    assert result.hits[0]["date"] == "2024-01-01"


@pytest.mark.asyncio
async def test_active_memory_topic_summary_reuses_main_model_without_tools() -> None:
    loop = object.__new__(AgentLoop)
    loop.model = "openai-codex/gpt-5.6-sol"
    loop.provider = MagicMock()
    seen_contexts = []

    async def chat(**_kwargs):
        seen_contexts.append(current_request_context())
        return LLMResponse(content="summary")

    loop.provider.chat_with_retry = AsyncMock(side_effect=chat)

    token = bind_request_context(RequestContext(channel="websocket", chat_id="inbox:unified"))
    try:
        assert await loop._summarize_active_memory_topic("prompt") == "summary"
        assert current_request_context() is not None
    finally:
        reset_request_context(token)
    assert seen_contexts == [None]
    assert loop.provider.chat_with_retry.await_args.kwargs["model"] == loop.model
    assert loop.provider.chat_with_retry.await_args.kwargs["tools"] is None


@pytest.mark.asyncio
async def test_active_memory_topic_summary_bypasses_fallback_circuit() -> None:
    primary = MagicMock()
    primary.chat_with_retry = AsyncMock(return_value=LLMResponse(content="summary"))
    fallback = FallbackProvider(primary, [], lambda _preset: primary)
    fallback._primary_failures = 2
    loop = object.__new__(AgentLoop)
    loop.model = "model"
    loop.provider = fallback

    assert await loop._summarize_active_memory_topic("prompt") == "summary"
    primary.chat_with_retry.assert_awaited_once()
    assert fallback._primary_failures == 2
