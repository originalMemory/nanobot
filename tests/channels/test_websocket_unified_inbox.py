"""Tests for stable chat_id, unified transcript double-write, fan-out, and inbox endpoint.

Covers tasks 1.4, 2.4, 3.5, and 4.4 of the electron-unified-inbox change.
"""

from __future__ import annotations

import asyncio
import functools
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from nanobot.bus.events import OutboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.channels.websocket import (
    WebSocketChannel,
    _INBOX_UNIFIED_CHAT_ID,
    _is_valid_chat_id,
)
from nanobot.session.manager import SessionManager
from ws_test_client import WsTestClient


_PORT_BASE = 29950  # Port range for this test file


def _ch(
    bus: Any,
    port: int,
    *,
    session_manager: SessionManager | None = None,
    unified_session: bool = False,
    workspace_path: Path | None = None,
    **kw: Any,
) -> WebSocketChannel:
    cfg: dict[str, Any] = {
        "enabled": True,
        "allowFrom": ["*"],
        "host": "127.0.0.1",
        "port": port,
        "path": "/",
        "websocketRequiresToken": False,
    }
    cfg.update(kw)
    return WebSocketChannel(
        cfg,
        bus,
        session_manager=session_manager,
        unified_session=unified_session,
        workspace_path=workspace_path,
    )


@pytest.fixture()
def bus() -> MagicMock:
    b = MagicMock()
    b.publish_inbound = AsyncMock()
    return b


async def _http_get(url: str, headers: dict[str, str] | None = None) -> httpx.Response:
    return await asyncio.to_thread(
        functools.partial(httpx.get, url, headers=headers or {}, timeout=5.0)
    )


# ---------------------------------------------------------------------------
# Task 1.4 — Stable chat_id: validation and URL param support
# ---------------------------------------------------------------------------


def test_is_valid_chat_id_accepts_alphanumeric_hyphen_underscore() -> None:
    assert _is_valid_chat_id("electron-main") is True
    assert _is_valid_chat_id("chat_01") is True
    assert _is_valid_chat_id("abc123") is True
    assert _is_valid_chat_id("a" * 64) is True  # max length


def test_is_valid_chat_id_accepts_colon() -> None:
    assert _is_valid_chat_id("inbox:unified") is True
    assert _is_valid_chat_id("unified:default") is True


def test_is_valid_chat_id_rejects_path_traversal() -> None:
    assert _is_valid_chat_id("../../etc/passwd") is False
    assert _is_valid_chat_id("../foo") is False
    assert _is_valid_chat_id("/etc/passwd") is False


def test_is_valid_chat_id_rejects_too_long() -> None:
    assert _is_valid_chat_id("a" * 65) is False


def test_is_valid_chat_id_rejects_empty() -> None:
    assert _is_valid_chat_id("") is False
    assert _is_valid_chat_id(None) is False


@pytest.mark.asyncio
async def test_stable_chat_id_via_url_param(bus: MagicMock, tmp_path: Path) -> None:
    """Task 1.1: ?chat_id=electron-main should be used as default_chat_id."""
    import websockets

    ch = _ch(bus, _PORT_BASE, workspace_path=tmp_path)
    t = asyncio.create_task(ch.start())
    await asyncio.sleep(0.3)
    try:
        uri = f"ws://127.0.0.1:{_PORT_BASE}/?client_id=electron&chat_id=electron-main"
        async with websockets.connect(uri) as ws:
            data = json.loads(await asyncio.wait_for(ws.recv(), timeout=2.0))
            assert data["event"] == "ready"
            assert data["chat_id"] == "electron-main"
    finally:
        await ch.stop()
        await t


@pytest.mark.asyncio
async def test_invalid_url_chat_id_falls_back_to_uuid(bus: MagicMock, tmp_path: Path) -> None:
    """Task 1.1: invalid ?chat_id= param is ignored and UUID is assigned."""
    import websockets

    ch = _ch(bus, _PORT_BASE + 1, workspace_path=tmp_path)
    t = asyncio.create_task(ch.start())
    await asyncio.sleep(0.3)
    try:
        # "../../bad" has '/' which is invalid → falls back to UUID
        uri = f"ws://127.0.0.1:{_PORT_BASE + 1}/?client_id=c&chat_id=..%2F..%2Fbad"
        async with websockets.connect(uri) as ws:
            data = json.loads(await asyncio.wait_for(ws.recv(), timeout=2.0))
            assert data["event"] == "ready"
            assert data["chat_id"] != "../../bad"
            # UUID has length 36
            assert len(data["chat_id"]) == 36
    finally:
        await ch.stop()
        await t


