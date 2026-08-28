"""Tests for TTS provider (OpenAI-compatible /audio/speech)."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from nanobot.providers.tts import (
    MiniMaxTTSProvider,
    OpenAICompatTTSProvider,
    _RequestRateLimiter,
    _resolve_speech_url,
    _split_language_segments,
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
async def test_synthesize_stream_decodes_ordered_pcm_chunks() -> None:
    pcm = b"\x00\x00\x01\x00"
    lines = [
        "data: " + json.dumps({
            "choices": [{
                "index": 0,
                "delta": {
                    "return_sample_rate": 24000,
                    "content": base64.b64encode(pcm).decode("ascii"),
                },
            }],
        }),
        'data: {"choices":[{"index":1,"finish_reason":"stop"}]}',
    ]

    class FakeResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            for line in lines:
                yield line

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def stream(self, *_, **__):
            return FakeResponse()

    provider = OpenAICompatTTSProvider(api_key="sk-test")
    chunks = []
    async def collect(chunk):
        chunks.append(chunk)
    with patch("nanobot.providers.tts.httpx.AsyncClient", return_value=FakeClient()):
        result = await provider.synthesize_stream("你好", "voice", collect)

    assert result is not None
    assert result.sample_rate == 24000
    assert result.pcm_bytes == len(pcm)
    assert chunks[0].sequence == 0
    assert chunks[0].pcm == pcm


@pytest.mark.asyncio
async def test_synthesize_stream_rejects_out_of_order_chunks() -> None:
    encoded = base64.b64encode(b"\x00\x00").decode("ascii")
    lines = [
        "data: " + json.dumps({
            "choices": [{
                "index": 1,
                "delta": {"return_sample_rate": 24000, "content": encoded},
            }],
        }),
    ]

    class FakeResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            for line in lines:
                yield line

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def stream(self, *_, **__):
            return FakeResponse()

    provider = OpenAICompatTTSProvider(api_key="sk-test")
    with patch("nanobot.providers.tts.httpx.AsyncClient", return_value=FakeClient()):
        result = await provider.synthesize_stream("你好", "voice", AsyncMock())

    assert result is None


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


def test_split_language_segments_merges_adjacent_languages() -> None:
    assert _split_language_segments(
        "[zh]先说[/zh][zh]中文[/zh][ja]ありがとう[/ja][zh]结束[/zh]"
    ) == [("zh", "先说中文"), ("ja", "ありがとう"), ("zh", "结束")]
    assert _split_language_segments("普通中文") == [("zh", "普通中文")]


@pytest.mark.asyncio
async def test_minimax_streams_segments_in_order_and_skips_final_aggregate() -> None:
    chinese = b"\x01\x00\x02\x00"
    japanese = b"\x03\x00"
    requests: list[dict] = []

    def event(status: int, pcm: bytes) -> str:
        return "data: " + json.dumps({
            "data": {"status": status, "audio": pcm.hex()},
            "base_resp": {"status_code": 0},
        })

    class FakeResponse:
        status_code = 200

        def __init__(self, pcm: bytes) -> None:
            self.lines = [event(1, pcm), event(2, pcm)]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            for line in self.lines:
                yield line

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def stream(self, *_, **kwargs):
            requests.append(kwargs["json"])
            return FakeResponse(japanese if kwargs["json"]["language_boost"] == "Japanese" else chinese)

    provider = MiniMaxTTSProvider(
        api_key="sk-test",
        api_base="https://api.minimaxi.com",
        model="speech-2.8-hd",
        japanese_voice="scarlett",
        speed=1.0,
        extra_body={},
        rpm=20,
    )
    chunks = []

    async def collect(chunk):
        chunks.append(chunk)

    with patch("nanobot.providers.tts.httpx.AsyncClient", return_value=FakeClient()):
        result = await provider.synthesize_stream(
            "[zh]谢谢可以说[/zh][ja]ありがとうございます[/ja]",
            "genshin-candice",
            collect,
        )

    assert result is not None
    assert result.pcm_bytes == len(chinese) + len(japanese)
    assert [chunk.sequence for chunk in chunks] == [0, 1]
    assert [chunk.pcm for chunk in chunks] == [chinese, japanese]
    assert {request["voice_setting"]["voice_id"] for request in requests} == {
        "genshin-candice",
        "scarlett",
    }
    assert all(request["model"] == "speech-2.8-hd" for request in requests)
    assert all(request["audio_setting"]["format"] == "pcm" for request in requests)


@pytest.mark.asyncio
async def test_request_rate_limiter_waits_for_sliding_window() -> None:
    limiter = _RequestRateLimiter(limit=2, window_s=60.0)
    limiter._timestamps.extend([0.0, 0.0])
    sleep = AsyncMock()
    with patch("nanobot.providers.tts.time.monotonic", side_effect=[30.0, 61.0]), patch(
        "nanobot.providers.tts.asyncio.sleep",
        sleep,
    ):
        await limiter.acquire(1)
    sleep.assert_awaited_once_with(30.0)


def test_builds_minimax_provider() -> None:
    from nanobot.config.schema import TtsConfig

    provider = build_tts_provider(TtsConfig(
        provider="minimax",
        api_base="https://api.minimaxi.com",
        api_key="test-key",
        model="speech-2.8-hd",
        japanese_voice="scarlett",
        rpm=20,
    ))
    assert isinstance(provider, MiniMaxTTSProvider)
    assert provider.api_url == "https://api.minimaxi.com/v1/t2a_v2"
    assert provider.rpm == 20
