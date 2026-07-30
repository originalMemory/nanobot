"""Tests for append-only WebUI transcript replay."""

from __future__ import annotations

from pathlib import Path

from nanobot.cron.session_turns import CRON_HISTORY_META
from nanobot.session.automation_turns import AUTOMATION_HISTORY_META
from nanobot.session.history_visibility import HIDDEN_HISTORY_META
from nanobot.webui.metadata import WEBUI_MESSAGE_SOURCE_METADATA_KEY
from nanobot.webui.transcript import (
    WEBUI_TRANSCRIPT_SCHEMA_VERSION,
    append_fork_marker,
    append_transcript_object,
    build_webui_thread_response,
    fork_transcript_before_user_index,
    read_transcript_lines,
    replay_transcript_to_ui_messages,
    webui_transcript_segments_dir,
    write_session_messages_as_transcript,
)


def test_append_and_read_roundtrip(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t1"
    append_transcript_object(key, {"event": "user", "chat_id": "t1", "text": "hello"})
    lines = read_transcript_lines(key)
    assert len(lines) == 1
    assert lines[0]["text"] == "hello"


def test_append_stamps_created_at_ms(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    monkeypatch.setattr("nanobot.webui.transcript.time.time", lambda: 1_700_000_000.0)
    key = "websocket:t-created-at"

    append_transcript_object(key, {"event": "user", "chat_id": "t-created-at", "text": "hello"})

    lines = read_transcript_lines(key)
    assert lines[0]["created_at_ms"] == 1_700_000_000_000


def _force_small_transcript_budget(monkeypatch, *, limit: int = 520, target: int = 260) -> None:
    monkeypatch.setattr("nanobot.webui.transcript._MAX_TRANSCRIPT_FILE_BYTES", limit)
    monkeypatch.setattr("nanobot.webui.transcript._TARGET_ACTIVE_TRANSCRIPT_BYTES", target)


def _append_numbered_turn(key: str, chat_id: str, idx: int) -> None:
    append_transcript_object(
        key,
        {"event": "user", "chat_id": chat_id, "text": f"question {idx} " + ("x" * 24)},
    )
    append_transcript_object(
        key,
        {"event": "message", "chat_id": chat_id, "text": f"answer {idx} " + ("y" * 24)},
    )
    append_transcript_object(key, {"event": "turn_end", "chat_id": chat_id})


def _write_segmented_turns(tmp_path, monkeypatch, key: str, chat_id: str, count: int) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    _force_small_transcript_budget(monkeypatch)
    for idx in range(1, count + 1):
        _append_numbered_turn(key, chat_id, idx)


def _message_contents(payload: dict) -> list[str]:
    return [str(message.get("content") or "") for message in payload["messages"]]


def _numbered_turn_texts(start: int, end: int) -> list[str]:
    return [
        text
        for idx in range(start, end + 1)
        for text in (f"question {idx} " + ("x" * 24), f"answer {idx} " + ("y" * 24))
    ]


def test_segmented_transcript_rotation_preserves_full_history(tmp_path, monkeypatch) -> None:
    key = "websocket:segmented"
    _write_segmented_turns(tmp_path, monkeypatch, key, "segmented", 6)

    segment_dir = webui_transcript_segments_dir(key)
    assert segment_dir.is_dir()
    assert (segment_dir / "manifest.json").is_file()

    lines = read_transcript_lines(key)
    contents = [str(line.get("text") or "") for line in lines if line.get("event") in {"user", "message"}]
    assert contents == _numbered_turn_texts(1, 6)


def test_segmented_transcript_paginates_latest_and_older_without_overlap(
    tmp_path,
    monkeypatch,
) -> None:
    key = "websocket:paged"
    _write_segmented_turns(tmp_path, monkeypatch, key, "paged", 6)

    latest = build_webui_thread_response(key, limit=4, direction="latest")
    assert latest is not None
    assert latest["page"]["has_more_before"] is True
    assert latest["page"]["user_message_offset"] == 4
    assert _message_contents(latest) == _numbered_turn_texts(5, 6)

    older = build_webui_thread_response(
        key,
        limit=4,
        before=latest["page"]["before_cursor"],
    )
    assert older is not None
    assert older["page"]["user_message_offset"] == 2
    assert _message_contents(older) == _numbered_turn_texts(3, 4)


def test_page_cursor_survives_active_rotation_after_latest_page(
    tmp_path,
    monkeypatch,
) -> None:
    key = "websocket:stable-cursor"
    _write_segmented_turns(tmp_path, monkeypatch, key, "stable-cursor", 7)

    latest = build_webui_thread_response(key, limit=4, direction="latest")
    assert latest is not None
    cursor = latest["page"]["before_cursor"]
    assert cursor
    assert _message_contents(latest) == _numbered_turn_texts(6, 7)

    for idx in range(8, 13):
        _append_numbered_turn(key, "stable-cursor", idx)

    older = build_webui_thread_response(key, limit=4, before=cursor)

    assert older is not None
    assert _message_contents(older) == _numbered_turn_texts(4, 5)


def test_segment_manifest_can_be_rebuilt_when_missing_or_corrupt(tmp_path, monkeypatch) -> None:
    key = "websocket:manifest"
    _write_segmented_turns(tmp_path, monkeypatch, key, "manifest", 4)

    manifest = webui_transcript_segments_dir(key) / "manifest.json"
    manifest.write_text("{not json", encoding="utf-8")

    lines = read_transcript_lines(key)

    assert len([line for line in lines if line.get("event") == "user"]) == 4
    assert manifest.read_text(encoding="utf-8").lstrip().startswith("{")


def test_delete_webui_transcript_removes_segments(tmp_path, monkeypatch) -> None:
    from nanobot.webui.thread_disk import webui_thread_file_path
    from nanobot.webui.transcript import delete_webui_transcript, webui_transcript_path

    key = "websocket:delete-segments"
    _write_segmented_turns(tmp_path, monkeypatch, key, "delete-segments", 4)
    legacy_path = webui_thread_file_path(key)
    legacy_path.parent.mkdir(parents=True, exist_ok=True)
    legacy_path.write_text('{"messages":[]}', encoding="utf-8")

    assert webui_transcript_segments_dir(key).is_dir()
    assert delete_webui_transcript(key) is True
    assert not legacy_path.exists()
    assert not webui_transcript_path(key).exists()
    assert not webui_transcript_segments_dir(key).exists()


def test_fork_transcript_reads_across_segments(tmp_path, monkeypatch) -> None:
    source = "websocket:seg-source"
    _write_segmented_turns(tmp_path, monkeypatch, source, "seg-source", 5)

    ok = fork_transcript_before_user_index(source, "websocket:seg-fork", 3)

    assert ok is True
    forked = build_webui_thread_response("websocket:seg-fork")
    assert forked is not None
    assert _message_contents(forked) == _numbered_turn_texts(1, 3)


def test_fork_transcript_before_user_index_copies_only_prefix(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    source = "websocket:source"
    for ev in (
        {"event": "user", "chat_id": "source", "text": "round1"},
        {"event": "message", "chat_id": "source", "text": "answer1"},
        {"event": "turn_end", "chat_id": "source"},
        {"event": "user", "chat_id": "source", "text": "round2 fork me"},
        {"event": "message", "chat_id": "source", "text": "answer2"},
        {"event": "user", "chat_id": "source", "text": "round3 must not appear"},
    ):
        append_transcript_object(source, ev)

    ok = fork_transcript_before_user_index(source, "websocket:fork", 1)

    assert ok is True
    lines = read_transcript_lines("websocket:fork")
    assert [line.get("text") for line in lines] == ["round1", "answer1", None]
    assert all(line.get("chat_id") == "fork" for line in lines)
    assert "round2 fork me" not in "\n".join(str(line.get("text")) for line in lines)
    assert "round3 must not appear" not in "\n".join(str(line.get("text")) for line in lines)


def test_fork_transcript_rejects_out_of_range_user_index(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    source = "websocket:source"
    append_transcript_object(source, {"event": "user", "chat_id": "source", "text": "round1"})

    assert fork_transcript_before_user_index(source, "websocket:fork", 2) is False
    assert read_transcript_lines("websocket:fork") == []


def test_build_response_reports_fork_boundary_from_marker(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:fork"
    for ev in (
        {"event": "user", "chat_id": "fork", "text": "round1"},
        {"event": "message", "chat_id": "fork", "text": "answer1"},
    ):
        append_transcript_object(key, ev)
    append_fork_marker(key)
    append_transcript_object(key, {"event": "user", "chat_id": "fork", "text": "new branch"})

    out = build_webui_thread_response(key)

    assert out is not None
    assert [m["content"] for m in out["messages"]] == ["round1", "answer1", "new branch"]
    assert out["fork_boundary_message_count"] == 2


def test_nested_fork_drops_inherited_fork_marker(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    source = "websocket:source"
    for ev in (
        {"event": "user", "chat_id": "source", "text": "round1"},
        {"event": "message", "chat_id": "source", "text": "answer1"},
    ):
        append_transcript_object(source, ev)
    append_fork_marker(source)
    for ev in (
        {"event": "user", "chat_id": "source", "text": "round2"},
        {"event": "message", "chat_id": "source", "text": "answer2"},
    ):
        append_transcript_object(source, ev)

    ok = fork_transcript_before_user_index(source, "websocket:nested", 2)
    append_fork_marker("websocket:nested")

    lines = read_transcript_lines("websocket:nested")
    out = build_webui_thread_response("websocket:nested")

    assert ok is True
    assert [line.get("event") for line in lines] == [
        "user",
        "message",
        "user",
        "message",
        "fork_marker",
    ]
    assert out is not None
    assert [m["content"] for m in out["messages"]] == ["round1", "answer1", "round2", "answer2"]
    assert out["fork_boundary_message_count"] == 4


def test_write_session_messages_as_transcript_builds_canonical_prefix(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)

    write_session_messages_as_transcript(
        "websocket:fork",
        [
            {"role": "user", "content": "round1"},
            {"role": "assistant", "content": "answer1"},
        ],
    )

    lines = read_transcript_lines("websocket:fork")
    assert lines == [
        {"event": "user", "chat_id": "fork", "text": "round1"},
        {"event": "message", "chat_id": "fork", "text": "answer1"},
    ]
    msgs = replay_transcript_to_ui_messages(lines)
    assert [m["content"] for m in msgs] == ["round1", "answer1"]


def test_replay_delta_and_turn_end(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t2"
    for ev in (
        {"event": "user", "chat_id": "t2", "text": "q"},
        {"event": "reasoning_delta", "chat_id": "t2", "text": "think"},
        {"event": "reasoning_end", "chat_id": "t2"},
        {"event": "delta", "chat_id": "t2", "text": "a"},
        {"event": "stream_end", "chat_id": "t2"},
        {
            "event": "turn_end",
            "chat_id": "t2",
            "latency_ms": 42,
            "usage": {"context_tokens": 42000, "context_pct": 42},
        },
    ):
        append_transcript_object(key, ev)
    lines = read_transcript_lines(key)
    msgs = replay_transcript_to_ui_messages(lines)
    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"] == "q"
    assert msgs[1]["role"] == "assistant"
    assert msgs[1]["content"] == "a"
    assert msgs[1]["reasoning"] == "think"
    assert msgs[1]["latencyMs"] == 42
    assert msgs[1]["usage"] == {"context_tokens": 42000, "context_pct": 42}


def test_replay_usage_ignores_later_unscoped_assistant_message() -> None:
    msgs = replay_transcript_to_ui_messages(
        [
            {
                "event": "message",
                "chat_id": "inbox:unified",
                "text": "Local answer",
                "turn_id": "local-turn",
            },
            {
                "event": "message",
                "chat_id": "inbox:unified",
                "text": "Heartbeat answer",
            },
            {
                "event": "turn_end",
                "chat_id": "inbox:unified",
                "turn_id": "local-turn",
                "usage": {"context_tokens": 42000, "context_pct": 42},
            },
        ]
    )

    assert msgs[0]["usage"]["context_pct"] == 42
    assert "usage" not in msgs[1]


def test_replay_uses_persisted_created_at_ms() -> None:
    msgs = replay_transcript_to_ui_messages(
        [
            {
                "event": "user",
                "chat_id": "t-created-at",
                "text": "q",
                "created_at_ms": 1_700_000_000_000,
            },
            {
                "event": "message",
                "chat_id": "t-created-at",
                "kind": "tool_hint",
                "text": "exec()",
                "created_at_ms": 1_700_000_230_000,
            },
        ],
    )

    assert [message["createdAt"] for message in msgs] == [
        1_700_000_000_000,
        1_700_000_230_000,
    ]


def test_thread_response_does_not_mark_completed_message_tool_tail_pending(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:cron-tail"
    turn_id = "cron:job:run"
    for ev in (
        {
            "event": "message",
            "chat_id": "cron-tail",
            "text": 'message({"content":"Cron test"})',
            "kind": "tool_hint",
            "tool_events": [{
                "phase": "start",
                "call_id": "call-message",
                "name": "message",
                "arguments": {"content": "Cron test"},
            }],
            "turn_id": turn_id,
            "turn_phase": "activity",
            "turn_seq": 5,
        },
        {
            "event": "message",
            "chat_id": "cron-tail",
            "text": "Cron test",
            "source": {"kind": "cron", "label": "one-min-test"},
            "turn_id": turn_id,
            "turn_phase": "answer",
            "turn_seq": 6,
        },
        {
            "event": "message",
            "chat_id": "cron-tail",
            "text": "",
            "kind": "progress",
            "tool_events": [{
                "phase": "end",
                "call_id": "call-message",
                "name": "message",
                "arguments": {"content": "Cron test"},
                "result": "ok",
            }],
            "turn_id": turn_id,
            "turn_phase": "activity",
            "turn_seq": 7,
        },
        {
            "event": "turn_end",
            "chat_id": "cron-tail",
            "turn_id": turn_id,
            "turn_phase": "complete",
            "turn_seq": 8,
        },
    ):
        append_transcript_object(key, ev)

    out = build_webui_thread_response(key)

    assert out is not None
    assert out["has_pending_tool_calls"] is False
    assert out["messages"][-1]["kind"] == "trace"
    assert out["messages"][-2]["content"] == "Cron test"


def test_thread_response_marks_unfinished_tool_tail_pending(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:active-tail"
    append_transcript_object(
        key,
        {
            "event": "message",
            "chat_id": "active-tail",
            "text": 'exec({"command":"date"})',
            "kind": "tool_hint",
        },
    )

    out = build_webui_thread_response(key)

    assert out is not None
    assert out["has_pending_tool_calls"] is True


def test_replay_preserves_turn_metadata(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-turn"
    for ev in (
        {
            "event": "user",
            "chat_id": "t-turn",
            "text": "q",
            "turn_id": "turn-1",
            "turn_phase": "user",
            "turn_seq": 1,
        },
        {
            "event": "reasoning_delta",
            "chat_id": "t-turn",
            "text": "think",
            "turn_id": "turn-1",
            "turn_phase": "reasoning",
            "turn_seq": 2,
        },
        {
            "event": "delta",
            "chat_id": "t-turn",
            "text": "a",
            "turn_id": "turn-1",
            "turn_phase": "answer",
            "turn_seq": 3,
        },
        {
            "event": "turn_end",
            "chat_id": "t-turn",
            "latency_ms": 12,
            "turn_id": "turn-1",
            "turn_phase": "complete",
            "turn_seq": 4,
        },
    ):
        append_transcript_object(key, ev)

    msgs = replay_transcript_to_ui_messages(read_transcript_lines(key))

    assert msgs[0]["turnId"] == "turn-1"
    assert msgs[0]["turnPhase"] == "user"
    assert msgs[0]["turnSeq"] == 1
    assert msgs[1]["turnId"] == "turn-1"
    assert msgs[1]["turnPhase"] == "answer"
    assert msgs[1]["turnSeq"] == 3


def test_replay_reused_turn_id_after_turn_end_starts_new_turn(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-reused-turn"

    def event(
        event: str,
        phase: str,
        seq: int,
        text: str | None = None,
        source: dict[str, str] | None = None,
    ) -> dict[str, object]:
        out = {
            "event": event,
            "chat_id": "t-reused-turn",
            "turn_id": "turn-1",
            "turn_phase": phase,
            "turn_seq": seq,
        }
        if text is not None:
            out["text"] = text
        if source is not None:
            out["source"] = source
        return out

    for record in (
        event("user", "user", 1, "remind me later"),
        event("message", "answer", 2, "Reminder set."),
        event("turn_end", "complete", 3),
        event(
            "message", "answer", 1, "Time to drink water.",
            {"kind": "cron", "label": "drink water"},
        ),
        event("turn_end", "complete", 2),
    ):
        append_transcript_object(key, record)

    msgs = replay_transcript_to_ui_messages(read_transcript_lines(key))

    assert [m["content"] for m in msgs] == [
        "remind me later",
        "Reminder set.",
        "Time to drink water.",
    ]
    assert msgs[1]["turnId"] == "turn-1"
    assert msgs[2]["turnId"].startswith("turn-1:replay:")
    assert msgs[2]["turnId"] != msgs[1]["turnId"]
    assert msgs[2]["source"] == {"kind": "cron", "label": "drink water"}


def test_replay_preserves_local_trigger_source_metadata(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-local-trigger-source"
    append_transcript_object(
        key,
        {
            "event": "message",
            "chat_id": "t-local-trigger-source",
            "text": "PR #4502 review started.",
            "source": {"kind": "local_trigger", "label": "PR review"},
        },
    )

    msgs = replay_transcript_to_ui_messages(read_transcript_lines(key))

    assert msgs[0]["source"] == {"kind": "local_trigger", "label": "PR review"}


def test_replay_preserves_legacy_trigger_source_metadata(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-trigger-source"
    append_transcript_object(
        key,
        {
            "event": "message",
            "chat_id": "t-trigger-source",
            "text": "PR #4502 review started.",
            "source": {"kind": "trigger", "label": "PR review"},
        },
    )

    msgs = replay_transcript_to_ui_messages(read_transcript_lines(key))

    assert msgs[0]["source"] == {"kind": "trigger", "label": "PR review"}


def test_build_response_restores_session_users_for_legacy_transcript(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:legacy-users"
    append_transcript_object(
        key,
        {"event": "message", "chat_id": "legacy-users", "text": "assistant one"},
    )
    append_transcript_object(key, {"event": "turn_end", "chat_id": "legacy-users"})
    append_transcript_object(
        key,
        {"event": "message", "chat_id": "legacy-users", "text": "assistant two"},
    )
    append_transcript_object(key, {"event": "turn_end", "chat_id": "legacy-users"})

    out = build_webui_thread_response(
        key,
        session_messages=[
            {"role": "user", "content": "prompt one", "timestamp": "2026-06-02T10:00:00"},
            {"role": "assistant", "content": "assistant one"},
            {"role": "user", "content": "prompt two", "timestamp": "2026-06-02T10:01:00"},
            {"role": "assistant", "content": "assistant two"},
        ],
    )

    assert out is not None
    assert [(m["role"], m["content"]) for m in out["messages"]] == [
        ("user", "prompt one"),
        ("assistant", "assistant one"),
        ("user", "prompt two"),
        ("assistant", "assistant two"),
    ]


def test_build_response_restores_session_users_without_duplicating_new_transcript_users(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:mixed-users"
    append_transcript_object(
        key,
        {"event": "message", "chat_id": "mixed-users", "text": "old assistant"},
    )
    append_transcript_object(key, {"event": "turn_end", "chat_id": "mixed-users"})
    append_transcript_object(key, {"event": "user", "chat_id": "mixed-users", "text": "new prompt"})
    append_transcript_object(
        key,
        {"event": "message", "chat_id": "mixed-users", "text": "new assistant"},
    )
    append_transcript_object(key, {"event": "turn_end", "chat_id": "mixed-users"})

    out = build_webui_thread_response(
        key,
        session_messages=[
            {"role": "user", "content": "old prompt"},
            {"role": "assistant", "content": "old assistant"},
            {"role": "user", "content": "new prompt"},
            {"role": "assistant", "content": "new assistant"},
        ],
    )

    assert out is not None
    assert [(m["role"], m["content"]) for m in out["messages"]] == [
        ("user", "old prompt"),
        ("assistant", "old assistant"),
        ("user", "new prompt"),
        ("assistant", "new assistant"),
    ]


def test_replay_augments_assistant_text() -> None:
    msgs = replay_transcript_to_ui_messages(
        [
            {"event": "user", "chat_id": "t-img", "text": "draw"},
            {"event": "delta", "chat_id": "t-img", "text": "![Diagram](diagram.png)"},
            {"event": "stream_end", "chat_id": "t-img"},
        ],
        augment_assistant_text=lambda text: text.replace("diagram.png", "/api/media/sig/payload"),
    )

    assert msgs[1]["content"] == "![Diagram](/api/media/sig/payload)"


def test_replay_uses_stream_end_final_text() -> None:
    msgs = replay_transcript_to_ui_messages(
        [
            {"event": "user", "chat_id": "t-img", "text": "draw"},
            {"event": "stream_end", "chat_id": "t-img", "text": "![Diagram](/api/media/sig/payload)"},
        ],
    )

    assert msgs[1]["content"] == "![Diagram](/api/media/sig/payload)"


def test_build_response_backfills_legacy_sse_only_transcripts(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-legacy"
    for ev in (
        {"event": "delta", "chat_id": "t-legacy", "text": "first answer"},
        {"event": "stream_end", "chat_id": "t-legacy"},
        {"event": "turn_end", "chat_id": "t-legacy"},
        {"event": "message", "chat_id": "t-legacy", "text": "second answer"},
        {"event": "turn_end", "chat_id": "t-legacy"},
    ):
        append_transcript_object(key, ev)

    out = build_webui_thread_response(
        key,
        session_messages=[
            {"role": "user", "content": "first question"},
            {"role": "assistant", "content": "first answer"},
            {"role": "user", "content": "second question"},
            {"role": "assistant", "content": "second answer"},
        ],
    )

    assert out is not None
    assert [message["role"] for message in out["messages"]] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]
    assert [message["content"] for message in out["messages"]] == [
        "first question",
        "first answer",
        "second question",
        "second answer",
    ]


def test_backfill_does_not_duplicate_existing_user_transcript(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-current"
    for ev in (
        {"event": "user", "chat_id": "t-current", "text": "already stored"},
        {"event": "message", "chat_id": "t-current", "text": "answer"},
        {"event": "turn_end", "chat_id": "t-current"},
    ):
        append_transcript_object(key, ev)

    out = build_webui_thread_response(
        key,
        session_messages=[{"role": "user", "content": "already stored"}],
    )

    assert out is not None
    assert [message["role"] for message in out["messages"]] == ["user", "assistant"]
    assert out["messages"][0]["content"] == "already stored"


def test_backfill_does_not_misalign_when_session_only_has_transcript_tail(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-tail"
    for ev in (
        {"event": "message", "chat_id": "t-tail", "text": "old answer"},
        {"event": "turn_end", "chat_id": "t-tail"},
        {"event": "message", "chat_id": "t-tail", "text": "tail answer"},
        {"event": "turn_end", "chat_id": "t-tail"},
    ):
        append_transcript_object(key, ev)

    out = build_webui_thread_response(
        key,
        session_messages=[
            {"role": "user", "content": "tail question"},
            {"role": "assistant", "content": "tail answer"},
        ],
    )

    assert out is not None
    assert [message["role"] for message in out["messages"]] == [
        "assistant",
        "user",
        "assistant",
    ]
    assert [message["content"] for message in out["messages"]] == [
        "old answer",
        "tail question",
        "tail answer",
    ]


def test_backfill_skips_internal_subagent_results(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-subagent"
    for ev in (
        {"event": "message", "chat_id": "t-subagent", "text": "summary one"},
        {"event": "turn_end", "chat_id": "t-subagent"},
        {"event": "message", "chat_id": "t-subagent", "text": "summary two"},
        {"event": "turn_end", "chat_id": "t-subagent"},
    ):
        append_transcript_object(key, ev)

    legacy_raw = (
        "[Subagent 'legacy' completed successfully]\n\n"
        "Task: t\n\n"
        "Result:\nr\n\n"
        "Summarize this naturally for the user."
    )
    out = build_webui_thread_response(
        key,
        session_messages=[
            {"role": "user", "content": legacy_raw},
            {"role": "assistant", "content": "summary one"},
            {
                "role": "user",
                "content": "marked result",
                HIDDEN_HISTORY_META: {
                    "kind": "subagent_result",
                    "subagent_task_id": "sub-1",
                },
            },
            {"role": "assistant", "content": "summary two"},
        ],
    )

    assert out is not None
    assert [(message["role"], message["content"]) for message in out["messages"]] == [
        ("assistant", "summary one"),
        ("assistant", "summary two"),
    ]


def test_replay_infers_video_media_from_attachment_name() -> None:
    msgs = replay_transcript_to_ui_messages(
        [
            {"event": "user", "chat_id": "t-video", "text": "render"},
            {
                "event": "message",
                "chat_id": "t-video",
                "text": "video ready",
                "media_urls": [{"url": "/api/media/sig/payload", "name": "intro.mp4"}],
            },
        ],
    )

    assert msgs[1]["media"] == [
        {"kind": "video", "url": "/api/media/sig/payload", "name": "intro.mp4"},
    ]


def test_replay_infers_audio_media_from_attachment_name() -> None:
    msgs = replay_transcript_to_ui_messages(
        [
            {"event": "user", "chat_id": "t-audio", "text": "speak"},
            {
                "event": "message",
                "chat_id": "t-audio",
                "text": "audio ready",
                "media_urls": [{"url": "/api/media/sig/audio", "name": "reply.mp3"}],
            },
        ],
    )

    assert msgs[1]["media"] == [
        {"kind": "audio", "url": "/api/media/sig/audio", "name": "reply.mp3"},
    ]


def test_replay_resigns_assistant_media_paths_before_stale_urls() -> None:
    msgs = replay_transcript_to_ui_messages(
        [
            {"event": "user", "chat_id": "t-video-resign", "text": "render"},
            {
                "event": "message",
                "chat_id": "t-video-resign",
                "text": "video ready",
                "media": ["/tmp/intro.mp4"],
                "media_urls": [{"url": "/api/media/old-sig/old-payload", "name": "intro.mp4"}],
            },
        ],
        augment_assistant_media=lambda paths: [
            {"kind": "video", "url": f"/api/media/new-sig/{paths[0].split('/')[-1]}", "name": "intro.mp4"},
        ],
    )

    assert msgs[1]["media"] == [
        {"kind": "video", "url": "/api/media/new-sig/intro.mp4", "name": "intro.mp4"},
    ]


def test_replay_infers_svg_media_from_attachment_name() -> None:
    msgs = replay_transcript_to_ui_messages(
        [
            {"event": "user", "chat_id": "t-svg", "text": "send svg"},
            {
                "event": "message",
                "chat_id": "t-svg",
                "text": "chart ready",
                "media_urls": [{"url": "/api/media/sig/payload", "name": "chart.svg"}],
            },
        ],
    )

    assert msgs[1]["media"] == [
        {"kind": "image", "url": "/api/media/sig/payload", "name": "chart.svg"},
    ]


def test_replay_infers_file_media_from_attachment_name() -> None:
    msgs = replay_transcript_to_ui_messages(
        [
            {"event": "user", "chat_id": "t-file-media", "text": "send html"},
            {
                "event": "message",
                "chat_id": "t-file-media",
                "text": "file ready",
                "media_urls": [{"url": "/api/media/sig/payload", "name": "index.html"}],
            },
        ],
    )

    assert msgs[1]["media"] == [
        {"kind": "file", "url": "/api/media/sig/payload", "name": "index.html"},
    ]


def test_replay_file_edit_event_creates_file_activity(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-file"
    for ev in (
        {"event": "user", "chat_id": "t-file", "text": "edit"},
        {
            "event": "message",
            "chat_id": "t-file",
            "text": 'write_file({"path":"foo.txt"})',
            "kind": "tool_hint",
        },
        {
            "event": "file_edit",
            "chat_id": "t-file",
            "edits": [
                {
                    "version": 1,
                    "call_id": "call-write",
                    "tool": "write_file",
                    "path": "foo.txt",
                    "phase": "end",
                    "added": 2,
                    "deleted": 1,
                    "approximate": False,
                    "status": "done",
                },
            ],
        },
    ):
        append_transcript_object(key, ev)

    msgs = replay_transcript_to_ui_messages(read_transcript_lines(key))

    assert len(msgs) == 3
    assert msgs[1]["kind"] == "trace"
    assert msgs[1]["traces"] == ['write_file({"path":"foo.txt"})']
    assert "fileEdits" not in msgs[1]
    assert msgs[2]["kind"] == "trace"
    assert msgs[2]["traces"] == []
    assert msgs[2]["fileEdits"] == [
        {
            "version": 1,
            "call_id": "call-write",
            "tool": "write_file",
            "path": "foo.txt",
            "phase": "end",
            "added": 2,
            "deleted": 1,
            "approximate": False,
            "status": "done",
        },
    ]
    assert msgs[2]["activitySegmentId"]
    assert msgs[2]["activitySegmentId"] != msgs[1]["activitySegmentId"]


def test_replay_file_edit_absorbs_matching_write_tool_event() -> None:
    msgs = replay_transcript_to_ui_messages([
        {
            "event": "message",
            "chat_id": "t-file",
            "text": 'write_file({"path":"foo.txt"})',
            "kind": "tool_hint",
            "tool_events": [
                {
                    "phase": "start",
                    "call_id": "call-write",
                    "name": "write_file",
                    "arguments": {"path": "foo.txt", "content": "hello\n"},
                },
            ],
        },
        {
            "event": "file_edit",
            "chat_id": "t-file",
            "edits": [
                {
                    "version": 1,
                    "call_id": "call-write",
                    "tool": "write_file",
                    "path": "foo.txt",
                    "phase": "start",
                    "added": 1,
                    "deleted": 0,
                    "approximate": True,
                    "status": "editing",
                },
            ],
        },
        {
            "event": "message",
            "chat_id": "t-file",
            "text": "",
            "kind": "progress",
            "tool_events": [
                {
                    "phase": "end",
                    "call_id": "call-write",
                    "name": "write_file",
                    "arguments": {"path": "foo.txt", "content": "hello\n"},
                    "result": "ok",
                },
            ],
        },
    ])

    assert len(msgs) == 1
    assert msgs[0]["kind"] == "trace"
    assert msgs[0]["traces"] == []
    assert "toolEvents" not in msgs[0]
    assert msgs[0]["fileEdits"] == [
        {
            "version": 1,
            "call_id": "call-write",
            "tool": "write_file",
            "path": "foo.txt",
            "phase": "start",
            "added": 1,
            "deleted": 0,
            "approximate": True,
            "status": "editing",
        },
    ]


def test_replay_file_edit_stays_separate_from_mixed_tool_trace() -> None:
    msgs = replay_transcript_to_ui_messages([
        {
            "event": "message",
            "chat_id": "t-file",
            "text": "",
            "kind": "tool_hint",
            "tool_events": [
                {
                    "phase": "start",
                    "call_id": "call-read",
                    "name": "read_file",
                    "arguments": {"path": "quicksort.py"},
                },
                {
                    "phase": "start",
                    "call_id": "call-write",
                    "name": "write_file",
                    "arguments": {"path": "sorting/quicksort.py", "content": "def quicksort():\n"},
                },
            ],
        },
        {
            "event": "file_edit",
            "chat_id": "t-file",
            "edits": [
                {
                    "version": 1,
                    "call_id": "call-write",
                    "tool": "write_file",
                    "path": "sorting/quicksort.py",
                    "phase": "end",
                    "added": 3,
                    "deleted": 0,
                    "approximate": False,
                    "status": "done",
                },
            ],
        },
    ])

    assert len(msgs) == 2
    assert msgs[0]["kind"] == "trace"
    assert msgs[0]["traces"] == ['read_file({"path": "quicksort.py"})']
    assert [event["name"] for event in msgs[0]["toolEvents"]] == ["read_file"]
    assert "fileEdits" not in msgs[0]
    assert msgs[1]["kind"] == "trace"
    assert msgs[1]["traces"] == []
    assert "toolEvents" not in msgs[1]
    assert msgs[1]["fileEdits"] == [
        {
            "version": 1,
            "call_id": "call-write",
            "tool": "write_file",
            "path": "sorting/quicksort.py",
            "phase": "end",
            "added": 3,
            "deleted": 0,
            "approximate": False,
            "status": "done",
        },
    ]


def test_replay_keeps_every_file_from_one_apply_patch_call() -> None:
    msgs = replay_transcript_to_ui_messages([
        {
            "event": "message",
            "chat_id": "t-file",
            "text": "apply_patch()",
            "kind": "tool_hint",
            "tool_events": [
                {
                    "phase": "start",
                    "call_id": "call-patch",
                    "name": "apply_patch",
                    "arguments": {"edits": []},
                },
            ],
        },
        {
            "event": "file_edit",
            "chat_id": "t-file",
            "edits": [
                {
                    "version": 1,
                    "call_id": "call-patch",
                    "tool": "apply_patch",
                    "path": "USER.md",
                    "phase": "end",
                    "added": 0,
                    "deleted": 3,
                    "approximate": False,
                    "status": "done",
                },
                {
                    "version": 1,
                    "call_id": "call-patch",
                    "tool": "apply_patch",
                    "path": "MEMORY.md",
                    "phase": "end",
                    "added": 0,
                    "deleted": 4,
                    "approximate": False,
                    "status": "done",
                },
            ],
        },
    ])

    assert len(msgs) == 1
    assert msgs[0]["traces"] == []
    assert "toolEvents" not in msgs[0]
    assert [edit["path"] for edit in msgs[0]["fileEdits"]] == ["USER.md", "MEMORY.md"]


def test_replay_keeps_interrupted_pre_tool_text_in_activity() -> None:
    msgs = replay_transcript_to_ui_messages([
        {"event": "delta", "chat_id": "t-stream", "text": "I will inspect first."},
        {"event": "stream_end", "chat_id": "t-stream"},
        {
            "event": "message",
            "chat_id": "t-stream",
            "text": 'exec({"cmd":"ls"})',
            "kind": "tool_hint",
        },
        {
            "event": "stream_end",
            "chat_id": "t-stream",
            "text": "Done. Open index.html to play.",
        },
    ])

    assert len(msgs) == 3
    assert msgs[0]["role"] == "assistant"
    assert msgs[0]["content"] == ""
    assert msgs[0]["reasoning"] == "I will inspect first."
    assert "isStreaming" not in msgs[0]
    assert msgs[1]["kind"] == "trace"
    assert msgs[1]["traces"] == ['exec({"cmd":"ls"})']
    assert msgs[2]["role"] == "assistant"
    assert msgs[2]["content"] == "Done. Open index.html to play."


def test_replay_tool_events_dedupes_finish_after_start() -> None:
    msgs = replay_transcript_to_ui_messages([
        {
            "event": "message",
            "chat_id": "t-tool",
            "text": 'exec({"cmd":"ls"})',
            "kind": "tool_hint",
            "tool_events": [
                {
                    "phase": "start",
                    "call_id": "call-exec",
                    "name": "exec",
                    "arguments": {"cmd": "ls"},
                },
            ],
        },
        {
            "event": "message",
            "chat_id": "t-tool",
            "text": "",
            "kind": "progress",
            "tool_events": [
                {
                    "phase": "end",
                    "call_id": "call-exec",
                    "name": "exec",
                    "arguments": {"cmd": "ls"},
                    "result": "ok",
                },
                {
                    "phase": "end",
                    "call_id": "call-read",
                    "name": "read_file",
                    "arguments": {"path": "notes.md"},
                    "result": "done",
                },
            ],
        },
    ])

    assert len(msgs) == 1
    assert msgs[0]["traces"] == [
        'exec({"cmd": "ls"})',
        'read_file({"path": "notes.md"})',
    ]
    assert msgs[0]["toolEvents"][0]["phase"] == "end"
    assert msgs[0]["toolEvents"][0]["call_id"] == "call-exec"


def test_replay_tool_events_keeps_phase_update_when_trace_is_deduped() -> None:
    args = {"name": "github", "args": ["repo", "view"], "json": "true"}
    msgs = replay_transcript_to_ui_messages([
        {
            "event": "message",
            "chat_id": "t-tool",
            "text": "",
            "kind": "tool_hint",
            "tool_events": [
                {
                    "phase": "start",
                    "call_id": "call-cli",
                    "name": "run_cli_app",
                    "arguments": args,
                },
            ],
        },
        {
            "event": "message",
            "chat_id": "t-tool",
            "text": "",
            "kind": "progress",
            "tool_events": [
                {
                    "phase": "error",
                    "call_id": "call-cli",
                    "name": "run_cli_app",
                    "arguments": args,
                    "error": "Error: CLI app 'github' not found",
                },
            ],
        },
    ])

    assert len(msgs) == 1
    assert msgs[0]["traces"] == [
        'run_cli_app({"name": "github", "args": ["repo", "view"], "json": "true"})',
    ]
    assert msgs[0]["toolEvents"][0]["phase"] == "error"
    assert msgs[0]["toolEvents"][0]["error"] == "Error: CLI app 'github' not found"


def test_replay_file_edit_progress_merges_after_interleaved_activity(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-file-progress"
    for ev in (
        {"event": "user", "chat_id": "t-file-progress", "text": "edit"},
        {
            "event": "message",
            "chat_id": "t-file-progress",
            "text": 'write_file({"path":"foo.txt"})',
            "kind": "tool_hint",
        },
        {
            "event": "file_edit",
            "chat_id": "t-file-progress",
            "edits": [
                {
                    "version": 1,
                    "call_id": "call-write",
                    "tool": "write_file",
                    "path": "foo.txt",
                    "phase": "start",
                    "added": 12,
                    "deleted": 0,
                    "approximate": True,
                    "status": "editing",
                },
            ],
        },
        {
            "event": "message",
            "chat_id": "t-file-progress",
            "text": "still working",
            "kind": "progress",
        },
        {
            "event": "file_edit",
            "chat_id": "t-file-progress",
            "edits": [
                {
                    "version": 1,
                    "call_id": "call-write",
                    "tool": "write_file",
                    "path": "foo.txt",
                    "phase": "end",
                    "added": 30,
                    "deleted": 0,
                    "approximate": False,
                    "status": "done",
                },
            ],
        },
    ):
        append_transcript_object(key, ev)

    msgs = replay_transcript_to_ui_messages(read_transcript_lines(key))
    file_edit_messages = [msg for msg in msgs if msg.get("fileEdits")]

    assert len(file_edit_messages) == 1
    assert file_edit_messages[0]["fileEdits"] == [
        {
            "version": 1,
            "call_id": "call-write",
            "tool": "write_file",
            "path": "foo.txt",
            "phase": "end",
            "added": 30,
            "deleted": 0,
            "approximate": False,
            "status": "done",
        },
    ]


def test_replay_file_edit_pending_placeholder_upgrades_to_path(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-file-pending"
    for ev in (
        {"event": "user", "chat_id": "t-file-pending", "text": "write"},
        {
            "event": "file_edit",
            "chat_id": "t-file-pending",
            "edits": [
                {
                    "version": 1,
                    "call_id": "call-write",
                    "tool": "write_file",
                    "path": "",
                    "phase": "start",
                    "added": 1,
                    "deleted": 0,
                    "approximate": True,
                    "status": "editing",
                    "pending": True,
                },
            ],
        },
        {
            "event": "file_edit",
            "chat_id": "t-file-pending",
            "edits": [
                {
                    "version": 1,
                    "call_id": "call-write",
                    "tool": "write_file",
                    "path": "foo.txt",
                    "phase": "start",
                    "added": 12,
                    "deleted": 0,
                    "approximate": True,
                    "status": "editing",
                },
            ],
        },
    ):
        append_transcript_object(key, ev)

    msgs = replay_transcript_to_ui_messages(read_transcript_lines(key))
    file_edit_messages = [msg for msg in msgs if msg.get("fileEdits")]

    assert len(file_edit_messages) == 1
    assert file_edit_messages[0]["fileEdits"] == [
        {
            "version": 1,
            "call_id": "call-write",
            "tool": "write_file",
            "path": "foo.txt",
            "phase": "start",
            "added": 12,
            "deleted": 0,
            "approximate": True,
            "status": "editing",
        },
    ]


def test_replay_keeps_new_file_edit_after_reasoning_in_order(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-file-order"
    for ev in (
        {"event": "user", "chat_id": "t-file-order", "text": "edit"},
        {
            "event": "file_edit",
            "chat_id": "t-file-order",
            "edits": [
                {
                    "version": 1,
                    "call_id": "call-one",
                    "tool": "write_file",
                    "path": "one.txt",
                    "phase": "start",
                    "added": 10,
                    "deleted": 0,
                    "approximate": True,
                    "status": "editing",
                },
            ],
        },
        {"event": "reasoning_delta", "chat_id": "t-file-order", "text": "Check next."},
        {"event": "reasoning_end", "chat_id": "t-file-order"},
        {
            "event": "file_edit",
            "chat_id": "t-file-order",
            "edits": [
                {
                    "version": 1,
                    "call_id": "call-two",
                    "tool": "write_file",
                    "path": "two.txt",
                    "phase": "start",
                    "added": 20,
                    "deleted": 0,
                    "approximate": True,
                    "status": "editing",
                },
            ],
        },
    ):
        append_transcript_object(key, ev)

    msgs = replay_transcript_to_ui_messages(read_transcript_lines(key))

    assert [msg.get("fileEdits", [{}])[0].get("path") if msg.get("fileEdits") else msg.get("reasoning") for msg in msgs[1:]] == [
        "one.txt",
        "Check next.",
        "two.txt",
    ]
    file_edit_segments = [
        msg.get("activitySegmentId")
        for msg in msgs
        if msg.get("fileEdits")
    ]
    assert len(file_edit_segments) == 2
    assert file_edit_segments[0] != file_edit_segments[1]


def test_build_response_schema(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t3"
    append_transcript_object(key, {"event": "user", "chat_id": "t3", "text": "x"})
    out = build_webui_thread_response(key)
    assert out is not None
    assert out["schemaVersion"] == WEBUI_TRANSCRIPT_SCHEMA_VERSION
    assert out["sessionKey"] == key
    assert len(out["messages"]) == 1


def test_session_messages_to_wire_events_marks_channel_delivery() -> None:
    from nanobot.webui.transcript import session_messages_to_wire_events

    events = session_messages_to_wire_events([
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "reply"},
        {"role": "assistant", "content": "morning", "_channel_delivery": True},
    ])
    delivery = [
        event for event in events
        if event.get("event") == "message" and event.get("channel_delivery")
    ]
    assert len(delivery) == 1
    assert delivery[0]["text"] == "morning"


def test_session_messages_to_wire_events_includes_cron_job_source() -> None:
    from nanobot.webui.transcript import session_messages_to_wire_events

    events = session_messages_to_wire_events([
        {
            "role": "assistant",
            "content": "记得喝水",
            "_channel_delivery": True,
            "_cron_job_id": "job-1",
            "_cron_job_name": "喝水提醒",
        },
    ])
    message = next(event for event in events if event.get("event") == "message")
    assert message["channel_delivery"] is True
    assert message["cron_job_id"] == "job-1"
    assert message["cron_job_name"] == "喝水提醒"


def test_replay_channel_delivery_preserves_cron_job_source() -> None:
    msgs = replay_transcript_to_ui_messages([
        {
            "event": "message",
            "chat_id": "x",
            "text": "记得喝水",
            "channel_delivery": True,
            "cron_job_id": "job-1",
            "cron_job_name": "喝水提醒",
        },
        {"event": "turn_end", "chat_id": "x"},
    ])
    assistant = next(m for m in msgs if m.get("role") == "assistant")
    assert assistant.get("channelDelivery") is True
    assert assistant.get("cronJobId") == "job-1"
    assert assistant.get("cronJobName") == "喝水提醒"


def test_replay_channel_delivery_preserves_ui_flag() -> None:
    msgs = replay_transcript_to_ui_messages([
        {"event": "user", "chat_id": "x", "text": "hi"},
        {"event": "message", "chat_id": "x", "text": "reply"},
        {"event": "message", "chat_id": "x", "text": "morning", "channel_delivery": True},
        {"event": "turn_end", "chat_id": "x"},
    ])
    assistants = [m for m in msgs if m.get("role") == "assistant"]
    assert len(assistants) == 2
    assert assistants[1].get("channelDelivery") is True


def test_session_messages_to_wire_events_marks_user_initiated_delivery() -> None:
    from nanobot.webui.transcript import session_messages_to_wire_events

    events = session_messages_to_wire_events([
        {
            "role": "assistant",
            "content": "测试发图",
            "_channel_delivery": True,
            "source_channel": "qq",
            "source_chat_id": "chat-1",
            "_user_initiated_channel_delivery": True,
        },
    ])
    message = next(event for event in events if event.get("event") == "message")
    assert message["channel_delivery"] is True
    assert message["user_initiated_delivery"] is True
    assert message["source_channel"] == "qq"


def test_unified_history_hides_cron_trigger_and_preserves_reply_source() -> None:
    from nanobot.webui.transcript import session_messages_to_wire_events

    events = session_messages_to_wire_events([
        {
            "role": "user",
            "content": "Scheduled cron job triggered: Daily check",
            AUTOMATION_HISTORY_META: {"kind": "cron"},
            CRON_HISTORY_META: True,
        },
        {
            "role": "assistant",
            "content": "今日检查完成",
            WEBUI_MESSAGE_SOURCE_METADATA_KEY: {
                "kind": "cron",
                "label": "Daily check",
            },
        },
    ])

    assert not any(event.get("event") == "user" for event in events)
    reply = next(event for event in events if event.get("event") == "message")
    assert reply["text"] == "今日检查完成"
    assert reply["source"] == {"kind": "cron", "label": "Daily check"}


def test_unified_history_restores_user_image_attachment() -> None:
    from nanobot.webui.transcript import (
        replay_transcript_to_ui_messages,
        session_messages_to_wire_events,
    )

    events = session_messages_to_wire_events([
        {
            "role": "user",
            "content": "看一下这张图",
            "media": ["/workspace/media/input.png"],
        },
    ])
    messages = replay_transcript_to_ui_messages(
        events,
        augment_user_media=lambda paths: [
            {
                "kind": "image",
                "url": f"/api/media/signed/{Path(path).name}",
                "name": Path(path).name,
            }
            for path in paths
        ],
    )

    assert messages[0]["media"] == [
        {
            "kind": "image",
            "url": "/api/media/signed/input.png",
            "name": "input.png",
        }
    ]
    assert messages[0]["images"] == [
        {"url": "/api/media/signed/input.png", "name": "input.png"}
    ]


def test_replay_preserves_user_initiated_delivery() -> None:
    msgs = replay_transcript_to_ui_messages([
        {
            "event": "message",
            "chat_id": "x",
            "text": "测试发图",
            "source_channel": "qq",
            "channel_delivery": True,
            "user_initiated_delivery": True,
        },
    ])
    assert msgs[0].get("sourceChannel") == "qq"
    assert msgs[0].get("channelDelivery") is True
    assert msgs[0].get("userInitiatedDelivery") is True


def test_replay_preserves_source_channel() -> None:
    msgs = replay_transcript_to_ui_messages([
        {"event": "user", "chat_id": "x", "text": "hi", "source_channel": "qq"},
        {
            "event": "message",
            "chat_id": "x",
            "text": "reply",
            "source_channel": "qq",
            "channel_delivery": True,
        },
    ])
    assert msgs[0].get("sourceChannel") == "qq"
    assert msgs[1].get("sourceChannel") == "qq"
    assert msgs[1].get("channelDelivery") is True


def test_session_messages_to_wire_events_includes_assistant_media() -> None:
    from nanobot.webui.transcript import session_messages_to_wire_events

    events = session_messages_to_wire_events([
        {
            "role": "assistant",
            "content": "早安",
            "_channel_delivery": True,
            "media": ["/tmp/out.png"],
        },
    ])
    message = next(event for event in events if event.get("event") == "message")
    assert message["text"] == "早安"
    assert message["media"] == ["/tmp/out.png"]


def test_session_messages_to_wire_events_keeps_remote_assistant_media_urls() -> None:
    from nanobot.webui.transcript import session_messages_to_wire_events

    events = session_messages_to_wire_events([
        {
            "role": "assistant",
            "content": "",
            "_channel_delivery": True,
            "media": ["https://cdn.example.test/out.png?sig=1"],
        },
    ])
    message = next(event for event in events if event.get("event") == "message")
    assert message["text"] == ""
    assert message["channel_delivery"] is True
    assert message["media_urls"] == [
        {"url": "https://cdn.example.test/out.png?sig=1", "name": "out.png"},
    ]
    assert "media_paths" not in message


def test_replay_assistant_media_paths_uses_augment_callback() -> None:
    msgs = replay_transcript_to_ui_messages(
        [
            {
                "event": "message",
                "chat_id": "x",
                "text": "早安",
                "media": ["/tmp/out.png"],
            },
            {"event": "turn_end", "chat_id": "x"},
        ],
        augment_assistant_media=lambda paths: [
            {"kind": "image", "url": f"/api/media/signed/{Path(p).name}", "name": Path(p).name}
            for p in paths
        ],
    )
    assert len(msgs) == 1
    assert msgs[0]["media"] == [
        {"kind": "image", "url": "/api/media/signed/out.png", "name": "out.png"},
    ]


def test_replay_new_user_clears_assistant_media_suppression() -> None:
    from nanobot.webui.transcript import session_messages_to_wire_events

    events = session_messages_to_wire_events([
        {"role": "user", "content": "draw"},
        {"role": "assistant", "content": "", "media": ["/tmp/out.png"]},
        {"role": "user", "content": "check"},
        {
            "role": "assistant",
            "content": "",
            "reasoning_content": "need inspect",
            "tool_calls": [
                {
                    "id": "call-read",
                    "function": {
                        "name": "read_file",
                        "arguments": '{"path": "notes.md"}',
                    },
                },
            ],
        },
        {"role": "tool", "tool_call_id": "call-read", "name": "read_file", "content": "ok"},
        {"role": "assistant", "content": "done"},
    ])

    msgs = replay_transcript_to_ui_messages(
        events,
        augment_assistant_media=lambda paths: [
            {"kind": "image", "url": f"/api/media/signed/{Path(p).name}", "name": Path(p).name}
            for p in paths
        ],
    )

    traces = [m for m in msgs if m.get("kind") == "trace"]
    assistants = [m for m in msgs if m.get("role") == "assistant" and m.get("kind") != "trace"]
    assert traces
    assert traces[0]["traces"] == ['read_file({"path": "notes.md"})']
    assert assistants[-1]["content"] == "done"
    assert any(message.get("reasoning") == "need inspect" for message in assistants)


def test_replay_channel_delivery_media_keeps_same_turn_tool_trace() -> None:
    from nanobot.webui.transcript import session_messages_to_wire_events

    events = session_messages_to_wire_events([
        {"role": "user", "content": "send image"},
        {
            "role": "assistant",
            "content": "测试发图~",
            "_channel_delivery": True,
            "_user_initiated_channel_delivery": True,
            "source_channel": "qq",
            "source_chat_id": "chat-1",
            "media": ["/tmp/staged.png"],
        },
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call-message",
                    "function": {
                        "name": "message",
                        "arguments": '{"channel": "qq", "chat_id": "chat-1", "content": "测试发图~", "media": ["/tmp/source.png"]}',
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call-message",
            "name": "message",
            "content": "Message sent to qq:chat-1 with 1 attachments",
        },
        {"role": "assistant", "content": "发了"},
    ])

    msgs = replay_transcript_to_ui_messages(
        events,
        augment_assistant_media=lambda paths: [
            {"kind": "image", "url": f"/api/media/signed/{Path(p).name}", "name": Path(p).name}
            for p in paths
        ],
    )

    traces = [m for m in msgs if m.get("kind") == "trace"]
    roles = [(m.get("role"), m.get("kind"), m.get("content")) for m in msgs]
    assert traces
    assert traces[0]["toolEvents"][0]["name"] == "message"
    assert traces[0]["toolEvents"][0]["phase"] == "end"
    assert roles == [
        ("user", None, "send image"),
        ("tool", "trace", traces[0]["content"]),
        ("assistant", None, "测试发图~"),
        ("assistant", None, "发了"),
    ]


def test_replay_multiple_channel_delivery_media_keeps_each_tool_trace_order() -> None:
    from nanobot.webui.transcript import session_messages_to_wire_events

    events = session_messages_to_wire_events([
        {"role": "user", "content": "send images"},
        {
            "role": "assistant",
            "content": "发图 1",
            "_channel_delivery": True,
            "_user_initiated_channel_delivery": True,
            "source_channel": "qq",
            "source_chat_id": "chat-1",
            "media": ["/tmp/staged-1.png"],
        },
        {
            "role": "assistant",
            "content": "发图 2",
            "_channel_delivery": True,
            "_user_initiated_channel_delivery": True,
            "source_channel": "qq",
            "source_chat_id": "chat-1",
            "media": ["/tmp/staged-2.png"],
        },
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call-message-1",
                    "function": {
                        "name": "message",
                        "arguments": (
                            '{"channel": "qq", "chat_id": "chat-1", '
                            '"content": "发图 1", "media": ["/tmp/source-1.png"]}'
                        ),
                    },
                },
                {
                    "id": "call-message-2",
                    "function": {
                        "name": "message",
                        "arguments": (
                            '{"channel": "qq", "chat_id": "chat-1", '
                            '"content": "发图 2", "media": ["/tmp/source-2.png"]}'
                        ),
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call-message-1",
            "name": "message",
            "content": "Message sent to qq:chat-1 with 1 attachments",
        },
        {
            "role": "tool",
            "tool_call_id": "call-message-2",
            "name": "message",
            "content": "Message sent to qq:chat-1 with 1 attachments",
        },
        {"role": "assistant", "content": "都发了"},
    ])

    msgs = replay_transcript_to_ui_messages(
        events,
        augment_assistant_media=lambda paths: [
            {"kind": "image", "url": f"/api/media/signed/{Path(p).name}", "name": Path(p).name}
            for p in paths
        ],
    )

    traces = [m for m in msgs if m.get("kind") == "trace"]
    roles = [(m.get("role"), m.get("kind"), m.get("content")) for m in msgs]
    assert len(traces) == 2
    assert traces[0]["toolEvents"][0]["call_id"] == "call-message-1"
    assert traces[1]["toolEvents"][0]["call_id"] == "call-message-2"
    assert roles == [
        ("user", None, "send images"),
        ("tool", "trace", traces[0]["content"]),
        ("assistant", None, "发图 1"),
        ("tool", "trace", traces[1]["content"]),
        ("assistant", None, "发图 2"),
        ("assistant", None, "都发了"),
    ]


def test_replay_user_remote_media_urls_render_as_attachments() -> None:
    msgs = replay_transcript_to_ui_messages([
        {
            "event": "user",
            "chat_id": "x",
            "text": "see this",
            "media_urls": [{"url": "https://cdn.example.test/input.jpg", "name": "input.jpg"}],
        },
    ])

    assert msgs[0]["media"] == [
        {"kind": "image", "url": "https://cdn.example.test/input.jpg", "name": "input.jpg"},
    ]
    assert msgs[0]["images"] == [
        {"url": "https://cdn.example.test/input.jpg", "name": "input.jpg"},
    ]
