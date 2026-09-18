"""跨渠道通知只读取统一会话，不重复发送正文或改动原渠道。"""

import pytest

from nanobot.bus.events import OutboundMessage
from nanobot.bus.outbound_events import SessionUpdatedEvent
from nanobot.bus.queue import MessageBus
from nanobot.bus.runtime_events import (
    RuntimeEventContext,
    SessionTurnPersisted,
    TurnRunStatusChanged,
)
from nanobot.session.manager import SessionManager
from nanobot.webui.desktop_inbox import DesktopInboxCoordinator
from nanobot.webui.transcript import build_session_thread_response


@pytest.mark.asyncio
async def test_external_injection_in_desktop_turn_triggers_history_refresh(tmp_path):
    bus = MessageBus()
    sessions = SessionManager(tmp_path / "workspace")
    session = sessions.get_or_create("unified:default")
    desktop = RuntimeEventContext(channel="websocket", chat_id="desktop", session_key=session.key)
    session.add_message("user", "same", source_channel="websocket", source_chat_id="desktop")
    sessions.save(session)
    with DesktopInboxCoordinator(bus, sessions).connected():
        await bus.publish(TurnRunStatusChanged(desktop, "running", 1.0))
        session.add_message("user", "same", source_channel="feishu", source_chat_id="room-1")
        session.add_message("assistant", "answer")
        sessions.save(session)
        await bus.publish(SessionTurnPersisted(desktop, "desktop-turn", "user"))
        await bus.publish(TurnRunStatusChanged(desktop, "idle"))
    assert bus.outbound_size == 1
    notice = await bus.consume_outbound()
    assert notice.chat_id == "desktop" and isinstance(notice.event, SessionUpdatedEvent)
    assert session.messages[0]["source_channel"] == "websocket"
    assert session.messages[1]["source_channel"] == "feishu"
    assert session.messages[2].get("source_channel") != "feishu"


@pytest.mark.asyncio
async def test_external_turn_notifies_desktop_and_preserves_original_delivery(tmp_path):
    bus = MessageBus()
    sessions = SessionManager(tmp_path / "workspace")
    session = sessions.get_or_create("unified:default")
    context = RuntimeEventContext(channel="telegram", chat_id="42", session_key=session.key)
    session.add_message("user", "hello", source_channel="telegram", source_chat_id="42")
    sessions.save(session)
    with DesktopInboxCoordinator(bus, sessions).connected():
        await bus.publish(TurnRunStatusChanged(context, "running", 1.0))
        # 重复 running 不是第二次用户输入。
        await bus.publish(TurnRunStatusChanged(context, "running", 1.0))
        session.add_message("assistant", "answer")
        sessions.save(session)
        await bus.publish(SessionTurnPersisted(context, "turn-1", "user"))
        original = OutboundMessage(channel="telegram", chat_id="42", content="answer")
        await bus.publish_outbound(original)
        await bus.publish(TurnRunStatusChanged(context, "idle"))
    first = await bus.consume_outbound()
    second = await bus.consume_outbound()
    assert all(m.channel == "websocket" and m.chat_id == "desktop" for m in (first, second))
    assert all(isinstance(m.event, SessionUpdatedEvent) and not m.content for m in (first, second))
    assert await bus.consume_outbound() is original
    assert bus.outbound.empty()
    saved = sessions.read_session_file(session.key)
    assert saved is not None
    assert len(saved["messages"]) == 2
    assert all(m["source_channel"] == "telegram" for m in saved["messages"])
    assert all(m["source_chat_id"] == "42" for m in saved["messages"])
    history = build_session_thread_response("websocket:desktop", saved["messages"])
    assert [m["content"] for m in history["messages"]] == ["hello", "answer"]
    assert all(m["source"] == {"kind": "channel", "label": "telegram"} for m in history["messages"])
    await bus.publish(TurnRunStatusChanged(context, "running", 2.0))
    assert bus.outbound.empty()


@pytest.mark.asyncio
@pytest.mark.parametrize(("channel", "chat_id", "key"), [
    ("websocket", "desktop", "unified:default"),
    ("telegram", "42", "telegram:42"),
    ("system", "internal", "unified:default"),
    ("websocket", "other", "heartbeat"),
    ("telegram", "42", "cron:job"),
])
async def test_desktop_and_non_unified_or_internal_turns_are_not_mirrored(tmp_path, channel, chat_id, key):
    bus = MessageBus()
    sessions = SessionManager(tmp_path / "workspace")
    context = RuntimeEventContext(channel=channel, chat_id=chat_id, session_key=key)
    with DesktopInboxCoordinator(bus, sessions).connected():
        await bus.publish(TurnRunStatusChanged(context, "running", 1.0))
        await bus.publish(SessionTurnPersisted(context, "turn-1", "user"))
        await bus.publish(TurnRunStatusChanged(context, "idle"))
    assert bus.outbound.empty()
    assert sessions.read_session_file(key) is None


@pytest.mark.asyncio
async def test_cancelled_turn_refreshes_once_and_next_turn_can_start(tmp_path):
    bus = MessageBus()
    sessions = SessionManager(tmp_path / "workspace")
    session = sessions.get_or_create("unified:default")
    context = RuntimeEventContext(channel="feishu", chat_id="42", session_key=session.key)
    session.add_message("user", "hello")
    with DesktopInboxCoordinator(bus, sessions).connected():
        await bus.publish(TurnRunStatusChanged(context, "running", 1.0))
        await bus.publish(TurnRunStatusChanged(context, "idle"))
        await bus.publish(TurnRunStatusChanged(context, "idle"))
        assert bus.outbound_size == 2
        session.add_message("user", "next")
        await bus.publish(TurnRunStatusChanged(context, "running", 2.0))
        assert bus.outbound_size == 3