@pytest.mark.asyncio
async def test_attach_invalid_chat_id_returns_error(bus: MagicMock, tmp_path: Path) -> None:
    """Task 1.3: attach with path-traversal chat_id should return error."""
    ch = _ch(bus, _PORT_BASE + 2, workspace_path=tmp_path)
    t = asyncio.create_task(ch.start())
    await asyncio.sleep(0.3)
    try:
        async with WsTestClient(f"ws://127.0.0.1:{_PORT_BASE + 2}/", client_id="c") as c:
            await c.recv_ready()
            await c.ws.send(json.dumps({"type": "attach", "chat_id": "../../etc/passwd"}))
            raw = json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
            assert raw["event"] == "error"
            assert "invalid" in raw.get("detail", "").lower()
    finally:
        await ch.stop()
        await t


@pytest.mark.asyncio
async def test_attach_creates_session_in_manager(bus: MagicMock, tmp_path: Path) -> None:
    """Task 1.2: attaching to a new chat_id should create the session."""
    sm = SessionManager(tmp_path)
    ch = _ch(bus, _PORT_BASE + 3, session_manager=sm, workspace_path=tmp_path)
    t = asyncio.create_task(ch.start())
    await asyncio.sleep(0.3)
    try:
        async with WsTestClient(f"ws://127.0.0.1:{_PORT_BASE + 3}/", client_id="c") as c:
            await c.recv_ready()
            await c.ws.send(json.dumps({"type": "attach", "chat_id": "electron-main"}))
            raw = json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
            assert raw["event"] == "attached"
            assert raw["chat_id"] == "electron-main"
            # Session should now be in the manager's cache
            assert "websocket:electron-main" in sm._cache
    finally:
        await ch.stop()
        await t


# ---------------------------------------------------------------------------
# Task 3.5 — Fan-out: inbox:unified subscription and message delivery
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_attach_inbox_unified_succeeds(bus: MagicMock, tmp_path: Path) -> None:
    """Task 3.1: attaching to inbox:unified should return attached event."""
    ch = _ch(bus, _PORT_BASE + 4, unified_session=True, workspace_path=tmp_path)
    t = asyncio.create_task(ch.start())
    await asyncio.sleep(0.3)
    try:
        async with WsTestClient(f"ws://127.0.0.1:{_PORT_BASE + 4}/", client_id="e") as c:
            await c.recv_ready()
            await c.ws.send(json.dumps({"type": "attach", "chat_id": "inbox:unified"}))
            raw = json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
            assert raw["event"] == "attached"
            assert raw["chat_id"] == "inbox:unified"
    finally:
        await ch.stop()
        await t


@pytest.mark.asyncio
async def test_fanout_to_inbox_unified_on_ws_message(bus: MagicMock, tmp_path: Path) -> None:
    """Task 3.2: outbound message to chat_id should also fan-out to inbox:unified."""
    ch = _ch(bus, _PORT_BASE + 5, unified_session=True, workspace_path=tmp_path)
    t = asyncio.create_task(ch.start())
    await asyncio.sleep(0.3)
    try:
        async with WsTestClient(
            f"ws://127.0.0.1:{_PORT_BASE + 5}/", client_id="electron"
        ) as inbox_client:
            await inbox_client.recv_ready()
            # Subscribe to inbox:unified
            await inbox_client.ws.send(
                json.dumps({"type": "attach", "chat_id": "inbox:unified"})
            )
            attached = json.loads(await asyncio.wait_for(inbox_client.ws.recv(), timeout=2.0))
            assert attached["event"] == "attached"

            # Another client sends a chat message, agent responds
            async with WsTestClient(
                f"ws://127.0.0.1:{_PORT_BASE + 5}/", client_id="user"
            ) as user_client:
                ready = await user_client.recv_ready()
                chat_id = ready.chat_id

                # Simulate agent outbound to the user chat_id
                await ch.send(OutboundMessage(
                    channel="websocket",
                    chat_id=chat_id,
                    content="hello from agent",
                ))

                # The user connection should receive the message
                user_msg = json.loads(await asyncio.wait_for(user_client.ws.recv(), timeout=2.0))
                assert user_msg["event"] == "message"
                assert user_msg["text"] == "hello from agent"

                # The inbox:unified subscriber should ALSO receive it with source_channel
                inbox_msg = json.loads(
                    await asyncio.wait_for(inbox_client.ws.recv(), timeout=2.0)
                )
                assert inbox_msg["event"] == "message"
                assert inbox_msg["text"] == "hello from agent"
                assert inbox_msg["source_channel"] == "websocket"
                assert inbox_msg["source_chat_id"] == chat_id
    finally:
        await ch.stop()
        await t


