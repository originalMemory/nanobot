"""Stable mapping between public WebUI chat IDs and persisted session keys."""

from __future__ import annotations

import re
from typing import Any, TypeGuard

from nanobot.session.keys import UNIFIED_SESSION_KEY

WEBUI_SESSION_STORAGE_PREFIX = "websocket:"
DESKTOP_CHAT_ID = "desktop"
_WEBUI_CHAT_ID_RE = re.compile(r"^[A-Za-z0-9_:-]{1,64}$")


def is_valid_webui_chat_id(value: Any) -> TypeGuard[str]:
    """Validate the compact chat IDs accepted by the WebUI protocol."""
    return isinstance(value, str) and _WEBUI_CHAT_ID_RE.fullmatch(value) is not None


def webui_session_key(chat_id: str) -> str:
    """Return the backward-compatible persisted key for a WebUI chat."""
    return f"{WEBUI_SESSION_STORAGE_PREFIX}{chat_id}"


def model_session_key(session_key: str, *, unified_session: bool) -> str:
    """固定桌面入口的模型状态归统一会话，显示记录仍使用 WebUI key。"""
    if unified_session and session_key == webui_session_key(DESKTOP_CHAT_ID):
        return UNIFIED_SESSION_KEY
    return session_key


def is_webui_session_key(session_key: str) -> bool:
    """Return whether *session_key* belongs to the WebUI session namespace."""
    return session_key.startswith(WEBUI_SESSION_STORAGE_PREFIX)


def webui_chat_id(session_key: str) -> str | None:
    """Extract a non-empty WebUI chat ID from a persisted session key."""
    if not is_webui_session_key(session_key):
        return None
    chat_id = session_key.removeprefix(WEBUI_SESSION_STORAGE_PREFIX)
    return chat_id or None
