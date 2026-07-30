"""ChannelManager 统一收件箱 fan-out 测试。"""
from __future__ import annotations

import asyncio
import json
import socket
from contextlib import suppress
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from nanobot.bus.events import OutboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.channels.base import BaseChannel
from nanobot.channels.manager import ChannelManager
from nanobot.channels.websocket import WebSocketChannel
from nanobot.config.schema import Config
from ws_test_client import WsTestClient


def _get_free_port() -> int:
    """让 OS 分配一个空闲端口，避免 CI 上固定端口冲突。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class StreamMockChannel(BaseChannel):
    name = "telegram"
    display_name = "Telegram"

    def __init__(self, config, bus):
        super().__init__(config, bus)
        self._send_mock = AsyncMock()
        self._send_delta_mock = AsyncMock()

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def send(self, msg: OutboundMessage) -> None:
        await self._send_mock(msg)

    async def send_delta(self, chat_id: str, delta: str, metadata=None) -> None:
        await self._send_delta_mock(chat_id, delta, metadata)


class CaptureWsChannel(BaseChannel):
    name = "websocket"
    display_name = "WebSocket"

    def __init__(self, config, bus):
        super().__init__(config, bus)
        self.sent: list[OutboundMessage] = []
        self.stream_events: list[tuple[str, str, str]] = []
        self.stream_payloads: list[dict] = []

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def send(self, msg: OutboundMessage) -> None:
        self.sent.append(msg)

    async def fan_out_unified_inbox_event(
        self,
        payload: dict,
        source_channel: str,
        source_chat_id: str,
        metadata: dict | None = None,
    ) -> None:
        self.stream_events.append(
            (payload.get("event", ""), payload.get("text", ""), source_channel),
        )
        self.stream_payloads.append(payload)


@pytest.fixture
def unified_config() -> Config:
    cfg = Config()
    cfg.agents.defaults.unified_session = True
    return cfg


@pytest.fixture
def bus() -> MessageBus:
    return MessageBus()


@pytest.fixture
def manager(unified_config: Config, bus: MessageBus) -> ChannelManager:
    mgr = ChannelManager(unified_config, bus)
    mgr.channels["telegram"] = StreamMockChannel({}, bus)
    mgr.channels["websocket"] = CaptureWsChannel({}, bus)
    return mgr


@pytest.mark.asyncio
async def test_streamed_final_not_duplicated_after_stream_end(
    manager: ChannelManager,
) -> None:
    """_streamed 占位消息在 stream_end 已 fan-out 后不应重复推送。"""
    ws = manager.channels["websocket"]
    assert isinstance(ws, CaptureWsChannel)

    end = OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="段末",
        metadata={"_stream_id": "s:1", "_stream_delta": True, "_stream_end": True},
    )
    await manager._maybe_fan_out_unified_inbox(end)
    assert ws.stream_events == [
        ("delta", "段末", "telegram"),
        ("stream_end", "", "telegram"),
    ]
    assert ws.sent == []

    streamed_final = OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="段末",
        metadata={"_streamed": True},
    )
    await manager._maybe_fan_out_unified_inbox(streamed_final)
    assert ws.sent == []


@pytest.mark.asyncio
async def test_non_streamed_telegram_reply_fan_out_to_inbox(
    manager: ChannelManager,
) -> None:
    """非流式出站应写入 inbox:unified shadow。"""
    msg = OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="你好",
        metadata={"message_id": "1"},
    )
    ws = manager.channels["websocket"]
    assert isinstance(ws, CaptureWsChannel)

    await manager._maybe_fan_out_unified_inbox(msg)

    assert len(ws.sent) == 1
    shadow = ws.sent[0]
    assert shadow.chat_id == "inbox:unified"
    assert shadow.content == "你好"
    assert shadow.metadata["_unified_inbox_write"] is True
    assert shadow.metadata["source_channel"] == "telegram"
    assert shadow.metadata.get("_streamed") is None


@pytest.mark.asyncio
async def test_stream_delta_and_end_fan_out_to_inbox(
    manager: ChannelManager,
) -> None:
    """流式分片应实时推 delta，结束时仅推 stream_end。"""
    ws = manager.channels["websocket"]
    assert isinstance(ws, CaptureWsChannel)
    stream_id = "s:0"
    base_meta = {"_stream_id": stream_id}

    delta = OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="你",
        metadata={**base_meta, "_stream_delta": True},
    )
    await manager._maybe_fan_out_unified_inbox(delta)
    assert ws.stream_events == [("delta", "你", "telegram")]

    delta2 = OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="好",
        metadata={**base_meta, "_stream_delta": True},
    )
    await manager._maybe_fan_out_unified_inbox(delta2)
    assert ws.stream_events[-1] == ("delta", "好", "telegram")

    end = OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="",
        metadata={**base_meta, "_stream_end": True},
    )
    await manager._maybe_fan_out_unified_inbox(end)
    assert ws.stream_events == [
        ("delta", "你", "telegram"),
        ("delta", "好", "telegram"),
        ("stream_end", "", "telegram"),
    ]
    assert ws.sent == []

    streamed_final = OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="你好",
        metadata={"_streamed": True},
    )
    await manager._maybe_fan_out_unified_inbox(streamed_final)
    assert ws.sent == []


@pytest.mark.asyncio
async def test_vision_caption_stream_fan_out_to_inbox(
    manager: ChannelManager,
) -> None:
    """外部通道 vision caption 流式事件应实时 fan-out 到 inbox:unified。"""
    ws = manager.channels["websocket"]
    assert isinstance(ws, CaptureWsChannel)

    delta = OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="一只",
        metadata={
            "_vision_caption_delta": True,
            "image_index": 0,
            "_stream_id": "unified:default:caption:0",
        },
    )
    await manager._maybe_fan_out_unified_inbox(delta)
    assert ws.stream_events[-1] == ("vision_caption_delta", "一只", "telegram")
    assert ws.stream_payloads[-1]["image_index"] == 0
    assert ws.stream_payloads[-1]["chat_id"] == "inbox:unified"

    end = OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="一只橘猫",
        metadata={
            "_vision_caption_end": True,
            "image_index": 0,
            "_stream_id": "unified:default:caption:0",
        },
    )
    await manager._maybe_fan_out_unified_inbox(end)
    assert ws.stream_events[-1] == ("vision_caption_end", "一只橘猫", "telegram")
    assert ws.stream_payloads[-1]["event"] == "vision_caption_end"
    assert len(ws.sent) == 0


@pytest.mark.asyncio
async def test_turn_end_fan_out_to_inbox(
    manager: ChannelManager,
) -> None:
    """外部通道 turn_end 应 fan-out 到 inbox:unified，携带 latency/goal_state。"""
    ws = manager.channels["websocket"]
    assert isinstance(ws, CaptureWsChannel)

    goal_state = {"active": False}
    end = OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="",
        metadata={
            "_turn_end": True,
            "latency_ms": 1200,
            "goal_state": goal_state,
        },
    )
    await manager._maybe_fan_out_unified_inbox(end)

    assert ws.stream_events[-1] == ("turn_end", "", "telegram")
    payload = ws.stream_payloads[-1]
    assert payload["event"] == "turn_end"
    assert payload["chat_id"] == "inbox:unified"
    assert payload["latency_ms"] == 1200
    assert payload["goal_state"] == goal_state
    assert len(ws.sent) == 0


@pytest.mark.asyncio
async def test_reasoning_stream_fan_out_to_inbox(
    manager: ChannelManager,
) -> None:
    """跨通道 reasoning 应按流式协议推送到统一收件箱。"""
    ws = manager.channels["websocket"]
    assert isinstance(ws, CaptureWsChannel)
    meta = {"_stream_id": "r1"}

    await manager._maybe_fan_out_unified_inbox(OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="thinking",
        metadata={**meta, "_progress": True, "_reasoning_delta": True},
    ))
    await manager._maybe_fan_out_unified_inbox(OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="",
        metadata={**meta, "_progress": True, "_reasoning_end": True},
    ))

    assert ws.stream_events == [
        ("reasoning_delta", "thinking", "telegram"),
        ("reasoning_end", "", "telegram"),
    ]


@pytest.mark.asyncio
async def test_send_once_delivers_unified_shadow_despite_streamed_flag() -> None:
    """_send_once 对 _unified_inbox_write shadow 不应因 _streamed 而跳过 send。"""
    ch = AsyncMock(spec=BaseChannel)
    msg = OutboundMessage(
        channel="websocket",
        chat_id="inbox:unified",
        content="reply",
        metadata={"_unified_inbox_write": True, "_streamed": True},
    )
    await ChannelManager._send_once(ch, msg)
    ch.send.assert_awaited_once_with(msg)


@pytest.mark.asyncio
async def test_coalesced_delta_end_single_packet_fan_out(
    manager: ChannelManager,
) -> None:
    """合并后的 delta+end 单包应先推尾 delta，再关闭流式段。"""
    ws = manager.channels["websocket"]
    assert isinstance(ws, CaptureWsChannel)

    merged = OutboundMessage(
        channel="telegram",
        chat_id="123",
        content="合并文本",
        metadata={
            "_stream_id": "s:0",
            "_stream_delta": True,
            "_stream_end": True,
        },
    )
    await manager._maybe_fan_out_unified_inbox(merged)

    assert ws.stream_events == [
        ("delta", "合并文本", "telegram"),
        ("stream_end", "", "telegram"),
    ]
    assert ws.sent == []


@pytest.mark.asyncio
async def test_dispatch_telegram_stream_fan_out_to_inbox_ws(
    tmp_path: Path,
) -> None:
    """集成：ChannelManager 经真实 WebSocket 将 Telegram 流式回复 fan-out 到 inbox。"""
    bus = MessageBus()
    config = Config()
    config.agents.defaults.unified_session = True

    port = _get_free_port()
    ws = WebSocketChannel(
        {
            "enabled": True,
            "allowFrom": ["*"],
            "host": "127.0.0.1",
            "port": port,
            "path": "/",
            "websocketRequiresToken": False,
        },
        bus,
        unified_session=True,
        workspace_path=tmp_path,
    )
    tg = StreamMockChannel({}, bus)

    mgr = ChannelManager(config, bus)
    mgr._unified_session = True
    mgr.channels = {"telegram": tg, "websocket": ws}

    ws_task = asyncio.create_task(ws.start())
    dispatch_task = asyncio.create_task(mgr._dispatch_outbound())
    await asyncio.sleep(0.3)

    stream_meta = {"_stream_id": "turn:0"}
    try:
        async with WsTestClient(f"ws://127.0.0.1:{port}/", client_id="inbox") as c:
            await c.recv_ready()
            await c.ws.send(json.dumps({"type": "attach", "chat_id": "inbox:unified"}))
            attached = json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
            assert attached["event"] == "attached"

            await bus.publish_outbound(OutboundMessage(
                channel="telegram",
                chat_id="999",
                content="你",
                metadata={**stream_meta, "_stream_delta": True},
            ))
            await asyncio.sleep(0.05)
            await bus.publish_outbound(OutboundMessage(
                channel="telegram",
                chat_id="999",
                content="好",
                metadata={**stream_meta, "_stream_delta": True},
            ))
            await asyncio.sleep(0.05)
            await bus.publish_outbound(OutboundMessage(
                channel="telegram",
                chat_id="999",
                content="",
                metadata={**stream_meta, "_stream_end": True},
            ))
            await asyncio.sleep(0.05)
            await bus.publish_outbound(OutboundMessage(
                channel="telegram",
                chat_id="999",
                content="你好",
                metadata={"_streamed": True},
            ))

            events: list[dict] = []
            for _ in range(5):
                try:
                    events.append(
                        json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
                    )
                except asyncio.TimeoutError:
                    break

            delta_events = [e for e in events if e.get("event") == "delta"]
            stream_end_events = [e for e in events if e.get("event") == "stream_end"]
            message_events = [e for e in events if e.get("event") == "message"]
            assert "".join(e.get("text", "") for e in delta_events) == "你好"
            assert len(stream_end_events) == 1
            assert stream_end_events[0]["source_channel"] == "telegram"
            assert stream_end_events[0]["source_chat_id"] == "999"
            assert message_events == []
    finally:
        dispatch_task.cancel()
        with suppress(asyncio.CancelledError):
            await dispatch_task
        await ws.stop()
        ws_task.cancel()
        with suppress(asyncio.CancelledError):
            await ws_task

@pytest.mark.asyncio
async def test_dispatch_telegram_caption_and_turn_end_fan_out_to_inbox_ws(
    tmp_path: Path,
) -> None:
    """集成：Telegram caption 流式与 turn_end 经 WebSocket fan-out 到 inbox。"""
    bus = MessageBus()
    config = Config()
    config.agents.defaults.unified_session = True

    port = _get_free_port()
    ws = WebSocketChannel(
        {
            "enabled": True,
            "allowFrom": ["*"],
            "host": "127.0.0.1",
            "port": port,
            "path": "/",
            "websocketRequiresToken": False,
        },
        bus,
        unified_session=True,
        workspace_path=tmp_path,
    )
    tg = StreamMockChannel({}, bus)

    mgr = ChannelManager(config, bus)
    mgr._unified_session = True
    mgr.channels = {"telegram": tg, "websocket": ws}

    ws_task = asyncio.create_task(ws.start())
    dispatch_task = asyncio.create_task(mgr._dispatch_outbound())
    await asyncio.sleep(0.3)

    try:
        async with WsTestClient(f"ws://127.0.0.1:{port}/", client_id="inbox") as c:
            await c.recv_ready()
            await c.ws.send(json.dumps({"type": "attach", "chat_id": "inbox:unified"}))
            attached = json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
            assert attached["event"] == "attached"

            await bus.publish_outbound(OutboundMessage(
                channel="telegram",
                chat_id="999",
                content="一只",
                metadata={
                    "_vision_caption_delta": True,
                    "image_index": 0,
                    "_stream_id": "unified:default:caption:0",
                },
            ))
            await asyncio.sleep(0.05)
            await bus.publish_outbound(OutboundMessage(
                channel="telegram",
                chat_id="999",
                content="一只猫",
                metadata={
                    "_vision_caption_end": True,
                    "image_index": 0,
                    "_stream_id": "unified:default:caption:0",
                },
            ))
            await asyncio.sleep(0.05)
            await bus.publish_outbound(OutboundMessage(
                channel="telegram",
                chat_id="999",
                content="",
                metadata={
                    "_turn_end": True,
                    "latency_ms": 900,
                    "goal_state": {"active": False},
                },
            ))

            events: list[dict] = []
            for _ in range(6):
                try:
                    events.append(
                        json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
                    )
                except asyncio.TimeoutError:
                    break

            caption_deltas = [e for e in events if e.get("event") == "vision_caption_delta"]
            caption_ends = [e for e in events if e.get("event") == "vision_caption_end"]
            turn_ends = [e for e in events if e.get("event") == "turn_end"]
            assert len(caption_deltas) == 1
            assert caption_deltas[0]["text"] == "一只"
            assert caption_deltas[0]["source_channel"] == "telegram"
            assert len(caption_ends) == 1
            assert caption_ends[0]["text"] == "一只猫"
            assert len(turn_ends) == 1
            assert turn_ends[0]["latency_ms"] == 900
            assert turn_ends[0]["chat_id"] == "inbox:unified"
    finally:
        dispatch_task.cancel()
        with suppress(asyncio.CancelledError):
            await dispatch_task
        await ws.stop()
        ws_task.cancel()
        with suppress(asyncio.CancelledError):
            await ws_task
