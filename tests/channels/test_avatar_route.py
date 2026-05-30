"""Tests for the public ``/api/avatar`` route."""

from __future__ import annotations

import asyncio
import functools
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from nanobot.channels.websocket import WebSocketChannel


_JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"\x00" * 16  # minimal JPEG magic
_PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def _ch(bus: Any, *, port: int) -> WebSocketChannel:
    return WebSocketChannel(
        {
            "enabled": True,
            "allowFrom": ["*"],
            "host": "127.0.0.1",
            "port": port,
            "path": "/",
            "websocketRequiresToken": False,
        },
        bus,
    )


@pytest.fixture()
def bus() -> MagicMock:
    b = MagicMock()
    b.publish_inbound = AsyncMock()
    return b


async def _http_get(url: str) -> httpx.Response:
    return await asyncio.to_thread(functools.partial(httpx.get, url, timeout=5.0))


# ---------------------------------------------------------------------------
# /api/avatar route tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_avatar_route_serves_jpg(bus: MagicMock, tmp_path: Path) -> None:
    """avatar.jpg found → 200 with image/jpeg."""
    media = tmp_path / "media"
    media.mkdir()
    (media / "avatar.jpg").write_bytes(_JPEG_BYTES)

    channel = _ch(bus, port=29940)
    with patch("nanobot.channels.websocket.get_media_dir", return_value=media):
        task = asyncio.create_task(channel.start())
        await asyncio.sleep(0.3)
        try:
            resp = await _http_get("http://127.0.0.1:29940/api/avatar")
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"
    assert resp.content == _JPEG_BYTES


@pytest.mark.asyncio
async def test_avatar_route_404_when_missing(bus: MagicMock, tmp_path: Path) -> None:
    """No avatar file → 404."""
    media = tmp_path / "media"
    media.mkdir()

    channel = _ch(bus, port=29941)
    with patch("nanobot.channels.websocket.get_media_dir", return_value=media):
        task = asyncio.create_task(channel.start())
        await asyncio.sleep(0.3)
        try:
            resp = await _http_get("http://127.0.0.1:29941/api/avatar")
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_avatar_route_priority_jpg_over_png(bus: MagicMock, tmp_path: Path) -> None:
    """When both avatar.jpg and avatar.png exist, jpg wins."""
    media = tmp_path / "media"
    media.mkdir()
    (media / "avatar.jpg").write_bytes(_JPEG_BYTES)
    (media / "avatar.png").write_bytes(_PNG_BYTES)

    channel = _ch(bus, port=29942)
    with patch("nanobot.channels.websocket.get_media_dir", return_value=media):
        task = asyncio.create_task(channel.start())
        await asyncio.sleep(0.3)
        try:
            resp = await _http_get("http://127.0.0.1:29942/api/avatar")
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"
    assert resp.content == _JPEG_BYTES


@pytest.mark.asyncio
async def test_avatar_route_falls_back_to_png(bus: MagicMock, tmp_path: Path) -> None:
    """No jpg but png exists → serves png."""
    media = tmp_path / "media"
    media.mkdir()
    (media / "avatar.png").write_bytes(_PNG_BYTES)

    channel = _ch(bus, port=29943)
    with patch("nanobot.channels.websocket.get_media_dir", return_value=media):
        task = asyncio.create_task(channel.start())
        await asyncio.sleep(0.3)
        try:
            resp = await _http_get("http://127.0.0.1:29943/api/avatar")
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
