from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from nanobot.agent.tools.context import RequestContext
from nanobot.agent.tools.tts import TtsTool, TtsToolConfig, strip_spoken_tags


def _resolved(voice: str = "candice-glm") -> SimpleNamespace:
    return SimpleNamespace(
        config=SimpleNamespace(provider="index-tts-2.5", model="index-tts-2.5"),
        voice=voice,
        fallback_config=None,
        fallback_voice=None,
    )


def _make_tool(
    tts_config: SimpleNamespace | None = None,
    speech_runtime: MagicMock | None = None,
) -> TtsTool:
    runtime = speech_runtime or MagicMock()
    runtime.submit.return_value = None
    tool = TtsTool(tts_config=tts_config or _resolved(), speech_runtime=runtime)
    tool.set_context(RequestContext("websocket", "chat", session_key="session", metadata={"webui_turn_id": "turn"}))
    return tool


def test_tool_name_and_schema() -> None:
    tool = _make_tool()
    assert tool.name == "tts"
    assert tool.parameters["required"] == ["text"]
    assert set(tool.parameters["properties"]) == {"text"}
    assert "[zh]" in tool.parameters["properties"]["text"]["description"]


def test_mode_is_direct_without_legacy_switches() -> None:
    assert TtsToolConfig().effective_mode == "off"
    assert TtsToolConfig(mode="agent").effective_mode == "agent"
    assert TtsToolConfig(mode="always").effective_mode == "always"


def test_create_uses_resolved_preset_config() -> None:
    ctx = MagicMock()
    ctx.tts_runtime_config = _resolved("candice-source")
    tool = TtsTool.create(ctx)
    assert tool._tts_config.voice == "candice-source"


@pytest.mark.asyncio
async def test_execute_submits_resolved_config() -> None:
    runtime = MagicMock()
    runtime.submit.return_value = None
    tool = _make_tool(speech_runtime=runtime)

    result = await tool.execute(text="[zh]你好。[/zh]")

    assert "已触发" in result
    assert runtime.submit.call_args.kwargs["config"].voice == "candice-glm"
    assert "voice" not in runtime.submit.call_args.kwargs


@pytest.mark.asyncio
async def test_execute_returns_error_without_resolved_preset() -> None:
    tool = _make_tool()
    tool._tts_config = None
    result = await tool.execute(text="你好")
    assert result.startswith("Error:")


def test_strip_spoken_tags_keeps_language_tags() -> None:
    assert strip_spoken_tags('<psb:timeline name="待机" />[zh]你好[/zh]') == "[zh]你好[/zh]"
