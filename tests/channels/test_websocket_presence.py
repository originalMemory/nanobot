"""WebSocketChannel client-presence 功能单测（任务组 4）。"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.channels.websocket import WebSocketChannel


def _ch(bus: Any, **kw: Any) -> WebSocketChannel:
    cfg: dict[str, Any] = {
        "enabled": True,
        "allowFrom": ["*"],
        "host": "127.0.0.1",
        "port": 29877,
        "path": "/ws",
        "websocketRequiresToken": False,
    }
    cfg.update(kw)
    return WebSocketChannel(cfg, bus)


@pytest.fixture()
def bus() -> MagicMock:
    b = MagicMock()
    b.publish_inbound = AsyncMock()
    return b


def _mock_conn() -> MagicMock:
    """返回一个模拟 WebSocket 连接对象。"""
    conn = MagicMock()
    conn.send = AsyncMock()
    return conn


# ---------------------------------------------------------------------------
# is_connection_focused — 默认值
# ---------------------------------------------------------------------------


def test_is_connection_focused_default_true(bus: MagicMock) -> None:
    """未上报 presence 时，连接默认视为获焦。"""
    ch = _ch(bus)
    conn = _mock_conn()
    assert ch.is_connection_focused(conn) is True


# ---------------------------------------------------------------------------
# presence 入站处理 — 状态更新
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dispatch_presence_focused_false(bus: MagicMock) -> None:
    """收到 presence focused=false 后，连接焦点状态更新为 False。"""
    ch = _ch(bus)
    conn = _mock_conn()
    ch._conn_default[conn] = "chat-1"

    envelope = {"type": "presence", "focused": False}
    await ch._dispatch_envelope(conn, "client-1", envelope)

    assert ch.is_connection_focused(conn) is False


@pytest.mark.asyncio
async def test_dispatch_presence_focused_true(bus: MagicMock) -> None:
    """收到 presence focused=true 后，连接焦点状态更新为 True。"""
    ch = _ch(bus)
    conn = _mock_conn()
    # 先置为失焦
    ch._conn_focused[conn] = False

    envelope = {"type": "presence", "focused": True}
    await ch._dispatch_envelope(conn, "client-1", envelope)

    assert ch.is_connection_focused(conn) is True


@pytest.mark.asyncio
async def test_dispatch_presence_missing_focused_defaults_true(bus: MagicMock) -> None:
    """presence 缺少 focused 字段时，默认视为获焦。"""
    ch = _ch(bus)
    conn = _mock_conn()
    ch._conn_focused[conn] = False

    envelope = {"type": "presence"}  # 无 focused 字段
    await ch._dispatch_envelope(conn, "client-1", envelope)

    assert ch.is_connection_focused(conn) is True


@pytest.mark.asyncio
async def test_dispatch_presence_does_not_reply(bus: MagicMock) -> None:
    """presence 事件是单向上报，服务端不应回复任何帧。"""
    ch = _ch(bus)
    conn = _mock_conn()

    await ch._dispatch_envelope(conn, "client-1", {"type": "presence", "focused": False})

    conn.send.assert_not_called()


# ---------------------------------------------------------------------------
# 断开连接时清理 focused 状态
# ---------------------------------------------------------------------------


def test_cleanup_connection_removes_focused_state(bus: MagicMock) -> None:
    """断开连接后，focused 状态被清除，不留残余。"""
    ch = _ch(bus)
    conn = _mock_conn()
    ch._conn_focused[conn] = False
    ch._conn_default[conn] = "chat-1"
    ch._subs["chat-1"] = {conn}
    ch._conn_chats[conn] = {"chat-1"}

    ch._cleanup_connection(conn)

    assert conn not in ch._conn_focused


def test_cleanup_unknown_connection_is_safe(bus: MagicMock) -> None:
    """对未注册的连接调用 _cleanup_connection 不应抛异常。"""
    ch = _ch(bus)
    conn = _mock_conn()
    ch._cleanup_connection(conn)  # 不应抛出


# ---------------------------------------------------------------------------
# get_unfocused_last_user_connection
# ---------------------------------------------------------------------------


def test_last_user_connection_none_when_no_user_message(bus: MagicMock) -> None:
    """从未收到 user 消息时返回 None。"""
    ch = _ch(bus)
    assert ch.get_unfocused_last_user_connection() is None


def test_last_user_connection_none_when_focused(bus: MagicMock) -> None:
    """最近用户连接仍在前台时返回 None（不打扰）。"""
    ch = _ch(bus)
    conn = _mock_conn()
    ch._conn_default[conn] = "chat-a"
    ch._last_user_conn = conn
    # 默认获焦

    assert ch.get_unfocused_last_user_connection() is None


def test_last_user_connection_returns_when_unfocused(bus: MagicMock) -> None:
    """最近用户连接失焦且在线时返回 (conn, chat_id)。"""
    ch = _ch(bus)
    conn = _mock_conn()
    ch._conn_default[conn] = "chat-a"
    ch._conn_focused[conn] = False
    ch._last_user_conn = conn

    assert ch.get_unfocused_last_user_connection() == (conn, "chat-a")


def test_last_user_connection_none_when_disconnected(bus: MagicMock) -> None:
    """最近用户连接已断开（不在默认映射中）时返回 None。"""
    ch = _ch(bus)
    conn = _mock_conn()
    # 模拟断开：_last_user_conn 仍指向旧连接，但已从 _conn_default 移除
    ch._conn_focused[conn] = False
    ch._last_user_conn = conn

    assert ch.get_unfocused_last_user_connection() is None


def test_cleanup_connection_clears_last_user_conn(bus: MagicMock) -> None:
    """断开最近用户连接后，_last_user_conn 被清空。"""
    ch = _ch(bus)
    conn = _mock_conn()
    ch._conn_default[conn] = "chat-a"
    ch._last_user_conn = conn

    ch._cleanup_connection(conn)

    assert ch._last_user_conn is None


# ---------------------------------------------------------------------------
# locked 状态：上报与默认值
# ---------------------------------------------------------------------------


def test_is_connection_locked_default_false(bus: MagicMock) -> None:
    """未上报锁屏时，连接默认视为未锁屏。"""
    ch = _ch(bus)
    conn = _mock_conn()
    assert ch.is_connection_locked(conn) is False


@pytest.mark.asyncio
async def test_dispatch_presence_locked_true(bus: MagicMock) -> None:
    """收到 presence locked=true 后，锁屏状态更新为 True。"""
    ch = _ch(bus)
    conn = _mock_conn()
    ch._conn_default[conn] = "chat-1"

    envelope = {"type": "presence", "focused": False, "locked": True}
    await ch._dispatch_envelope(conn, "client-1", envelope)

    assert ch.is_connection_locked(conn) is True


@pytest.mark.asyncio
async def test_dispatch_presence_locked_false(bus: MagicMock) -> None:
    """收到 presence locked=false 后，锁屏状态更新为 False。"""
    ch = _ch(bus)
    conn = _mock_conn()
    ch._conn_locked[conn] = True  # 预设为锁屏

    envelope = {"type": "presence", "focused": False, "locked": False}
    await ch._dispatch_envelope(conn, "client-1", envelope)

    assert ch.is_connection_locked(conn) is False


@pytest.mark.asyncio
async def test_dispatch_presence_missing_locked_keeps_default(bus: MagicMock) -> None:
    """presence 缺少 locked 字段时，不修改原有锁屏状态。"""
    ch = _ch(bus)
    conn = _mock_conn()
    # 缺少 locked 字段，_conn_locked 不应被更新
    envelope = {"type": "presence", "focused": False}
    await ch._dispatch_envelope(conn, "client-1", envelope)

    assert conn not in ch._conn_locked  # 未被写入


def test_cleanup_connection_removes_locked_state(bus: MagicMock) -> None:
    """断开连接后，locked 状态被清除。"""
    ch = _ch(bus)
    conn = _mock_conn()
    ch._conn_locked[conn] = True
    ch._conn_default[conn] = "chat-1"
    ch._subs["chat-1"] = {conn}
    ch._conn_chats[conn] = {"chat-1"}

    ch._cleanup_connection(conn)

    assert conn not in ch._conn_locked


def test_last_user_connection_none_when_locked(bus: MagicMock) -> None:
    """最近用户连接失焦但屏幕已锁时返回 None（不触发主动陪伴）。"""
    ch = _ch(bus)
    conn = _mock_conn()
    ch._conn_default[conn] = "chat-a"
    ch._conn_focused[conn] = False
    ch._conn_locked[conn] = True
    ch._last_user_conn = conn

    assert ch.get_unfocused_last_user_connection() is None


# ---------------------------------------------------------------------------
# stop() 清理 _conn_focused / _conn_locked
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stop_clears_focused_state(bus: MagicMock) -> None:
    """stop() 后 _conn_focused 和 _conn_locked 被清空。"""
    ch = _ch(bus)
    conn = _mock_conn()
    ch._conn_focused[conn] = False
    ch._conn_locked[conn] = True
    ch._running = True
    ch._stop_event = None
    ch._server_task = None

    await ch.stop()

    assert ch._conn_focused == {}
    assert ch._conn_locked == {}
