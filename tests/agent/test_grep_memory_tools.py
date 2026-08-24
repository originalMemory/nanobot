"""Tests for grep-backed memory search tools."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.agent.active_memory import (
    ActiveMemoryHook,
    DiarySearchResult,
    _build_topic_card,
    _format_injection,
    _grep_diary,
    _load_topic_decision,
    _log,
    _search_diary,
    _topic_path,
)
from nanobot.agent.hook import AgentHookContext, AgentRunHookContext
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


@pytest.mark.asyncio
async def test_active_memory_schedules_unconfirmed_relation_without_injecting_parent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    note = tmp_path / "2026-08-23 周日.md"
    note.write_text("概要: 鸣潮与大侠立志传\n鸣潮 大侠立志传", encoding="utf-8")

    async def fake_extract(_self: ActiveMemoryHook, _text: str) -> str:
        return "大侠立志传"

    monkeypatch.setattr(ActiveMemoryHook, "_extract_keywords", fake_extract)
    monkeypatch.setattr(
        "nanobot.agent.active_memory._search_diary",
        lambda *_args: DiarySearchResult(
            hits=[{"date": "2026-08-23", "snippet": "玩了大侠立志传"}],
            candidates=[],
            update_topic="鸣潮",
            update_topic_files=[str(note)],
            update_fingerprint="fp",
            topic_evidence_terms=("大侠立志传",),
        ),
    )
    scheduled = []

    async def summarize(_prompt: str) -> str:
        return json.dumps({
            "topic": "鸣潮",
            "aliases": [],
            "related_entities": [],
            "rejected_relations": [{
                "name": "大侠立志传",
                "reason": "独立游戏作品，与鸣潮是平级主题",
            }],
            "summary": "摘要",
        }, ensure_ascii=False)

    hook = ActiveMemoryHook(diary_root=str(tmp_path), workspace=tmp_path)
    hook.configure_topic_summary(summarize, scheduled.append)
    hook._topic_dir.mkdir(parents=True)
    _topic_path(hook._topic_dir, "鸣潮").write_text(json.dumps({
        "schema_version": 5,
        "topic": "鸣潮",
        "aliases": [],
        "related_entities": [],
        "source_count": 1,
        "summary": "鸣潮长期摘要",
    }, ensure_ascii=False), encoding="utf-8")
    user = {"role": "user", "content": "昨天玩了什么游戏？"}
    await hook.before_iteration(AgentHookContext(iteration=0, messages=[user]))
    await hook.on_finally(AgentRunHookContext(messages=[]))

    assert "鸣潮长期摘要" not in user["content"]
    assert len(scheduled) == 1
    await scheduled[0]
    card = json.loads(_topic_path(hook._topic_dir, "鸣潮").read_text(encoding="utf-8"))
    assert card["rejected_relations"] == [{
        "name": "大侠立志传",
        "reason": "独立游戏作品，与鸣潮是平级主题",
    }]


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


def test_short_term_dense_keyword_does_not_create_topic(
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

    assert result.topic is None


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


@pytest.mark.asyncio
async def test_active_memory_topic_card_uses_main_summary_result(tmp_path: Path) -> None:
    notes = []
    for date in ("2025-01-01", "2026-01-01"):
        path = tmp_path / f"{date} 周三.md"
        body = "鸣潮版本更新\n中间无关内容\n今汐剧情很好" if date == "2026-01-01" else "开始关注鸣潮"
        path.write_text(f"概要: {date} 的游戏记录\n{body}\n", encoding="utf-8")
        notes.append(str(path))

    prompts = []

    async def summarize(prompt: str) -> str:
        prompts.append(prompt)
        return json.dumps({
            "topic": "鸣潮",
            "aliases": ["Wuthering Waves"],
            "related_entities": [{
                "name": "今汐",
                "relation": "角色",
                "source_dates": ["2025-01-01"],
            }, {
                "name": "今汐",
                "relation": "角色",
                "source_dates": ["2026-01-01", "2026-01-01"],
            }],
            "summary": "- 2025：开始关注\n- 2026：持续游玩",
        }, ensure_ascii=False)

    topic_dir = tmp_path / "topics"
    await _build_topic_card(
        topic="鸣潮",
        files=notes,
        fingerprint="fp",
        topic_dir=topic_dir,
        summarize=summarize,
        evidence_terms=("今汐",),
    )

    card = json.loads(next(topic_dir.glob("*.json")).read_text(encoding="utf-8"))
    assert card["schema_version"] == 5
    assert card["topic"] == "鸣潮"
    assert card["source_count"] == 2
    assert card["fingerprint"] == "fp"
    assert card["related_entities"] == [{
        "name": "今汐",
        "relation": "角色",
        "source_dates": ["2026-01-01"],
    }]
    assert "MOD、抽卡、战斗" in prompts[0]
    assert "不得把 MOD 写成“鸣潮 MOD”" in prompts[0]
    assert "本次候选关联词：今汐" in prompts[0]
    assert '"related_topics"' in prompts[0]


@pytest.mark.asyncio
async def test_active_memory_topic_card_generation_is_single_flight(tmp_path: Path) -> None:
    note = tmp_path / "2026-01-01 周四.md"
    note.write_text("概要: 鸣潮记录\n", encoding="utf-8")
    scheduled = []

    async def summarize(prompt: str) -> str:
        if "主题资格分类器" in prompt:
            return '{"eligible":true,"reason":"明确作品"}'
        return '{"topic":"鸣潮","aliases":[],"summary":"长期摘要"}'

    hook = ActiveMemoryHook(diary_root=str(tmp_path), workspace=tmp_path)
    hook.configure_topic_summary(summarize, scheduled.append)
    hook._maybe_schedule_topic_card("鸣潮", [str(note)], "fp")
    hook._maybe_schedule_topic_card("鸣潮", [str(note)], "fp")

    assert scheduled == []
    await hook.on_finally(AgentRunHookContext(messages=[]))
    assert len(scheduled) == 1
    await scheduled[0]
    assert hook._topic_tasks == set()
    decision = _load_topic_decision(hook._topic_dir, "鸣潮")
    assert decision["eligible"] is True
    assert decision["reason"] == "明确作品"

    hook._maybe_schedule_topic_card("鸣潮", [str(note)], "fp")
    assert len(scheduled) == 1


@pytest.mark.asyncio
async def test_rejected_topic_decision_caches_reason_and_skips_future_requests(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = []
    for index in range(20):
        year = 2024 + index // 12
        month = index % 12 + 1
        note = tmp_path / f"{year:04d}-{month:02d}-01 周一.md"
        note.write_text("概要: 普通日常\n看了真人图片", encoding="utf-8")
        notes.append(str(note))
    scheduled = []
    prompts = []

    async def summarize(prompt: str) -> str:
        prompts.append(prompt)
        return '{"eligible":false,"reason":"真人是宽泛图片类别，不构成独立长期主题"}'

    hook = ActiveMemoryHook(diary_root=str(tmp_path), workspace=tmp_path)
    hook.configure_topic_summary(summarize, scheduled.append)
    hook._maybe_schedule_topic_card("真人", notes, "fp")
    await hook.on_finally(AgentRunHookContext(messages=[]))
    await scheduled[0]

    decision = _load_topic_decision(hook._topic_dir, "真人")
    assert decision["eligible"] is False
    assert decision["reason"] == "真人是宽泛图片类别，不构成独立长期主题"
    assert len(prompts) == 1
    assert list(hook._topic_dir.glob("*.json")) == []

    hook._maybe_schedule_topic_card("真人", notes, "changed")
    await hook.on_finally(AgentRunHookContext(messages=[]))
    assert len(scheduled) == 1
    assert len(prompts) == 1

    monkeypatch.setattr(
        "nanobot.agent.active_memory._grep_files",
        lambda _word, _root: set(notes),
    )
    result = _search_diary("真人", str(tmp_path), hook._topic_dir)
    assert result.topic is None


@pytest.mark.asyncio
async def test_active_memory_topic_card_failure_is_background_only(tmp_path: Path) -> None:
    note = tmp_path / "2026-01-01 周四.md"
    note.write_text("概要: 鸣潮记录\n", encoding="utf-8")
    scheduled = []

    async def summarize(_prompt: str) -> str:
        raise RuntimeError("provider unavailable")

    hook = ActiveMemoryHook(diary_root=str(tmp_path), workspace=tmp_path)
    hook.configure_topic_summary(summarize, scheduled.append)
    hook._maybe_schedule_topic_card("鸣潮", [str(note)], "fp")
    await hook.on_finally(AgentRunHookContext(messages=[]))

    await scheduled[0]
    assert list(hook._topic_dir.glob("*.json")) == []
    assert _load_topic_decision(hook._topic_dir, "鸣潮") is None
    log = json.loads(hook._log_path.read_text(encoding="utf-8"))
    assert log["action"] == "topic_card_error"


@pytest.mark.asyncio
async def test_old_topic_card_schema_triggers_rebuild(tmp_path: Path) -> None:
    note = tmp_path / "2026-01-01 周四.md"
    note.write_text("概要: 鸣潮记录\n鸣潮", encoding="utf-8")
    topic_dir = tmp_path / "memory" / "active_memory_topics"
    topic_dir.mkdir(parents=True)
    _topic_path(topic_dir, "鸣潮").write_text(json.dumps({
        "schema_version": 2,
        "topic": "鸣潮",
        "aliases": [],
        "source_count": 1,
        "fingerprint": "fp",
        "summary": "旧卡",
    }, ensure_ascii=False), encoding="utf-8")
    scheduled = []

    async def summarize(_prompt: str) -> str:
        return '{"topic":"鸣潮","aliases":[],"summary":"新卡"}'

    hook = ActiveMemoryHook(diary_root=str(tmp_path), workspace=tmp_path)
    hook.configure_topic_summary(summarize, scheduled.append)
    hook._maybe_schedule_topic_card("鸣潮", [str(note)], "fp")
    await hook.on_finally(AgentRunHookContext(messages=[]))

    assert len(scheduled) == 1
    await scheduled[0]
    rebuilt = json.loads(_topic_path(topic_dir, "鸣潮").read_text(encoding="utf-8"))
    assert rebuilt["schema_version"] == 5


@pytest.mark.asyncio
async def test_active_memory_topic_card_keeps_large_source_set_in_one_call(tmp_path: Path) -> None:
    notes = []
    for index in range(81):
        path = tmp_path / f"2025-01-{index + 1:02d} 周一.md"
        path.write_text(f"概要: 第 {index} 条鸣潮记录\n", encoding="utf-8")
        notes.append(str(path))
    prompts = []

    async def summarize(prompt: str) -> str:
        prompts.append(prompt)
        return '{"topic":"鸣潮","aliases":[],"summary":"长期摘要"}'

    assert await _build_topic_card(
        topic="鸣潮",
        files=notes,
        fingerprint="fp",
        topic_dir=tmp_path / "topics",
        summarize=summarize,
    ) is True
    assert len(prompts) == 1
    assert "第 0 条鸣潮记录" in prompts[0]
    assert "第 80 条鸣潮记录" in prompts[0]


@pytest.mark.asyncio
async def test_narrow_seed_does_not_overwrite_broader_canonical_card(tmp_path: Path) -> None:
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    broad = {
        "topic": "鸣潮",
        "aliases": ["今汐"],
        "source_count": 100,
        "summary": "完整鸣潮卡",
    }
    path = _topic_path(topic_dir, "鸣潮")
    path.write_text(json.dumps(broad, ensure_ascii=False), encoding="utf-8")
    note = tmp_path / "2026-01-01 周四.md"
    note.write_text("概要: 今汐记录\n", encoding="utf-8")

    async def summarize(_prompt: str) -> str:
        return '{"topic":"鸣潮","aliases":["今汐"],"summary":"窄卡"}'

    assert await _build_topic_card(
        topic="今汐",
        files=[str(note)],
        fingerprint="narrow",
        topic_dir=topic_dir,
        summarize=summarize,
    ) is False
    assert json.loads(path.read_text(encoding="utf-8"))["summary"] == "完整鸣潮卡"


@pytest.mark.asyncio
async def test_canonical_topic_rename_removes_old_hash_file(tmp_path: Path) -> None:
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    old_path = _topic_path(topic_dir, "Wuthering Waves")
    old_path.write_text(json.dumps({
        "topic": "Wuthering Waves",
        "aliases": [],
        "source_count": 1,
        "summary": "旧卡",
    }), encoding="utf-8")
    note = tmp_path / "2026-01-01 周四.md"
    note.write_text("概要: 鸣潮记录\nWuthering Waves", encoding="utf-8")

    async def summarize(_prompt: str) -> str:
        return '{"topic":"鸣潮","aliases":["Wuthering Waves"],"summary":"新卡"}'

    assert await _build_topic_card(
        topic="Wuthering Waves",
        files=[str(note)],
        fingerprint="fp",
        topic_dir=topic_dir,
        summarize=summarize,
    ) is True
    assert old_path.exists() is False
    assert _topic_path(topic_dir, "鸣潮").exists() is True


def test_active_memory_reuses_parent_topic_card_by_related_entity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    note = tmp_path / "2026-01-01 周四.md"
    note.write_text("概要: 今汐剧情\n今汐", encoding="utf-8")
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    (topic_dir / "card.json").write_text(json.dumps({
        "topic": "鸣潮",
        "aliases": ["Wuthering Waves"],
        "related_entities": [{
            "name": "今汐",
            "relation": "角色",
            "source_dates": ["2026-01-01"],
        }],
        "source_count": 100,
        "summary": "长期摘要",
    }, ensure_ascii=False), encoding="utf-8")
    older = tmp_path / "2025-01-01 周三.md"
    older.write_text("概要: 鸣潮旧记录\n鸣潮", encoding="utf-8")

    def fake_files(word: str, _root: str) -> set[str]:
        return {str(note)} if word == "今汐" else {str(note), str(older)}

    monkeypatch.setattr("nanobot.agent.active_memory._grep_files", fake_files)

    result = _search_diary("今汐", str(tmp_path), topic_dir)

    assert result.topic == "鸣潮"
    assert result.topic_card is not None
    assert result.topic_card["summary"] == "长期摘要"
    assert result.topic_card["_match_kind"] == "related"
    assert result.topic_files == sorted([str(note), str(older)])

    injection = _format_injection(result.hits, result.topic_card)
    assert "关联主题脉络｜鸣潮" in injection
    assert "今汐：鸣潮的角色" in injection

    alias_result = _search_diary("wuthering waves", str(tmp_path), topic_dir)
    assert alias_result.topic_card is not None
    assert alias_result.topic_card["_match_kind"] == "alias"


def test_active_memory_infers_new_related_entity_from_topic_cooccurrence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    (topic_dir / "card.json").write_text(json.dumps({
        "topic": "鸣潮",
        "aliases": ["Wuthering Waves"],
        "related_entities": [],
        "source_count": 50,
        "fingerprint": "old",
        "summary": "鸣潮长期摘要",
    }, ensure_ascii=False), encoding="utf-8")
    note = tmp_path / "2026-08-19 周三.md"
    note.write_text(
        "概要: Wuthering Waves 新角色绯雪登场\nWuthering Waves 绯雪",
        encoding="utf-8",
    )

    def fake_files(word: str, _root: str) -> set[str]:
        return {str(note)} if word in {"Wuthering Waves", "绯雪"} else set()

    monkeypatch.setattr("nanobot.agent.active_memory._grep_files", fake_files)
    result = _search_diary("绯雪", str(tmp_path), topic_dir)

    assert result.topic is None
    assert result.topic_card is None
    assert result.update_topic == "鸣潮"
    assert result.update_topic_files == [str(note)]
    assert result.topic_evidence_terms == ("绯雪",)


@pytest.mark.asyncio
async def test_rejected_relation_is_permanent_when_evidence_dates_change(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    first = tmp_path / "2026-08-23 周日.md"
    first.write_text("概要: 鸣潮和大侠立志传\n鸣潮 大侠立志传", encoding="utf-8")
    card_path = _topic_path(topic_dir, "鸣潮")
    card_path.write_text(json.dumps({
        "schema_version": 5,
        "topic": "鸣潮",
        "aliases": [],
        "related_entities": [],
        "source_count": 1,
        "summary": "旧摘要",
    }, ensure_ascii=False), encoding="utf-8")

    async def summarize(_prompt: str) -> str:
        return json.dumps({
            "topic": "鸣潮",
            "aliases": [],
            "related_entities": [],
            "rejected_relations": [{
                "name": "大侠立志传",
                "reason": "独立游戏作品，与鸣潮是平级主题",
            }],
            "summary": "新摘要",
        }, ensure_ascii=False)

    assert await _build_topic_card(
        topic="鸣潮",
        files=[str(first)],
        fingerprint="fp",
        topic_dir=topic_dir,
        summarize=summarize,
        evidence_terms=("大侠立志传",),
    ) is True
    card = json.loads(card_path.read_text(encoding="utf-8"))
    assert card["rejected_relations"] == [{
        "name": "大侠立志传",
        "reason": "独立游戏作品，与鸣潮是平级主题",
    }]

    topic_files = {str(first)}
    candidate_files = {str(first)}

    def fake_files(word: str, _root: str) -> set[str]:
        return topic_files if word == "鸣潮" else candidate_files

    monkeypatch.setattr("nanobot.agent.active_memory._grep_files", fake_files)
    unchanged = _search_diary("大侠立志传", str(tmp_path), topic_dir)
    assert unchanged.update_topic is None

    second = tmp_path / "2026-08-24 周一.md"
    second.write_text("概要: 鸣潮和大侠立志传\n鸣潮 大侠立志传", encoding="utf-8")
    topic_files.add(str(second))
    candidate_files.add(str(second))
    changed = _search_diary("大侠立志传", str(tmp_path), topic_dir)
    assert changed.update_topic is None


@pytest.mark.asyncio
async def test_related_topic_is_stored_without_dates_and_does_not_inherit_parent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    note = tmp_path / "2026-08-23 周日.md"
    note.write_text("概要: 鸣潮 MOD 更新\n修复鸣潮 MOD", encoding="utf-8")
    card_path = _topic_path(topic_dir, "鸣潮")
    card_path.write_text(json.dumps({
        "schema_version": 5,
        "topic": "鸣潮",
        "aliases": [],
        "related_entities": [],
        "related_topics": [],
        "source_count": 1,
        "summary": "旧摘要",
    }, ensure_ascii=False), encoding="utf-8")

    async def summarize(_prompt: str) -> str:
        return json.dumps({
            "topic": "鸣潮",
            "aliases": [],
            "related_entities": [],
            "related_topics": [{"name": "MOD", "relation": "内容扩展"}],
            "rejected_relations": [],
            "summary": "鸣潮长期摘要",
        }, ensure_ascii=False)

    assert await _build_topic_card(
        topic="鸣潮",
        files=[str(note)],
        fingerprint="fp",
        topic_dir=topic_dir,
        summarize=summarize,
        evidence_terms=("MOD",),
    ) is True
    card = json.loads(card_path.read_text(encoding="utf-8"))
    assert card["related_topics"] == [{"name": "MOD", "relation": "内容扩展"}]

    monkeypatch.setattr(
        "nanobot.agent.active_memory._grep_files",
        lambda word, _root: {str(note)} if word in {"鸣潮", "MOD"} else set(),
    )
    monkeypatch.setattr(
        "nanobot.agent.active_memory._terms_share_paragraph",
        lambda *_args: pytest.fail("cached related topic should skip paragraph scan"),
    )
    result = _search_diary("MOD", str(tmp_path), topic_dir)
    assert result.topic_card is None
    assert result.update_topic is None


@pytest.mark.asyncio
async def test_relation_candidate_must_be_classified_under_its_original_name(
    tmp_path: Path,
) -> None:
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    note = tmp_path / "2026-08-23 周日.md"
    note.write_text("概要: 鸣潮 MOD 更新\n修复鸣潮 MOD", encoding="utf-8")
    card_path = _topic_path(topic_dir, "鸣潮")
    original = {
        "schema_version": 5,
        "topic": "鸣潮",
        "aliases": [],
        "related_entities": [],
        "related_topics": [],
        "rejected_relations": [],
        "source_count": 1,
        "summary": "旧摘要",
    }
    card_path.write_text(json.dumps(original, ensure_ascii=False), encoding="utf-8")

    async def summarize(_prompt: str) -> str:
        return json.dumps({
            "topic": "鸣潮",
            "aliases": [],
            "related_entities": [],
            "related_topics": [{"name": "鸣潮 MOD", "relation": "内容扩展"}],
            "rejected_relations": [],
            "summary": "新摘要",
        }, ensure_ascii=False)

    assert await _build_topic_card(
        topic="鸣潮",
        files=[str(note)],
        fingerprint="fp",
        topic_dir=topic_dir,
        summarize=summarize,
        evidence_terms=("MOD",),
    ) is False
    assert json.loads(card_path.read_text(encoding="utf-8")) == original


@pytest.mark.asyncio
async def test_regular_rebuild_clears_rejection_reclassified_as_related_topic(
    tmp_path: Path,
) -> None:
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    note = tmp_path / "2026-08-23 周日.md"
    note.write_text("概要: 鸣潮 MOD 更新\n修复鸣潮 MOD", encoding="utf-8")
    card_path = _topic_path(topic_dir, "鸣潮")
    card_path.write_text(json.dumps({
        "schema_version": 5,
        "topic": "鸣潮",
        "aliases": [],
        "related_entities": [],
        "related_topics": [],
        "rejected_relations": [{"name": "MOD", "reason": "旧判断"}],
        "source_count": 1,
        "summary": "旧摘要",
    }, ensure_ascii=False), encoding="utf-8")

    async def summarize(_prompt: str) -> str:
        return json.dumps({
            "topic": "鸣潮",
            "aliases": [],
            "related_entities": [],
            "related_topics": [{"name": "MOD", "relation": "内容扩展"}],
            "rejected_relations": [],
            "summary": "新摘要",
        }, ensure_ascii=False)

    assert await _build_topic_card(
        topic="鸣潮",
        files=[str(note)],
        fingerprint="fp",
        topic_dir=topic_dir,
        summarize=summarize,
    ) is True
    card = json.loads(card_path.read_text(encoding="utf-8"))
    assert card["related_topics"] == [{"name": "MOD", "relation": "内容扩展"}]
    assert card["rejected_relations"] == []


def test_related_entity_uses_alias_topic_source_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    (topic_dir / "card.json").write_text(json.dumps({
        "topic": "鸣潮",
        "aliases": ["Wuthering Waves"],
        "related_entities": [{"name": "今汐", "relation": "角色", "source_dates": []}],
        "source_count": 1,
        "summary": "鸣潮摘要",
    }, ensure_ascii=False), encoding="utf-8")
    source = tmp_path / "2025-01-01 周三.md"
    source.write_text("概要: Wuthering Waves 记录\nWuthering Waves", encoding="utf-8")
    related = tmp_path / "2026-01-01 周四.md"
    related.write_text("概要: 今汐剧情\n今汐", encoding="utf-8")

    def fake_files(word: str, _root: str) -> set[str]:
        return {
            "Wuthering Waves": {str(source)},
            "今汐": {str(related)},
        }.get(word, set())

    monkeypatch.setattr("nanobot.agent.active_memory._grep_files", fake_files)
    result = _search_diary("今汐", str(tmp_path), topic_dir)

    assert result.topic == "鸣潮"
    assert result.topic_files == [str(source)]


def test_single_file_unrelated_paragraphs_do_not_infer_parent_topic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    (topic_dir / "card.json").write_text(json.dumps({
        "topic": "鸣潮",
        "aliases": [],
        "related_entities": [],
        "source_count": 50,
        "summary": "鸣潮摘要",
    }, ensure_ascii=False), encoding="utf-8")
    note = tmp_path / "2026-08-19 周三.md"
    note.write_text("今天玩鸣潮。\n\n晚饭吃了苹果。", encoding="utf-8")

    def fake_files(word: str, _root: str) -> set[str]:
        return {str(note)} if word in {"鸣潮", "苹果"} else set()

    monkeypatch.setattr("nanobot.agent.active_memory._grep_files", fake_files)

    result = _search_diary("苹果", str(tmp_path), topic_dir)

    assert result.topic is None


def test_active_memory_with_topic_card_prefers_recent_raw_results(
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

    assert result.hits[0]["date"] == "2026-01-01"


def test_related_entity_parent_uses_current_file_overlap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    for filename, topic, count in (
        ("a.json", "鸣潮", 100),
        ("b.json", "赛博朋克：边缘行者", 20),
    ):
        (topic_dir / filename).write_text(json.dumps({
            "topic": topic,
            "aliases": [],
            "related_entities": [{"name": "露西", "relation": "角色", "source_dates": []}],
            "source_count": count,
            "summary": f"{topic}摘要",
        }, ensure_ascii=False), encoding="utf-8")
    note = tmp_path / "2026-01-01 周四.md"
    note.write_text("概要: 露西联动\n露西", encoding="utf-8")

    def fake_files(word: str, _root: str) -> set[str]:
        if word in {"露西", "赛博朋克：边缘行者"}:
            return {str(note)}
        return set()

    monkeypatch.setattr("nanobot.agent.active_memory._grep_files", fake_files)
    result = _search_diary("露西", str(tmp_path), topic_dir)

    assert result.topic == "赛博朋克：边缘行者"


def test_parent_inference_keeps_cross_date_evidence_when_one_match_is_nearby(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    topic_dir = tmp_path / "topics"
    topic_dir.mkdir()
    for filename, topic, count in (("a.json", "A", 100), ("b.json", "B", 10)):
        (topic_dir / filename).write_text(json.dumps({
            "topic": topic,
            "aliases": [],
            "related_entities": [],
            "source_count": count,
            "summary": f"{topic}摘要",
        }), encoding="utf-8")

    a_files = set()
    for index in range(3):
        path = tmp_path / f"2025-0{index + 1}-01-a.md"
        path.write_text("A X" if index == 0 else "A\n\nX", encoding="utf-8")
        a_files.add(str(path))
    b_files = set()
    for index in range(2):
        path = tmp_path / f"2026-0{index + 1}-01-b.md"
        path.write_text("B\n\nX", encoding="utf-8")
        b_files.add(str(path))
    query_files = a_files | b_files

    def fake_files(word: str, _root: str) -> set[str]:
        return {"A": a_files, "B": b_files, "X": query_files}.get(word, set())

    monkeypatch.setattr("nanobot.agent.active_memory._grep_files", fake_files)
    result = _search_diary("X", str(tmp_path), topic_dir)

    assert result.topic is None
    assert result.update_topic == "A"


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
