"""桌面上下文工具。"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import Field

from nanobot.agent.tools.base import Tool, tool_parameters
from nanobot.agent.tools.schema import BooleanSchema, NumberSchema, tool_parameters_schema
from nanobot.config.schema import Base
from nanobot.utils.helpers import build_image_content_blocks, detect_image_mime

if TYPE_CHECKING:
    from nanobot.channels.websocket import WebSocketChannel
    from nanobot.providers.base import LLMProvider

VisionProviderGetter = Callable[[], tuple["LLMProvider | None", str | None]]


class DesktopContextToolConfig(Base):
    """桌面上下文工具配置。"""

    enabled: bool = False
    screenshot_timeout_s: float = Field(default=10.0, ge=1.0, le=30.0)


@tool_parameters(
    tool_parameters_schema(
        capture_screenshot=BooleanSchema(
            description="Whether to request a screenshot from the last Electron user window.",
            default=True,
        ),
        timeout_s=NumberSchema(
            description="Screenshot request timeout in seconds.",
            minimum=1.0,
            maximum=30.0,
        ),
    )
)
class DesktopContextTool(Tool):
    """读取 Electron 桌面状态，并按需请求截图和视觉描述。"""

    _plugin_discoverable = False

    def __init__(
        self,
        ws_channel: "WebSocketChannel",
        *,
        config: DesktopContextToolConfig | None = None,
        vision_provider_getter: VisionProviderGetter | None = None,
    ) -> None:
        self._ws = ws_channel
        self._config = config or DesktopContextToolConfig()
        self._vision_provider_getter = vision_provider_getter

    @property
    def name(self) -> str:
        return "desktop_context"

    @property
    def description(self) -> str:
        return (
            "Get Electron desktop context for the last user window. "
            "Returns focus/lock eligibility and optional screenshot context. "
            "When agents.defaults.visionModel is configured, screenshots are described via that model; "
            "otherwise the screenshot is attached for the main model like a user image upload. "
            "Use this before proactive desktop-aware messages or when the user asks what is on screen."
        )

    def _inactive_state(self) -> dict[str, Any]:
        conn = getattr(self._ws, "_last_user_conn", None)
        defaults = getattr(self._ws, "_conn_default", {})
        connected = bool(conn is not None and conn in defaults)
        focused: bool | None = None
        locked: bool | None = None
        chat_id: str | None = None
        reason = "no_recent_user_connection"

        if conn is not None:
            if connected:
                chat_id = defaults.get(conn)
                focused = self._ws.is_connection_focused(conn)
                locked = self._ws.is_connection_locked(conn)
                if locked:
                    reason = "locked"
                elif focused:
                    reason = "focused"
                else:
                    reason = "not_eligible"
            else:
                reason = "disconnected"

        return {
            "connected": connected,
            "eligible": False,
            "reason": reason,
            "chat_id": chat_id,
            "focused": focused,
            "locked": locked,
            "screenshot_path": None,
            "caption": None,
            "caption_error": None,
        }

    async def _caption(self, screenshot_path: Path) -> tuple[str | None, str | None]:
        if self._vision_provider_getter is None:
            return None, None
        provider, model = self._vision_provider_getter()
        if provider is None or not model:
            return None, None
        try:
            from nanobot.agent.vision_caption import caption_images

            results = await caption_images(
                [str(screenshot_path)],
                provider=provider,
                model=model,
            )
        except Exception as exc:
            return None, str(exc)
        if not results:
            return None, "caption_empty"
        result = results[0]
        return result.text, result.error

    def _vision_configured(self) -> bool:
        if self._vision_provider_getter is None:
            return False
        provider, model = self._vision_provider_getter()
        return provider is not None and bool(model)

    def _format_screenshot_for_model(
        self,
        screenshot_path: Path,
        state: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """未配置辅助视觉模型时，像用户发图一样附带截图给主模型。"""
        raw = screenshot_path.read_bytes()
        mime = detect_image_mime(raw) or "image/jpeg"
        return build_image_content_blocks(
            raw,
            mime,
            str(screenshot_path),
            json.dumps(state, ensure_ascii=False),
        )

    async def _attach_screenshot_understanding(
        self,
        screenshot_path: Path,
        state: dict[str, Any],
    ) -> list[dict[str, Any]] | str:
        if self._vision_configured():
            caption, error = await self._caption(screenshot_path)
            state["caption"] = caption
            state["caption_error"] = error
            return json.dumps(state, ensure_ascii=False)

        return self._format_screenshot_for_model(screenshot_path, state)

    async def execute(
        self,
        capture_screenshot: bool = True,
        timeout_s: float | None = None,
        **_: Any,
    ) -> str | list[dict[str, Any]]:
        timeout = float(timeout_s if timeout_s is not None else self._config.screenshot_timeout_s)
        target = self._ws.get_unfocused_last_user_connection()
        if target is None:
            state = self._inactive_state()
            if not capture_screenshot:
                state["reason"] = "capture_disabled"
            return json.dumps(state, ensure_ascii=False)

        conn, chat_id = target
        state: dict[str, Any] = {
            "connected": True,
            "eligible": True,
            "reason": "eligible",
            "chat_id": chat_id,
            "focused": self._ws.is_connection_focused(conn),
            "locked": self._ws.is_connection_locked(conn),
            "screenshot_path": None,
            "caption": None,
            "caption_error": None,
        }
        if not capture_screenshot:
            state["reason"] = "capture_disabled"
            return json.dumps(state, ensure_ascii=False)

        screenshot_path = await self._ws.request_screenshot(conn, timeout_s=timeout)
        if screenshot_path is None:
            state["reason"] = "screenshot_unavailable"
            return json.dumps(state, ensure_ascii=False)

        state["screenshot_path"] = str(screenshot_path)
        return await self._attach_screenshot_understanding(screenshot_path, state)
