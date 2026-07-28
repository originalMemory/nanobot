"""WebSocketChannel 按需截图功能单测（任务组 5）。"""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanobot.channels.websocket.runtime import (
    _MAX_SCREENSHOT_BYTES,
    WebSocketChannel,
    WebSocketConfig,
)
from nanobot.webui.gateway_services import build_gateway_services


def _ch(bus: Any, **kw: Any) -> WebSocketChannel:
    cfg: dict[str, Any] = {
        "enabled": True,
        "allowFrom": ["*"],
        "host": "127.0.0.1",
        "port": 29878,
        "path": "/ws",
        "websocketRequiresToken": False,
    }
    cfg.update(kw)
    parsed = WebSocketConfig.model_validate(cfg)
    gateway = build_gateway_services(
        config=parsed,
        bus=bus,
        session_manager=None,
        static_dist_path=None,
        workspace_path=Path.cwd(),
        default_restrict_to_workspace=False,
        runtime_model_name=None,
        runtime_surface="native",
        runtime_capabilities_overrides=None,
    )
    return WebSocketChannel(cfg, bus, gateway=gateway)


@pytest.fixture()
def bus() -> MagicMock:
    b = MagicMock()
    b.publish_inbound = AsyncMock()
    return b


def _mock_conn() -> MagicMock:
    conn = MagicMock()
    conn.send = AsyncMock()
    return conn


def _jpeg_data_url(size: int = 100) -> str:
    """返回一个合法格式的 JPEG data URL（内容为假数据）。"""
    raw = b"\xff\xd8\xff" + b"\x00" * size  # 假 JPEG header
    return "data:image/jpeg;base64," + base64.b64encode(raw).decode()


# ---------------------------------------------------------------------------
# request_screenshot — 发送 screenshot_request 帧
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_screenshot_sends_event(bus: MagicMock, tmp_path: Path) -> None:
    """request_screenshot 应向目标连接发送 screenshot_request 事件帧。"""
    ch = _ch(bus)
    conn = _mock_conn()

    with patch("nanobot.channels.websocket.runtime.get_media_dir", return_value=tmp_path):
        # 不等待结果，只验证帧已发出
        task = asyncio.create_task(ch.request_screenshot(conn, timeout_s=0.1))
        await asyncio.sleep(0)  # 让 request_screenshot 运行到 send

    conn.send.assert_called_once()
    sent = json.loads(conn.send.call_args[0][0])
    assert sent["event"] == "screenshot_request"
    assert isinstance(sent["request_id"], str) and sent["request_id"]

    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, asyncio.TimeoutError):
        pass


# ---------------------------------------------------------------------------
# request_screenshot — 成功路径：收到 screenshot_result → 落盘 → 返回路径
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_screenshot_success(bus: MagicMock, tmp_path: Path) -> None:
    """成功路径：发出请求后收到合法 screenshot_result，返回落盘路径。"""
    ch = _ch(bus)
    conn = _mock_conn()
    data_url = _jpeg_data_url(200)

    async def _fake_send(raw: str) -> None:
        # 截获服务端发出的帧，解出 request_id，立即回传 screenshot_result
        frame = json.loads(raw)
        if frame.get("event") == "screenshot_request":
            req_id = frame["request_id"]
            await ch._dispatch_envelope(
                conn, "client-1",
                {"type": "screenshot_result", "request_id": req_id, "data": data_url},
            )

    conn.send = AsyncMock(side_effect=_fake_send)

    with patch("nanobot.channels.websocket.runtime.get_media_dir", return_value=tmp_path):
        result = await ch.request_screenshot(conn, timeout_s=2.0)

    assert result is not None
    assert result.suffix == ".jpg"
    assert result.exists()


# ---------------------------------------------------------------------------
# request_screenshot — 超时路径
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_screenshot_timeout(bus: MagicMock, tmp_path: Path) -> None:
    """超时后 request_screenshot 返回 None，不抛出异常。"""
    ch = _ch(bus)
    conn = _mock_conn()

    with patch("nanobot.channels.websocket.runtime.get_media_dir", return_value=tmp_path):
        result = await ch.request_screenshot(conn, timeout_s=0.05)

    assert result is None


