"""桌面感知只使用生成图片和模拟连接，不截取真实屏幕。"""

import asyncio
import base64
import io
import json
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from nanobot.agent.tools.desktop_context import DesktopContextBroker, DesktopContextTool


def state(broker, connection, **values):
    broker.receive(connection, {"type": "desktop_context_state", "focused": False, "locked": False, "suspended": False, "unknown": False, **values})


def picture():
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), "blue").save(buffer, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


async def test_screenshot_response_is_bound_to_requesting_connection():
    send = AsyncMock()
    broker = DesktopContextBroker(send)
    one, two = object(), object()
    state(broker, one)
    state(broker, two)
    broker.user_message(one)
    pending = asyncio.create_task(DesktopContextTool(broker).execute())
    await asyncio.sleep(0)
    assert send.call_args.args[0] is one
    response = {"type": "desktop_context_result", "request_id": send.call_args.kwargs["request_id"], "reason": "captured", "image": picture()}
    broker.receive(two, response)
    assert not pending.done()
    broker.receive(one, response)
    result = await pending
    assert result[0]["type"] == "text" and "reference data" in result[0]["text"]
    assert result[1]["image_url"]["url"] == response["image"]
    assert not broker._pending


@pytest.mark.parametrize("field", ["focused", "locked", "suspended", "unknown"])
async def test_ineligible_state_never_requests_capture(field):
    send = AsyncMock()
    broker = DesktopContextBroker(send)
    connection = object()
    state(broker, connection, **{field: True})
    result = json.loads(await DesktopContextTool(broker).execute())
    assert not result["eligible"] and result["reason"] == field
    send.assert_not_awaited()


async def test_status_only_timeout_disconnect_and_lock_cancel_pending():
    send = AsyncMock()
    broker = DesktopContextBroker(send)
    connection = object()
    assert (await broker.request(True))["reason"] == "disconnected"
    state(broker, connection)
    assert (await broker.request(False))["reason"] == "capture_disabled"
    send.assert_not_awaited()
    assert (await broker.request(True, timeout=0.01))["reason"] == "timeout"
    assert not broker._pending
    pending = asyncio.create_task(broker.request(True))
    await asyncio.sleep(0)
    state(broker, connection, locked=True)
    assert (await pending)["reason"] == "state_changed"
    state(broker, connection)
    pending = asyncio.create_task(broker.request(True))
    await asyncio.sleep(0)
    broker.disconnect(connection)
    assert (await pending)["reason"] == "disconnected"
    assert not broker._pending


async def test_switching_active_desktop_discards_old_request():
    broker = DesktopContextBroker(AsyncMock())
    one, two = object(), object()
    state(broker, one)
    pending = asyncio.create_task(broker.request(True))
    await asyncio.sleep(0)
    state(broker, two, locked=True)
    assert broker._last is one
    assert not pending.done()
    broker.disconnect(two)
    state(broker, two)
    assert broker._last is one
    assert not pending.done()
    broker.user_message(two)
    assert (await pending)["reason"] == "state_changed"
    assert broker._last is two
    broker.disconnect(two)
    state(broker, one)
    assert (await broker.request(False))["reason"] == "disconnected"
    state(broker, two)
    assert broker._last is two


async def test_heartbeat_tool_image_reaches_model_but_not_public_history(tmp_path):
    from nanobot.agent.loop import AgentLoop
    from nanobot.agent.tools.registry import ToolRegistry
    from nanobot.config.schema import Config
    from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest

    image = picture()
    class Provider(LLMProvider):
        def __init__(self):
            super().__init__(provider_name="test")
            self.calls = 0
        def get_default_model(self):
            return "test"
        async def chat(self, messages, **kwargs):
            self.calls += 1
            if self.calls == 1:
                return LLMResponse(content="", tool_calls=[ToolCallRequest(id="screen", name="desktop_context", arguments={})])
            result = next(message for message in messages if message["role"] == "tool")
            assert result["content"][1]["image_url"]["url"] == image
            return LLMResponse(content="All clear.")
    async def send(connection, event, **fields):
        assert event == "desktop_context_request"
        broker.receive(connection, {"type": "desktop_context_result", "request_id": fields["request_id"], "reason": "captured", "image": image})
    broker = DesktopContextBroker(send)
    state(broker, object())
    registry = ToolRegistry()
    registry.register(DesktopContextTool(broker))
    provider = Provider()
    loop = AgentLoop.from_config(Config(agents={"defaults": {"workspace": str(tmp_path), "model": "test"}}),
                                 provider=provider, tool_registry=registry)
    response = await loop.process_direct("Check desktop context if needed.", session_key="heartbeat")
    assert response.content == "All clear." and provider.calls == 2
    saved = loop.sessions.get_or_create("heartbeat").messages
    assert "data:image/" not in json.dumps(saved)


@pytest.mark.parametrize("image", ["data:image/svg+xml;base64,PHN2Zz4=", "data:image/jpeg;base64,bad!", "data:image/jpeg;base64," + "A" * (6 * 1024 * 1024)], ids=["svg", "invalid-base64", "oversized"])
async def test_invalid_or_oversized_images_are_rejected(image):
    send = AsyncMock()
    broker = DesktopContextBroker(send)
    connection = object()
    state(broker, connection)
    pending = asyncio.create_task(broker.request(True))
    await asyncio.sleep(0)
    broker.receive(connection, {"type": "desktop_context_result", "request_id": send.call_args.kwargs["request_id"], "reason": "captured", "image": image})
    assert (await pending)["reason"] == "unavailable"
