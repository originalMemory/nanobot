"""Tests for TtsTool agent tool."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanobot.agent.tools.tts import TtsTool


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
    return cfg


def _make_tool(
    tts_config: MagicMock | None = None,
    default_voice: str = "tongtong",
) -> TtsTool:
    return TtsTool(
        tts_config=tts_config or _make_tts_config(),
        default_voice=default_voice,
    )


# ---------------------------------------------------------------------------
# Tool metadata
# ---------------------------------------------------------------------------


def test_tool_name() -> None:
    assert _make_tool().name == "tts"


def test_tool_description_mentions_audio() -> None:
    desc = _make_tool().description
    assert "语音" in desc or "音频" in desc


def test_config_key() -> None:
    assert TtsTool.config_key == "tts"


# ---------------------------------------------------------------------------
# enabled() / create()
# ---------------------------------------------------------------------------


def test_enabled_when_tts_enabled() -> None:
    ctx = MagicMock()
    ctx.config.tts.enabled = True
    assert TtsTool.enabled(ctx) is True


def test_disabled_when_tts_disabled() -> None:
    ctx = MagicMock()
    ctx.config.tts.enabled = False
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
async def test_execute_returns_audio_path(tmp_path: Path) -> None:
    tool = _make_tool()
    synth = AsyncMock(return_value=True)
    with (
        patch("nanobot.providers.tts.build_tts_provider") as mock_build,
        patch("nanobot.config.paths.get_media_dir", return_value=tmp_path),
    ):
        provider_mock = MagicMock()
        provider_mock.synthesize = synth
        mock_build.return_value = provider_mock

        result = await tool.execute(text="你好")

    assert synth.await_count == 1
    assert result.endswith(".wav")
    assert "tts_" in result


@pytest.mark.asyncio
async def test_execute_strips_psb_tags_before_synthesis(tmp_path: Path) -> None:
    tool = _make_tool()
    synth = AsyncMock(return_value=True)
    with (
        patch("nanobot.providers.tts.build_tts_provider") as mock_build,
        patch("nanobot.config.paths.get_media_dir", return_value=tmp_path),
    ):
        provider_mock = MagicMock()
        provider_mock.synthesize = synth
        mock_build.return_value = provider_mock

        await tool.execute(text='<psb:timeline name="待机" /><psb:expression name="微笑" />你好')

    spoken = synth.call_args.args[0]
    assert spoken == "你好"
    assert "psb:" not in spoken


@pytest.mark.asyncio
async def test_execute_strips_tha_tags_before_synthesis(tmp_path: Path) -> None:
    tool = _make_tool()
    synth = AsyncMock(return_value=True)
    with (
        patch("nanobot.providers.tts.build_tts_provider") as mock_build,
        patch("nanobot.config.paths.get_media_dir", return_value=tmp_path),
    ):
        provider_mock = MagicMock()
        provider_mock.synthesize = synth
        mock_build.return_value = provider_mock

        await tool.execute(text="<happy><nod>你好")

    spoken = synth.call_args.args[0]
    assert spoken == "你好"
    assert "<" not in spoken


@pytest.mark.asyncio
async def test_execute_uses_default_voice(tmp_path: Path) -> None:
    tool = _make_tool(default_voice="chuichui")
    synth = AsyncMock(return_value=True)
    with (
        patch("nanobot.providers.tts.build_tts_provider") as mock_build,
        patch("nanobot.config.paths.get_media_dir", return_value=tmp_path),
    ):
        provider_mock = MagicMock()
        provider_mock.synthesize = synth
        mock_build.return_value = provider_mock

        await tool.execute(text="hello")

    _, kwargs = synth.call_args
    assert kwargs.get("voice") == "chuichui" or synth.call_args.args[1] == "chuichui"


@pytest.mark.asyncio
async def test_execute_uses_explicit_voice(tmp_path: Path) -> None:
    tool = _make_tool(default_voice="tongtong")
    synth = AsyncMock(return_value=True)
    with (
        patch("nanobot.providers.tts.build_tts_provider") as mock_build,
        patch("nanobot.config.paths.get_media_dir", return_value=tmp_path),
    ):
        provider_mock = MagicMock()
        provider_mock.synthesize = synth
        mock_build.return_value = provider_mock

        await tool.execute(text="hi", voice="xiaochen")

    call_args = synth.call_args
    passed_voice = call_args.kwargs.get("voice") or call_args.args[1]
    assert passed_voice == "xiaochen"


# ---------------------------------------------------------------------------
# execute() — failure path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_execute_returns_error_on_failure(tmp_path: Path) -> None:
    tool = _make_tool()
    synth = AsyncMock(return_value=False)
    with (
        patch("nanobot.providers.tts.build_tts_provider") as mock_build,
        patch("nanobot.config.paths.get_media_dir", return_value=tmp_path),
    ):
        provider_mock = MagicMock()
        provider_mock.synthesize = synth
        mock_build.return_value = provider_mock

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


def test_validate_params_accepts_text_and_voice() -> None:
    tool = _make_tool()
    errors = tool.validate_params({"text": "hello", "voice": "chuichui"})
    assert errors == []


def test_validate_params_rejects_empty_text() -> None:
    tool = _make_tool()
    errors = tool.validate_params({"text": ""})
    assert errors  # minLength=1 violated