@pytest.mark.asyncio
async def test_no_duplicate_when_subscribed_to_both(bus: MagicMock, tmp_path: Path) -> None:
    """Task 3.4: if a client subscribes to both chat_id and inbox:unified, it
    should receive the message only once (dedup by connection set)."""
    ch = _ch(bus, _PORT_BASE + 6, unified_session=True, workspace_path=tmp_path)
    t = asyncio.create_task(ch.start())
    await asyncio.sleep(0.3)
    try:
        async with WsTestClient(
            f"ws://127.0.0.1:{_PORT_BASE + 6}/", client_id="e"
        ) as c:
            ready = await c.recv_ready()
            chat_id = ready.chat_id
            # Subscribe to inbox:unified as well
            await c.ws.send(json.dumps({"type": "attach", "chat_id": "inbox:unified"}))
            attached = json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
            assert attached["event"] == "attached"

            # Send a message and expect exactly one delivery
            await ch.send(OutboundMessage(
                channel="websocket",
                chat_id=chat_id,
                content="dedup test",
            ))

            msg1 = json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
            assert msg1["event"] == "message"
            assert msg1["text"] == "dedup test"

            # Should NOT receive a second copy
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(c.ws.recv(), timeout=0.3)
    finally:
        await ch.stop()
        await t


@pytest.mark.asyncio
async def test_non_ws_inbound_fan_out_to_inbox_unified(bus: MagicMock, tmp_path: Path) -> None:
    """Task 3.3 / 2.3: _unified_inbox_inbound shadow message fans out to inbox:unified."""
    ch = _ch(bus, _PORT_BASE + 7, unified_session=True, workspace_path=tmp_path)
    t = asyncio.create_task(ch.start())
    await asyncio.sleep(0.3)
    try:
        async with WsTestClient(
            f"ws://127.0.0.1:{_PORT_BASE + 7}/", client_id="e"
        ) as c:
            await c.recv_ready()
            await c.ws.send(json.dumps({"type": "attach", "chat_id": "inbox:unified"}))
            attached = json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
            assert attached["event"] == "attached"

            # Simulate AgentLoop publishing an inbound shadow from Telegram
            await ch.send(OutboundMessage(
                channel="websocket",
                chat_id="inbox:unified",
                content="hi from telegram",
                metadata={
                    "_unified_inbox_inbound": True,
                    "source_channel": "telegram",
                    "source_chat_id": "tg-123",
                },
            ))

            msg = json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
            assert msg["event"] == "user"
            assert msg["text"] == "hi from telegram"
            assert msg["source_channel"] == "telegram"
    finally:
        await ch.stop()
        await t


@pytest.mark.asyncio
async def test_non_ws_outbound_fan_out_to_inbox_unified(bus: MagicMock, tmp_path: Path) -> None:
    """Task 3.3 / 2.2: _unified_inbox_write shadow message fans out to inbox:unified."""
    ch = _ch(bus, _PORT_BASE + 8, unified_session=True, workspace_path=tmp_path)
    t = asyncio.create_task(ch.start())
    await asyncio.sleep(0.3)
    try:
        async with WsTestClient(
            f"ws://127.0.0.1:{_PORT_BASE + 8}/", client_id="e"
        ) as c:
            await c.recv_ready()
            await c.ws.send(json.dumps({"type": "attach", "chat_id": "inbox:unified"}))
            attached = json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
            assert attached["event"] == "attached"

            # Simulate ChannelManager publishing shadow for Telegram outbound
            await ch.send(OutboundMessage(
                channel="websocket",
                chat_id="inbox:unified",
                content="reply via telegram",
                metadata={
                    "_unified_inbox_write": True,
                    "source_channel": "telegram",
                    "source_chat_id": "tg-123",
                },
            ))

            msg = json.loads(await asyncio.wait_for(c.ws.recv(), timeout=2.0))
            assert msg["event"] == "message"
            assert msg["text"] == "reply via telegram"
            assert msg["source_channel"] == "telegram"
    finally:
        await ch.stop()
        await t


# ---------------------------------------------------------------------------
# Task 2.4 — Unified transcript double-write
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ws_outbound_no_longer_writes_unified_transcript(
    bus: MagicMock, tmp_path: Path
) -> None:
    """After Plan B refactor, send() no longer writes to unified:default transcript file.
    History is served from the Session object directly."""
    from nanobot.webui.transcript import read_transcript_lines

    ch = _ch(bus, _PORT_BASE + 9, unified_session=True)
    with patch("nanobot.webui.transcript.get_webui_dir", return_value=tmp_path):
        t = asyncio.create_task(ch.start())
        await asyncio.sleep(0.3)
        try:
            async with WsTestClient(
                f"ws://127.0.0.1:{_PORT_BASE + 9}/", client_id="c"
            ) as c:
                ready = await c.recv_ready()
                chat_id = ready.chat_id

                await ch.send(OutboundMessage(
                    channel="websocket",
                    chat_id=chat_id,
                    content="hello unified",
                ))
                await asyncio.wait_for(c.ws.recv(), timeout=2.0)

            await asyncio.sleep(0.1)
            lines = read_transcript_lines("unified:default")
            assert lines == [], "unified transcript file should no longer be written"
        finally:
            await ch.stop()
            await t


