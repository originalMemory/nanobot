"""Test websocket subscribe hydration only replays known active turns."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanobot.bus.events import OutboundMessage
from nanobot.channels.websocket.runtime import WebSocketChannel


@pytest.mark.asyncio
async def test_hydrate_after_subscribe_is_quiet_when_no_turn_active():
    """Subscribe hydration must not inject an idle event into normal message order."""
    channel = WebSocketChannel.__new__(WebSocketChannel)
    channel.gateway = MagicMock()
    channel.gateway.session_manager = MagicMock()
    channel.gateway.session_manager.read_session_file = MagicMock(return_value={})
    channel._turn_models = {}
    channel._pending_reconnect_messages = {}

    sent_events = []

    async def mock_send_goal_state(chat_id, blob):
        sent_events.append(("goal_state", chat_id, blob))

    async def mock_send_goal_status(chat_id, status, **kwargs):
        sent_events.append(("goal_status", chat_id, status, kwargs))

    channel.send_goal_state = mock_send_goal_state
    channel.send_goal_status = mock_send_goal_status

    with patch("nanobot.channels.websocket.runtime.websocket_turn_wall_started_at", return_value=None):
        await channel._hydrate_after_subscribe("test-chat")

    assert sent_events == []


@pytest.mark.asyncio
async def test_hydrate_after_subscribe_pushes_running_when_turn_active():
    """Reconnecting client should receive running status when turn is active."""
    channel = WebSocketChannel.__new__(WebSocketChannel)
    channel.gateway = MagicMock()
    channel.gateway.session_manager = MagicMock()
    channel.gateway.session_manager.read_session_file = MagicMock(return_value={})
    channel._turn_models = {}
    channel._pending_reconnect_messages = {}

    sent_events = []

    async def mock_send_goal_state(chat_id, blob):
        sent_events.append(("goal_state", chat_id, blob))

    async def mock_send_goal_status(chat_id, status, **kwargs):
        sent_events.append(("goal_status", chat_id, status, kwargs))

    channel.send_goal_state = mock_send_goal_state
    channel.send_goal_status = mock_send_goal_status

    with patch("nanobot.channels.websocket.runtime.websocket_turn_wall_started_at", return_value=1234567890.0):
        await channel._hydrate_after_subscribe("test-chat")

    running_events = [e for e in sent_events if e[0] == "goal_status" and e[2] == "running"]
    assert len(running_events) == 1
    assert running_events[0][3]["started_at"] == 1234567890.0


@pytest.mark.asyncio
@pytest.mark.parametrize("chat_id", ["chat-1", "inbox:unified"])
async def test_hydrate_after_subscribe_delivers_pending_restart_notice(chat_id):
    """普通会话和统一收件箱重连后都应收到暂存的重启完成消息。"""
    channel = WebSocketChannel.__new__(WebSocketChannel)
    channel.gateway = MagicMock()
    channel.gateway.session_manager = MagicMock()
    channel.gateway.session_manager.read_session_file = MagicMock(return_value={})
    channel._pending_reconnect_messages = {}
    channel.send = AsyncMock()
    channel.send_goal_state = AsyncMock()
    channel.send_goal_status = AsyncMock()
    notice = OutboundMessage(
        channel="websocket",
        chat_id=chat_id,
        content="Restart completed.",
    )

    channel.queue_pending_reconnect_message(notice)
    with patch("nanobot.channels.websocket.runtime.websocket_turn_wall_started_at", return_value=None):
        await channel._hydrate_after_subscribe(chat_id)

    channel.send.assert_awaited_once_with(notice)
    assert chat_id not in channel._pending_reconnect_messages
