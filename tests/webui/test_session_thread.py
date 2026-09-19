"""统一历史只读投影的格式、分页与可见性约束。"""

from copy import deepcopy

from nanobot.runtime_context import RUNTIME_CONTEXT_HISTORY_META
from nanobot.session.automation_turns import AUTOMATION_HISTORY_META
from nanobot.session.history_visibility import HIDDEN_HISTORY_META
from nanobot.webui.transcript import (
    append_transcript_object,
    build_session_thread_response,
    read_recent_transcript_turn_state,
)


def build(messages, **kwargs):
    return build_session_thread_response("websocket:desktop", messages, **kwargs)


def test_session_history_includes_pre_compaction_originals_and_hides_internal_context():
    messages = [
        {"role": "system", "content": "private system"},
        {"role": "user", "content": "以前的问题", "timestamp": "2026-01-01T12:00:00+08:00"},
        {"role": "assistant", "content": "以前的回答"},
        {"role": "user", "content": "hidden checkpoint", HIDDEN_HISTORY_META: True},
        {"role": "user", "content": "最近的问题\n\nprivate context",
         RUNTIME_CONTEXT_HISTORY_META: {"version": 1, "suffix": "private context"}},
        {"role": "assistant", "content": "最近的回答"},
        {"_type": "provider_state", "encrypted_content": "private opaque state"},
    ]
    original = deepcopy(messages)
    result = build(messages)
    assert [m["content"] for m in result["messages"]] == ["以前的问题", "以前的回答", "最近的问题", "最近的回答"]
    assert result["messages"][0]["createdAt"] == 1767240000000
    assert result["sessionKey"] == "websocket:desktop"
    assert messages == original


def test_pagination_preserves_ids_across_append_and_hidden_checkpoint():
    messages = [
        {"role": role, "content": f"{role}-{i}"}
        for i in range(5) for role in ("user", "assistant")
    ]
    latest = build(messages, limit=2)
    older = build(messages, limit=2, before=latest["page"]["before_cursor"])
    assert [m["content"] for m in latest["messages"]] == ["user-4", "assistant-4"]
    assert [m["content"] for m in older["messages"]] == ["user-3", "assistant-3"]
    assert latest["page"]["user_message_offset"] == 4
    assert set(m["id"] for m in latest["messages"]).isdisjoint(m["id"] for m in older["messages"])
    messages.insert(1, {"role": "user", "content": "internal", HIDDEN_HISTORY_META: True})
    messages.extend([{"role": "user", "content": "new"}, {"role": "assistant", "content": "reply"}])
    assert build(messages, limit=2, before=latest["page"]["before_cursor"])["messages"] == older["messages"]
    assert build(messages, before=older["page"]["before_cursor"])["page"]["has_more_before"] is False


def test_history_projects_media_reasoning_and_completed_tools_without_private_binary():
    seen = []

    def media(paths):
        seen.extend(paths)
        return [{"url": "/api/media/signed/image", "kind": "image", "name": "photo.png"}]

    messages = [
        {"role": "user", "content": [{"type": "text", "text": "看图片"}], "media": ["/tmp/photo.png"]},
        {"role": "assistant", "content": "先读取", "reasoning_content": "思考过程",
         "tool_calls": [{"id": "call-1", "function": {"name": "read_file", "arguments": '{"path":"note.md"}'}}]},
        {"role": "tool", "tool_call_id": "call-1", "content": "data:image/png;base64,PRIVATE"},
        {"role": "assistant", "content": "完成"},
    ]
    result = build(messages, augment_user_media=media)
    assert seen == ["/tmp/photo.png"]
    rendered = result["messages"]
    assert rendered[0]["media"][0]["url"] == "/api/media/signed/image"
    assert "思考过程" in str(rendered)
    tools = [tool for msg in rendered for tool in msg.get("toolEvents", [])]
    assert len(tools) == 1
    assert tools[0]["phase"] == "end"
    assert "PRIVATE" not in str(rendered)
    assert "traceDetailsRef" not in str(rendered)
    assert not result["has_pending_tool_calls"]


def test_empty_and_active_session_do_not_require_display_transcripts():
    assert build([])["messages"] == []
    result = build([{"role": "user", "content": "running"}], active_turn_id="turn-1", active_turn_started_at=12)
    assert result["has_pending_tool_calls"]
    assert result["active_turn_id"] == "turn-1"


def test_unified_history_projects_usage_for_composer_meter():
    result = build([
        {"role": "user", "content": "question"},
        {"role": "assistant", "content": "answer",
         "usage": {"prompt_tokens": 1200, "completion_tokens": 80, "context_tokens": 1100},
         "round_usages": [{"prompt_tokens": 700}, {"prompt_tokens": 1200}],
         "context_window_tokens": 32_000},
    ])
    answer = result["messages"][-1]
    assert answer["usage"]["context_tokens"] == 1100
    assert answer["roundUsages"][-1]["prompt_tokens"] == 1200
    assert answer["contextWindowTokens"] == 32_000


def test_unified_history_carries_channel_source_to_assistant():
    result = build([
        {"role": "user", "content": "question", "source_channel": "telegram", "source_chat_id": "1"},
        {"role": "assistant", "content": "answer"},
    ])
    assert result["messages"][-1]["source"] == {"kind": "channel", "label": "telegram"}


def test_unified_history_keeps_automation_as_a_separate_sourced_turn():
    result = build([
        {"role": "user", "content": "question"},
        {"role": "assistant", "content": "answer"},
        {"role": "user", "content": "scheduled", AUTOMATION_HISTORY_META: {
            "kind": "cron", "cron_job_name": "drink water",
        }},
        {"role": "assistant", "content": "scheduled answer"},
    ])
    previous, scheduled = result["messages"][-2:]
    assert previous["content"] == "answer"
    assert scheduled["content"] == "scheduled answer"
    assert scheduled["source"] == {"kind": "cron", "label": "drink water"}


def test_completion_markers_survive_rotation_and_exclude_unfinished_turns(tmp_path, monkeypatch):
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: tmp_path)
    monkeypatch.setattr("nanobot.webui.transcript._ACTIVE_TRANSCRIPT_ROTATE_BYTES", 200)
    monkeypatch.setattr("nanobot.webui.transcript._TARGET_ACTIVE_TRANSCRIPT_BYTES", 100)
    key = "websocket:desktop"
    for index in range(5):
        append_transcript_object(key, {"event": "user", "text": "question", "turn_id": f"turn-{index}"})
        append_transcript_object(key, {"event": "message", "text": "answer", "turn_id": f"turn-{index}"})
        append_transcript_object(key, {"event": "turn_end", "turn_id": f"turn-{index}"})
    completed, pending = read_recent_transcript_turn_state(key)
    assert "turn-4" in completed
    assert not pending
    result = build([{"role": "assistant", "content": "canonical answer"}], completed_turns=completed)
    assert result["completed_turn_ids"] == completed
    assert [message["content"] for message in result["messages"]] == ["canonical answer"]
    assert not build([], completed_turns=completed, active_turn_id="turn-4", active_turn_started_at=12)["has_pending_tool_calls"]
    append_transcript_object(key, {"event": "delta", "text": "partial", "turn_id": "incomplete"})
    completed, pending = read_recent_transcript_turn_state(key)
    assert "incomplete" not in completed
    assert pending
    assert build([], completed_turns=completed, transcript_pending=pending)["has_pending_tool_calls"]
