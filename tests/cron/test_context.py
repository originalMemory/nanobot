"""Tests for unified-session context injection in cron jobs."""

from nanobot.cron.context import build_unified_context_prefix, prepend_unified_context
from nanobot.cron.types import CronJob, CronPayload
from nanobot.session import UNIFIED_SESSION_KEY
from nanobot.session.manager import SessionManager


def _make_unified_session(tmp_path, messages: list[dict]) -> SessionManager:
    manager = SessionManager(tmp_path)
    session = manager.get_or_create(UNIFIED_SESSION_KEY)
    session.messages = messages
    manager.save(session)
    return manager


def test_build_unified_context_prefix_empty_when_not_unified(tmp_path):
    manager = _make_unified_session(
        tmp_path,
        [{"role": "user", "content": "hello", "timestamp": "2026-06-05T14:30:00+08:00"}],
    )

    assert build_unified_context_prefix(
        manager, unified_session=False, max_messages=10,
    ) == ""


def test_build_unified_context_prefix_empty_when_zero_messages(tmp_path):
    manager = SessionManager(tmp_path)

    assert build_unified_context_prefix(
        manager, unified_session=True, max_messages=0,
    ) == ""


def test_build_unified_context_prefix_formats_user_and_assistant(tmp_path):
    manager = _make_unified_session(
        tmp_path,
        [
            {
                "role": "user",
                "content": "帮我盯着今天的天气",
                "timestamp": "2026-06-05T14:30:00+08:00",
                "source_channel": "telegram",
            },
            {
                "role": "assistant",
                "content": "好的",
                "timestamp": "2026-06-05T14:31:00+08:00",
            },
        ],
    )

    prefix = build_unified_context_prefix(
        manager, unified_session=True, max_messages=10,
    )

    assert prefix.startswith("## Recent Conversation")
    assert "[telegram, 14:30] user: 帮我盯着今天的天气" in prefix
    assert "[14:31] assistant: 好的" in prefix


def test_build_unified_context_prefix_uses_get_history_tail(tmp_path):
    """get_history 取未 consolidate 消息的尾部 [-max_messages:]。"""
    manager = SessionManager(tmp_path)
    session = manager.get_or_create(UNIFIED_SESSION_KEY)
    for i in range(5):
        session.add_message("user", f"msg-{i}")
    manager.save(session)

    prefix = build_unified_context_prefix(
        manager, unified_session=True, max_messages=2,
    )

    assert "msg-3" in prefix
    assert "msg-4" in prefix
    assert "msg-0" not in prefix


def test_build_unified_context_prefix_skips_commands_and_tools(tmp_path):
    manager = _make_unified_session(
        tmp_path,
        [
            {"role": "user", "content": "visible", "timestamp": "2026-06-05T14:30:00+08:00"},
            {"role": "user", "content": "/new", "timestamp": "2026-06-05T14:31:00+08:00", "_command": True},
            {"role": "tool", "content": "result", "timestamp": "2026-06-05T14:32:00+08:00"},
        ],
    )

    prefix = build_unified_context_prefix(
        manager, unified_session=True, max_messages=10,
    )

    assert "visible" in prefix
    assert "/new" not in prefix
    assert "result" not in prefix


def test_prepend_unified_context_joins_prompt(tmp_path):
    manager = _make_unified_session(
        tmp_path,
        [{"role": "user", "content": "hello", "timestamp": "2026-06-05T14:30:00+08:00"}],
    )

    result = prepend_unified_context(
        "Do the task",
        manager,
        unified_session=True,
        context_messages=5,
    )

    assert result.startswith("## Recent Conversation")
    assert result.endswith("Do the task")
    assert "\n\n---\n\n" in result


def test_cron_payload_backward_compatible_without_context_messages():
    payload = CronPayload(kind="agent_turn", message="hello")

    assert payload.context_messages == 0