@pytest.mark.asyncio
async def test_ws_inbound_no_longer_writes_unified_transcript(
    bus: MagicMock, tmp_path: Path
) -> None:
    """After Plan B refactor, inbound WebSocket messages no longer write to
    unified:default transcript file."""
    from nanobot.webui.transcript import read_transcript_lines

    ch = _ch(bus, _PORT_BASE + 10, unified_session=True)
    with patch("nanobot.webui.transcript.get_webui_dir", return_value=tmp_path):
        t = asyncio.create_task(ch.start())
        await asyncio.sleep(0.3)
        try:
            async with WsTestClient(
                f"ws://127.0.0.1:{_PORT_BASE + 10}/", client_id="c"
            ) as c:
                ready = await c.recv_ready()
                chat_id = ready.chat_id
                await c.ws.send(json.dumps({
                    "type": "message",
                    "chat_id": chat_id,
                    "content": "hello from electron",
                    "webui": True,
                }))
                await asyncio.sleep(0.2)

            lines = read_transcript_lines("unified:default")
            assert lines == [], "unified transcript file should no longer be written"
        finally:
            await ch.stop()
            await t


# ---------------------------------------------------------------------------
# Task 4.4 — Inbox HTTP endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_inbox_thread_requires_auth(bus: MagicMock, tmp_path: Path) -> None:
    """Task 4.3: /api/inbox/thread returns 401 when no valid token is supplied."""
    ch = _ch(bus, _PORT_BASE + 11, workspace_path=tmp_path)
    t = asyncio.create_task(ch.start())
    await asyncio.sleep(0.3)
    try:
        resp = await _http_get(f"http://127.0.0.1:{_PORT_BASE + 11}/api/inbox/thread")
        assert resp.status_code == 401
    finally:
        await ch.stop()
        await t


@pytest.mark.asyncio
async def test_inbox_thread_returns_empty_when_no_session(
    bus: MagicMock, tmp_path: Path
) -> None:
    """Plan B: /api/inbox/thread returns empty messages when session has no messages."""
    sm = SessionManager(workspace=tmp_path)
    ch = _ch(bus, _PORT_BASE + 12, session_manager=sm, workspace_path=tmp_path)
    t = asyncio.create_task(ch.start())
    await asyncio.sleep(0.3)
    try:
        resp_bs = await asyncio.to_thread(
            functools.partial(
                httpx.get,
                f"http://127.0.0.1:{_PORT_BASE + 12}/webui/bootstrap",
                timeout=5.0,
            )
        )
        assert resp_bs.status_code == 200
        token = resp_bs.json()["token"]

        resp = await _http_get(
            f"http://127.0.0.1:{_PORT_BASE + 12}/api/inbox/thread",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["messages"] == []
    finally:
        await ch.stop()
        await t


@pytest.mark.asyncio
async def test_inbox_thread_returns_messages_from_session(
    bus: MagicMock, tmp_path: Path
) -> None:
    """Plan B: /api/inbox/thread reads from Session (file 1) via converter."""
    sm = SessionManager(workspace=tmp_path)
    session = sm.get_or_create("unified:default")
    session.add_message("user", "hey telegram",
                        source_channel="telegram", source_chat_id="tg-1")
    session.add_message("assistant", "hello back",
                        source_channel="telegram", source_chat_id="tg-1",
                        latency_ms=500)
    sm.save(session)

    ch = _ch(bus, _PORT_BASE + 13, session_manager=sm, workspace_path=tmp_path)
    t = asyncio.create_task(ch.start())
    await asyncio.sleep(0.3)
    try:
        resp_bs = await asyncio.to_thread(
            functools.partial(
                httpx.get,
                f"http://127.0.0.1:{_PORT_BASE + 13}/webui/bootstrap",
                timeout=5.0,
            )
        )
        assert resp_bs.status_code == 200
        token = resp_bs.json()["token"]

        resp = await _http_get(
            f"http://127.0.0.1:{_PORT_BASE + 13}/api/inbox/thread",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["messages"]) >= 2
        roles = [m["role"] for m in data["messages"]]
        assert "user" in roles
        assert "assistant" in roles
    finally:
        await ch.stop()
        await t
