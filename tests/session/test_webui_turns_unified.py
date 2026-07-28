"""WebuiTurnCoordinator 统一会话 turn_end 测试。"""
from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from nanobot.bus.outbound_events import TurnEndEvent
from nanobot.bus.queue import MessageBus
from nanobot.bus.runtime_events import RuntimeEventContext, TurnCompleted
from nanobot.session.webui_turns import WebuiTurnCoordinator


@pytest.mark.asyncio
async def test_unified_session_publishes_turn_end_for_external_channel() -> None:
    """统一会话下 Telegram turn 完成应发布 _turn_end 出站消息。"""
    bus = MessageBus()
    sessions = MagicMock()
    sessions.get_or_create.return_value = MagicMock(metadata={})

    coordinator = WebuiTurnCoordinator(
        bus=bus,
        sessions=sessions,
        schedule_background=lambda coro: asyncio.create_task(coro),
        unified_session=True,
    )

    event = TurnCompleted(
        context=RuntimeEventContext(
            channel="telegram",
            chat_id="999",
            session_key="unified:default",
            metadata={},
        ),
        latency_ms=800,
    )
    await coordinator._handle_turn_completed_event(event)

    assert bus.outbound_size == 1
    msg = await bus.consume_outbound()
    assert msg.channel == "telegram"
    assert msg.chat_id == "999"
    assert isinstance(msg.event, TurnEndEvent)
    assert msg.event.latency_ms == 800


@pytest.mark.asyncio
async def test_unified_session_turn_end_includes_usage() -> None:
    """统一会话 turn_end 应携带 token/ctx usage，供直播客户端渲染 footer。"""
    bus = MessageBus()
    sessions = MagicMock()
    sessions.get_or_create.return_value = MagicMock(metadata={})

    coordinator = WebuiTurnCoordinator(
        bus=bus,
        sessions=sessions,
        schedule_background=lambda coro: asyncio.create_task(coro),
        unified_session=True,
    )

    usage = {
        "last_prompt_tokens": 11000,
        "turn_prompt_tokens": 152835,
        "turn_completion_tokens": 340,
        "context_tokens": 10800,
        "context_pct": 1,
    }
    event = TurnCompleted(
        context=RuntimeEventContext(
            channel="telegram",
            chat_id="999",
            session_key="unified:default",
            metadata={},
        ),
        latency_ms=800,
        usage=usage,
    )
    await coordinator._handle_turn_completed_event(event)

    assert bus.outbound_size == 1
    msg = await bus.consume_outbound()
    assert isinstance(msg.event, TurnEndEvent)
    assert (msg.metadata or {}).get("usage") == usage


@pytest.mark.asyncio
async def test_non_unified_session_skips_external_turn_end() -> None:
    """未开启统一会话时，外部通道 turn 完成不应发布 turn_end。"""
    bus = MessageBus()
    sessions = MagicMock()

    coordinator = WebuiTurnCoordinator(
        bus=bus,
        sessions=sessions,
        schedule_background=lambda coro: asyncio.create_task(coro),
        unified_session=False,
    )

    event = TurnCompleted(
        context=RuntimeEventContext(
            channel="telegram",
            chat_id="999",
            session_key="telegram:999",
            metadata={},
        ),
        latency_ms=500,
    )
    await coordinator._handle_turn_completed_event(event)

    assert bus.outbound_size == 0
