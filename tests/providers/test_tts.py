"""Tests for TTS provider (OpenAI-compatible /audio/speech)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from nanobot.providers.tts import (
    OpenAICompatTTSProvider,
    _resolve_speech_url,
    build_tts_provider,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _response(status: int, content: bytes = b"RIFF\x00fake-wav") -> httpx.Response:
    request = httpx.Request("POST", "https://example.test/audio/speech")
    return httpx.Response(status_code=status, content=content, request=request)


# ---------------------------------------------------------------------------
# URL resolution
# ---------------------------------------------------------------------------


def test_resolve_speech_url_falls_back_to_default() -> None:
    default = "https://api.openai.com/v1/audio/speech"
    assert _resolve_speech_url(None, default) == default
    assert _resolve_speech_url("", default) == default


def test_resolve_speech_url_appends_path_to_chat_style_base() -> None:
    assert (
        _resolve_speech_url(
            "https://open.bigmodel.cn/api/paas/v4",
            "https://x/audio/speech",
        )
        == "https://open.bigmodel.cn/api/paas/v4/audio/speech"
    )


def test_resolve_speech_url_trailing_slash() -> None:
    assert (
        _resolve_speech_url("https://api.groq.com/openai/v1/", "https://x/audio/speech")
        == "https://api.groq.com/openai/v1/audio/speech"
    )


def test_resolve_speech_url_keeps_full_endpoint() -> None:
    full = "https://open.bigmodel.cn/api/paas/v4/audio/speech"
    assert _resolve_speech_url(full, "https://x/audio/speech") == full


# ---------------------------------------------------------------------------
# Missing API key / empty text short-circuit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_api_key_short_circuits(tmp_path: Path) -> None:
    with patch.dict("os.environ", {}, clear=True):
        provider = OpenAICompatTTSProvider(api_key=None, api_base="https://x")
        post = AsyncMock()
        with patch("httpx.AsyncClient.post", post):
            result = await provider.synthesize("hello", "tongtong", tmp_path / "out.wav")
    assert result is False
    assert post.await_count == 0


@pytest.mark.asyncio
async def test_empty_text_short_circuits(tmp_path: Path) -> None:
    provider = OpenAICompatTTSProvider(api_key="sk-test")
    post = AsyncMock()
    with patch("httpx.AsyncClient.post", post):
        result = await provider.synthesize("   ", "tongtong", tmp_path / "out.wav")
    assert result is False
    assert post.await_count == 0


# ---------------------------------------------------------------------------
# Successful synthesis → file written
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_synthesize_writes_audio_file(tmp_path: Path) -> None:
    provider = OpenAICompatTTSProvider(api_key="sk-test")
    audio_bytes = b"RIFF\x00fake-wav-data"
    post = AsyncMock(return_value=_response(200, audio_bytes))
    out = tmp_path / "speech.wav"
    with patch("httpx.AsyncClient.post", post), patch("asyncio.sleep", AsyncMock()):
        result = await provider.synthesize("你好", "tongtong", out)
    assert result is True
    assert out.read_bytes() == audio_bytes


@pytest.mark.asyncio
async def test_synthesize_creates_parent_dirs(tmp_path: Path) -> None:
    provider = OpenAICompatTTSProvider(api_key="sk-test")
    out = tmp_path / "nested" / "dir" / "speech.wav"
    post = AsyncMock(return_value=_response(200, b"audio"))
    with patch("httpx.AsyncClient.post", post), patch("asyncio.sleep", AsyncMock()):
        result = await provider.synthesize("hi", "tongtong", out)
    assert result is True
    assert out.exists()


# ---------------------------------------------------------------------------
# extra_body merging
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_extra_body_merged_into_request(tmp_path: Path) -> None:
    provider = OpenAICompatTTSProvider(
        api_key="sk-test",
        extra_body={"watermark_enabled": False},
    )
    post = AsyncMock(return_value=_response(200, b"audio"))
    with patch("httpx.AsyncClient.post", post), patch("asyncio.sleep", AsyncMock()):
        await provider.synthesize("test", "tongtong", tmp_path / "out.wav")
    sent_json = post.await_args_list[0].kwargs["json"]
    assert sent_json["watermark_enabled"] is False
    assert sent_json["input"] == "test"
    assert sent_json["voice"] == "tongtong"


# ---------------------------------------------------------------------------
# Retry behavior
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_retries_on_5xx_then_succeeds(tmp_path: Path) -> None:
    provider = OpenAICompatTTSProvider(api_key="sk-test")
    post = AsyncMock(side_effect=[_response(503), _response(200, b"audio")])
    with patch("httpx.AsyncClient.post", post), patch("asyncio.sleep", AsyncMock()):
        result = await provider.synthesize("hi", "v", tmp_path / "out.wav")
    assert result is True
    assert post.await_count == 2


@pytest.mark.asyncio
async def test_retries_on_429_then_succeeds(tmp_path: Path) -> None:
    provider = OpenAICompatTTSProvider(api_key="sk-test")
    post = AsyncMock(side_effect=[_response(429), _response(200, b"audio")])
    with patch("httpx.AsyncClient.post", post), patch("asyncio.sleep", AsyncMock()):
        result = await provider.synthesize("hi", "v", tmp_path / "out.wav")
    assert result is True


@pytest.mark.asyncio
async def test_gives_up_after_max_retries(tmp_path: Path) -> None:
    provider = OpenAICompatTTSProvider(api_key="sk-test")
    post = AsyncMock(return_value=_response(503))
    sleep = AsyncMock()
    with patch("httpx.AsyncClient.post", post), patch("asyncio.sleep", sleep):
        result = await provider.synthesize("hi", "v", tmp_path / "out.wav")
    assert result is False
    assert post.await_count == 4  # initial + 3 retries
    assert sleep.await_count == 3


@pytest.mark.asyncio
async def test_backoff_grows_exponentially(tmp_path: Path) -> None:
    provider = OpenAICompatTTSProvider(api_key="sk-test")
    post = AsyncMock(return_value=_response(503))
    sleep = AsyncMock()
    with patch("httpx.AsyncClient.post", post), patch("asyncio.sleep", sleep):
        await provider.synthesize("hi", "v", tmp_path / "out.wav")
    delays = [call.args[0] for call in sleep.await_args_list]
    assert delays == [1.0, 2.0, 4.0]


@pytest.mark.asyncio
async def test_does_not_retry_on_auth_error(tmp_path: Path) -> None:
    provider = OpenAICompatTTSProvider(api_key="sk-test")
    post = AsyncMock(return_value=_response(401))
    with patch("httpx.AsyncClient.post", post), patch("asyncio.sleep", AsyncMock()):
        result = await provider.synthesize("hi", "v", tmp_path / "out.wav")
    assert result is False
    assert post.await_count == 1


@pytest.mark.asyncio
async def test_retries_on_connect_error(tmp_path: Path) -> None:
    provider = OpenAICompatTTSProvider(api_key="sk-test")
    post = AsyncMock(side_effect=[httpx.ConnectError("boom"), _response(200, b"audio")])
    with patch("httpx.AsyncClient.post", post), patch("asyncio.sleep", AsyncMock()):
        result = await provider.synthesize("hi", "v", tmp_path / "out.wav")
    assert result is True
    assert post.await_count == 2


@pytest.mark.parametrize("status", [408, 429, 500, 502, 503, 504])
@pytest.mark.asyncio
async def test_retries_on_every_advertised_transient_status(
    tmp_path: Path, status: int
) -> None:
    provider = OpenAICompatTTSProvider(api_key="sk-test")
    post = AsyncMock(side_effect=[_response(status), _response(200, b"audio")])
    with patch("httpx.AsyncClient.post", post), patch("asyncio.sleep", AsyncMock()):
        result = await provider.synthesize("hi", "v", tmp_path / "out.wav")
    assert result is True
    assert post.await_count == 2


@pytest.mark.parametrize(
    "exc",
    [
        httpx.TimeoutException("t"),
        httpx.ConnectError("c"),
        httpx.ReadError("r"),
        httpx.WriteError("w"),
        httpx.RemoteProtocolError("p"),
    ],
    ids=["timeout", "connect", "read", "write", "remote_protocol"],
)
@pytest.mark.asyncio
async def test_retries_on_every_advertised_transient_exception(
    tmp_path: Path, exc: Exception
) -> None:
    provider = OpenAICompatTTSProvider(api_key="sk-test")
    post = AsyncMock(side_effect=[exc, _response(200, b"audio")])
    with patch("httpx.AsyncClient.post", post), patch("asyncio.sleep", AsyncMock()):
        result = await provider.synthesize("hi", "v", tmp_path / "out.wav")
    assert result is True


# ---------------------------------------------------------------------------
# File write failure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_write_failure_returns_false(tmp_path: Path) -> None:
    provider = OpenAICompatTTSProvider(api_key="sk-test")
    post = AsyncMock(return_value=_response(200, b"audio"))
    with (
        patch("httpx.AsyncClient.post", post),
        patch("asyncio.sleep", AsyncMock()),
        patch("pathlib.Path.write_bytes", side_effect=PermissionError("denied")),
    ):
        result = await provider.synthesize("hi", "v", tmp_path / "out.wav")
    assert result is False


# ---------------------------------------------------------------------------
# build_tts_provider factory
# ---------------------------------------------------------------------------


def test_build_tts_provider_from_config() -> None:
    from nanobot.config.schema import TtsConfig

    cfg = TtsConfig(
        provider="glm-tts",
        api_base="https://open.bigmodel.cn/api/paas/v4",
        api_key="test-key",
        model="glm-tts",
        response_format="wav",
        speed=1.0,
        extra_body={"watermark_enabled": False},
    )
    provider = build_tts_provider(cfg)
    assert provider.api_url == "https://open.bigmodel.cn/api/paas/v4/audio/speech"
    assert provider.model == "glm-tts"
    assert provider.extra_body == {"watermark_enabled": False}
    assert provider.provider_label == "glm-tts"
    assert provider.api_key == "test-key"
