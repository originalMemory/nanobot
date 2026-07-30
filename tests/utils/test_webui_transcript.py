"""Tests for append-only WebUI transcript replay."""

from __future__ import annotations

from pathlib import Path

from nanobot.webui.transcript import (
    WEBUI_TRANSCRIPT_SCHEMA_VERSION,
    append_transcript_object,
    read_transcript_lines,
    replay_transcript_to_ui_messages,
)


def test_append_and_read_roundtrip(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t1"
    append_transcript_object(key, {"event": "user", "chat_id": "t1", "text": "hello"})
    lines = read_transcript_lines(key)
    assert len(lines) == 1
    assert lines[0]["text"] == "hello"


def test_replay_delta_and_turn_end(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t2"
    for ev in (
        {"event": "user", "chat_id": "t2", "text": "q"},
        {"event": "reasoning_delta", "chat_id": "t2", "text": "think"},
        {"event": "reasoning_end", "chat_id": "t2"},
        {"event": "delta", "chat_id": "t2", "text": "a"},
        {"event": "stream_end", "chat_id": "t2"},
        {"event": "turn_end", "chat_id": "t2", "latency_ms": 42},
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


def test_replay_file_edit_keeps_multiple_files_from_one_tool_call(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t-multi-file"
    append_transcript_object(key, {"event": "user", "chat_id": "t-multi-file", "text": "edit"})
    append_transcript_object(
        key,
        {
            "event": "file_edit",
            "chat_id": "t-multi-file",
            "edits": [
                {
                    "call_id": "call-patch",
                    "tool": "apply_patch",
                    "path": "",
                    "pending": True,
                    "status": "editing",
                },
            ],
        },
    )
    append_transcript_object(
        key,
        {
            "event": "file_edit",
            "chat_id": "t-multi-file",
            "edits": [
                {
                    "call_id": "call-patch",
                    "tool": "apply_patch",
                    "path": "src/a.py",
                    "added": 1,
                    "deleted": 0,
                    "status": "done",
                },
                {
                    "call_id": "call-patch",
                    "tool": "apply_patch",
                    "path": "src/b.py",
                    "added": 2,
                    "deleted": 0,
                    "status": "done",
                },
            ],
        },
    )

    messages = replay_transcript_to_ui_messages(read_transcript_lines(key))
    edits = [edit for message in messages for edit in message.get("fileEdits", [])]

    assert [(edit["path"], edit["added"]) for edit in edits] == [
        ("src/a.py", 1),
        ("src/b.py", 2),
    ]
    assert all(not edit.get("pending") for edit in edits)


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
    from nanobot.webui.transcript import build_webui_thread_response

    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:t3"
    append_transcript_object(key, {"event": "user", "chat_id": "t3", "text": "x"})
    out = build_webui_thread_response(key, augment_media_paths=None)
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


def test_session_messages_to_wire_events_includes_assistant_media_paths() -> None:
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
    assert message["media_paths"] == ["/tmp/out.png"]


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
                "media_paths": ["/tmp/out.png"],
            },
            {"event": "turn_end", "chat_id": "x"},
        ],
        augment_media_paths=lambda paths: [
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
        augment_media_paths=lambda paths: [
            {"kind": "image", "url": f"/api/media/signed/{Path(p).name}", "name": Path(p).name}
            for p in paths
        ],
    )

    traces = [m for m in msgs if m.get("kind") == "trace"]
    assistants = [m for m in msgs if m.get("role") == "assistant" and m.get("kind") != "trace"]
    assert traces
    assert traces[0]["traces"] == ['read_file({"path": "notes.md"})']
    assert assistants[-1]["content"] == "done"
    assert assistants[-1]["reasoning"] == "need inspect"


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
        augment_media_paths=lambda paths: [
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
        augment_media_paths=lambda paths: [
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


def test_replay_playback_segment_does_not_attach_without_matching_message_id() -> None:
    msgs = replay_transcript_to_ui_messages([
        {"event": "delta", "chat_id": "x", "text": "old answer", "stream_id": "old"},
        {"event": "stream_end", "chat_id": "x", "stream_id": "old"},
        {
            "event": "assistant_playback_segment",
            "chat_id": "x",
            "segment": {
                "messageId": "new",
                "segmentIndex": 0,
                "rawText": "new answer.",
                "controls": [],
                "audio": {"status": "ready", "url": "/media/new.wav"},
            },
        },
    ])

    assert len(msgs) == 1
    assert msgs[0]["id"] == "old"
    assert "playbackSegments" not in msgs[0]
