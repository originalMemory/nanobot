"""Tests for TtsTool agent tool."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.agent.tools.context import RequestContext
from nanobot.agent.tools.tts import TtsTool, TtsToolConfig, strip_spoken_tags


def _make_tts_config(
    provider: str = "glm-tts",
    api_base: str = "https://open.bigmodel.cn/api/paas/v4",
    api_key: str | None = "sk-test",
    model: str = "glm-tts",
    response_format: str = "wav",
    speed: float = 1.0,
    extra_body: dict | None = None,
) -> MagicMock:
    cfg = MagicMock()
    cfg.provider = provider
    cfg.api_base = api_base
    cfg.api_key = api_key
    cfg.model = model
    cfg.response_format = response_format
    cfg.speed = speed
    cfg.extra_body = extra_body or {}
    cfg.effective_mode = "agent"
    return cfg


def _make_tool(
    tts_config: MagicMock | None = None,
    default_voice: str = "tongtong",
    speech_runtime: MagicMock | None = None,
) -> TtsTool:
    runtime = speech_runtime
    if runtime is None:
        runtime = MagicMock()
        runtime.synthesize = AsyncMock(return_value=(MagicMock(), None))
    tool = TtsTool(
        tts_config=tts_config or _make_tts_config(),
        default_voice=default_voice,
        speech_runtime=runtime,
    )
    tool.set_context(RequestContext("websocket", "chat", session_key="session", metadata={"webui_turn_id": "turn"}))
    return tool


# ---------------------------------------------------------------------------
# Tool metadata
# ---------------------------------------------------------------------------


def test_tool_name() -> None:
    assert _make_tool().name == "tts"


def test_tool_description_mentions_audio() -> None:
    desc = _make_tool().description
    assert "语音" in desc or "音频" in desc


def test_tool_schema_only_exposes_text() -> None:
    tool = _make_tool()
    assert tool.parameters["required"] == ["text"]
    assert set(tool.parameters["properties"]) == {"text"}
    assert "系统配置" in tool.parameters["properties"]["text"]["description"]


def test_config_key() -> None:
    assert TtsTool.config_key == "tts"


def test_legacy_tts_switches_map_to_mode() -> None:
    assert TtsToolConfig(enabled=False).effective_mode == "off"
    assert TtsToolConfig(enabled=True).effective_mode == "agent"
    assert TtsToolConfig(enabled=True, messagePlaybackEnabled=True).effective_mode == "always"
    assert TtsToolConfig(enabled=True, mode="off").effective_mode == "off"


# ---------------------------------------------------------------------------
# enabled() / create()
# ---------------------------------------------------------------------------


def test_enabled_when_tts_enabled() -> None:
    ctx = MagicMock()
    ctx.config.tts.effective_mode = "agent"
    assert TtsTool.enabled(ctx) is True


def test_disabled_when_tts_disabled() -> None:
    ctx = MagicMock()
    ctx.config.tts.effective_mode = "off"
    assert TtsTool.enabled(ctx) is False


def test_create_uses_tts_config() -> None:
    ctx = MagicMock()
    ctx.config.tts.default_voice = "chuichui"
    tool = TtsTool.create(ctx)
    assert isinstance(tool, TtsTool)
    assert tool._default_voice == "chuichui"


# ---------------------------------------------------------------------------
# execute() — success path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_execute_attaches_audio_to_turn() -> None:
    runtime = MagicMock()
    runtime.synthesize = AsyncMock(return_value=(MagicMock(), None))
    tool = _make_tool(speech_runtime=runtime)

    result = await tool.execute(text="你好")

    runtime.synthesize.assert_awaited_once()
    assert "附着" in result


@pytest.mark.asyncio
async def test_execute_strips_psb_tags_before_synthesis() -> None:
    spoken = strip_spoken_tags('<psb:timeline name="待机" /><psb:expression name="微笑" />你好')
    assert spoken == "你好"
    assert "psb:" not in spoken


@pytest.mark.asyncio
async def test_execute_strips_tha_tags_before_synthesis() -> None:
    spoken = strip_spoken_tags("<happy><nod>你好")
    assert spoken == "你好"
    assert "<" not in spoken


@pytest.mark.asyncio
async def test_execute_uses_default_voice() -> None:
    runtime = MagicMock()
    runtime.synthesize = AsyncMock(return_value=(MagicMock(), None))
    tool = _make_tool(default_voice="chuichui", speech_runtime=runtime)

    await tool.execute(text="hello")

    assert runtime.synthesize.await_args.kwargs["voice"] == "chuichui"


@pytest.mark.asyncio
async def test_execute_ignores_legacy_voice_argument() -> None:
    runtime = MagicMock()
    runtime.synthesize = AsyncMock(return_value=(MagicMock(), None))
    tool = _make_tool(default_voice="tongtong", speech_runtime=runtime)

    await tool.execute(text="hi", voice="xiaochen")

    assert runtime.synthesize.await_args.kwargs["voice"] == "tongtong"


# ---------------------------------------------------------------------------
# execute() — failure path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_execute_returns_error_without_configured_voice() -> None:
    tool = _make_tool(default_voice="")
    result = await tool.execute(text="hello")

    assert result.startswith("Error:")
    assert "defaultVoice" in result


@pytest.mark.asyncio
async def test_execute_returns_error_on_failure() -> None:
    runtime = MagicMock()
    runtime.synthesize = AsyncMock(return_value=(None, "failed"))
    tool = _make_tool(speech_runtime=runtime)

    result = await tool.execute(text="fail")

    assert result.startswith("Error:")


# ---------------------------------------------------------------------------
# Parameter schema validation
# ---------------------------------------------------------------------------


def test_validate_params_requires_text() -> None:
    tool = _make_tool()
    errors = tool.validate_params({})
    assert any("text" in e for e in errors)


def test_validate_params_accepts_text_only() -> None:
    tool = _make_tool()
    errors = tool.validate_params({"text": "hello"})
    assert errors == []


def test_execute_signature_does_not_expose_voice() -> None:
    import inspect

    parameters = inspect.signature(TtsTool.execute).parameters
    assert "voice" not in parameters
    assert any(parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters.values())


def test_validate_params_rejects_empty_text() -> None:
    tool = _make_tool()
    errors = tool.validate_params({"text": ""})
    assert errors  # minLength=1 violated