# ---------------------------------------------------------------------------
# screenshot_result — 非 JPEG MIME 被拒绝
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_screenshot_result_rejects_non_jpeg(bus: MagicMock, tmp_path: Path) -> None:
    """screenshot_result 中非 JPEG 的 data URL 应被拒绝（future 解析为 None）。"""
    ch = _ch(bus)
    conn = _mock_conn()
    req_id = "test-req-1"
    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    ch._screenshot_futures[req_id] = fut
    ch._conn_screenshot_requests[conn] = {req_id}

    png_data = "data:image/png;base64," + base64.b64encode(b"\x89PNG").decode()
    with patch("nanobot.channels.websocket.runtime.get_media_dir", return_value=tmp_path):
        await ch._dispatch_envelope(
            conn, "client-1",
            {"type": "screenshot_result", "request_id": req_id, "data": png_data},
        )

    assert fut.done()
    assert fut.result() is None


# ---------------------------------------------------------------------------
# screenshot_result — 体积超限被拒绝
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_screenshot_result_rejects_oversized(bus: MagicMock, tmp_path: Path) -> None:
    """超过 _MAX_SCREENSHOT_BYTES 的 screenshot_result 应被拒绝。"""
    ch = _ch(bus)
    conn = _mock_conn()
    req_id = "test-req-2"
    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    ch._screenshot_futures[req_id] = fut
    ch._conn_screenshot_requests[conn] = {req_id}

    # 构造超限 data URL：base64 内容长度使估算字节超过上限
    oversized_b64 = "A" * ((_MAX_SCREENSHOT_BYTES * 4 // 3) + 100)
    oversized = "data:image/jpeg;base64," + oversized_b64

    with patch("nanobot.channels.websocket.runtime.get_media_dir", return_value=tmp_path):
        await ch._dispatch_envelope(
            conn, "client-1",
            {"type": "screenshot_result", "request_id": req_id, "data": oversized},
        )

    assert fut.done()
    assert fut.result() is None


# ---------------------------------------------------------------------------
# screenshot_result — 无对应等待者时静默忽略
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_screenshot_result_unknown_request_id_is_ignored(
    bus: MagicMock, tmp_path: Path
) -> None:
    """未知 request_id 的 screenshot_result 静默丢弃，不报错。"""
    ch = _ch(bus)
    conn = _mock_conn()

    with patch("nanobot.channels.websocket.runtime.get_media_dir", return_value=tmp_path):
        # 不应抛出
        await ch._dispatch_envelope(
            conn, "client-1",
            {"type": "screenshot_result", "request_id": "nonexistent", "data": _jpeg_data_url()},
        )


# ---------------------------------------------------------------------------
# 断开连接时取消挂起的截图 future
# ---------------------------------------------------------------------------


def test_cleanup_cancels_pending_screenshot_futures(bus: MagicMock) -> None:
    """断开连接时，对应的挂起截图 future 应被取消。"""
    ch = _ch(bus)
    conn = _mock_conn()
    req_id = "test-req-3"
    loop = asyncio.new_event_loop()
    fut = loop.create_future()
    loop.close()
    ch._screenshot_futures[req_id] = fut
    ch._conn_screenshot_requests[conn] = {req_id}
    ch._conn_chats[conn] = set()

    ch._cleanup_connection(conn)

    assert fut.cancelled()
    assert req_id not in ch._screenshot_futures
    assert conn not in ch._conn_screenshot_requests


# ---------------------------------------------------------------------------
# screenshot_result 不写入 transcript
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_screenshot_result_does_not_write_transcript(
    bus: MagicMock, tmp_path: Path
) -> None:
    """screenshot_result 是专用通道，不经过 transcript 写入路径（_try_append_webui_transcript）。"""
    ch = _ch(bus)
    conn = _mock_conn()
    req_id = "test-req-4"
    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    ch._screenshot_futures[req_id] = fut
    ch._conn_screenshot_requests[conn] = {req_id}

    with (
        patch("nanobot.channels.websocket.runtime.get_media_dir", return_value=tmp_path),
        patch.object(ch._transcripts, "prepare_and_append") as mock_transcript,
    ):
        await ch._dispatch_envelope(
            conn, "client-1",
            {"type": "screenshot_result", "request_id": req_id, "data": _jpeg_data_url(200)},
        )

    mock_transcript.assert_not_called()
