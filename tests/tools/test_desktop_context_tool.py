from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.agent.tools.desktop_context import DesktopContextTool, DesktopContextToolConfig


def _tool(ws: MagicMock, *, provider: object | None = None, model: str | None = None) -> DesktopContextTool:
    return DesktopContextTool(
        ws,
        config=DesktopContextToolConfig(enabled=True),
        vision_provider_getter=lambda: (provider, model),
    )


@pytest.mark.asyncio
async def test_desktop_context_returns_inactive_state_without_screenshot() -> None:
    ws = MagicMock()
    ws._last_user_conn = "conn"
    ws._conn_default = {"conn": "chat-1"}
    ws.get_unfocused_last_user_connection.return_value = None
    ws.is_connection_focused.return_value = True
    ws.is_connection_locked.return_value = False
    ws.request_screenshot = AsyncMock()

    result = json.loads(await _tool(ws).execute())

    assert result["connected"] is True
    assert result["eligible"] is False
    assert result["reason"] == "focused"
    assert result["chat_id"] == "chat-1"
    assert result["screenshot_path"] is None
    ws.request_screenshot.assert_not_called()


@pytest.mark.asyncio
async def test_desktop_context_requests_screenshot_when_eligible(tmp_path: Path) -> None:
    shot = tmp_path / "shot.jpg"
    shot.write_bytes(b"\xff\xd8\xff fake jpeg")
    ws = MagicMock()
    ws.get_unfocused_last_user_connection.return_value = ("conn", "chat-1")
    ws.is_connection_focused.return_value = False
    ws.is_connection_locked.return_value = False
    ws.request_screenshot = AsyncMock(return_value=shot)

    result = await _tool(ws).execute(timeout_s=2)

    ws.request_screenshot.assert_awaited_once_with("conn", timeout_s=2.0)
    assert isinstance(result, list)
    payload = json.loads(result[1]["text"])
    assert payload["eligible"] is True
    assert payload["reason"] == "eligible"
    assert payload["screenshot_path"] == str(shot)
    assert payload["caption"] is None


@pytest.mark.asyncio
async def test_desktop_context_degrades_when_screenshot_unavailable() -> None:
    ws = MagicMock()
    ws.get_unfocused_last_user_connection.return_value = ("conn", "chat-1")
    ws.is_connection_focused.return_value = False
    ws.is_connection_locked.return_value = False
    ws.request_screenshot = AsyncMock(return_value=None)

    result = json.loads(await _tool(ws).execute())

    assert result["reason"] == "screenshot_unavailable"
    assert result["screenshot_path"] is None
    assert result["caption"] is None


@pytest.mark.asyncio
async def test_desktop_context_uses_vision_caption_when_configured(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shot = tmp_path / "shot.jpg"
    shot.write_bytes(b"fake")
    ws = MagicMock()
    ws.get_unfocused_last_user_connection.return_value = ("conn", "chat-1")
    ws.is_connection_focused.return_value = False
    ws.is_connection_locked.return_value = False
    ws.request_screenshot = AsyncMock(return_value=shot)

    async def fake_caption_images(image_paths, provider, model):
        assert image_paths == [str(shot)]
        assert provider == "provider"
        assert model == "vision-model"
        return [SimpleNamespace(text="桌面上打开了编辑器。", error=None)]

    monkeypatch.setattr("nanobot.agent.vision_caption.caption_images", fake_caption_images)

    result = json.loads(await _tool(ws, provider="provider", model="vision-model").execute())

    assert result["caption"] == "桌面上打开了编辑器。"
    assert result["caption_error"] is None


@pytest.mark.asyncio
async def test_desktop_context_attaches_image_when_no_vision_model(tmp_path: Path) -> None:
    shot = tmp_path / "shot.jpg"
    shot.write_bytes(b"\xff\xd8\xff fake jpeg")
    ws = MagicMock()
    ws.get_unfocused_last_user_connection.return_value = ("conn", "chat-1")
    ws.is_connection_focused.return_value = False
    ws.is_connection_locked.return_value = False
    ws.request_screenshot = AsyncMock(return_value=shot)

    result = await _tool(ws, provider=None, model=None).execute()

    assert isinstance(result, list)
    assert result[0]["type"] == "image_url"
    assert result[1]["type"] == "text"
    payload = json.loads(result[1]["text"])
    assert payload["screenshot_path"] == str(shot)
    assert payload["caption"] is None
