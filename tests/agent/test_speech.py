from __future__ import annotations

import asyncio
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.agent.speech import SpeechRuntime
from nanobot.agent.tools.context import RequestContext
from nanobot.providers.tts import TTSStreamChunk, TTSStreamResult


def _context() -> RequestContext:
    return RequestContext(
        channel="websocket",
        chat_id="chat-1",
        session_key="unified:default",
        metadata={"webui_turn_id": "turn-1"},
    )


def _config() -> MagicMock:
    config = MagicMock()
    config.provider = "glm-tts"
    config.model = "glm-tts"
    config.fallback = None
    config.health_check_url = None
    config.health_check_timeout_s = 0.5
    return config


def _fallback_config() -> SimpleNamespace:
    return SimpleNamespace(
        provider="glm-tts",
        model="glm-tts",
        default_voice="glm-voice",
    )


@pytest.mark.asyncio
async def test_streams_pcm_writes_wav_and_retains_turn_record(monkeypatch, tmp_path) -> None:
    bus = MagicMock()
    bus.publish_outbound = AsyncMock()
    provider = MagicMock()

    async def synthesize_stream(text, voice, on_chunk):
        assert text == "你好"
        assert voice == "voice-1"
        await on_chunk(TTSStreamChunk(0, b"\x00\x00" * 2400, 24000))
        await on_chunk(TTSStreamChunk(1, b"\x01\x00" * 2400, 24000))
        return TTSStreamResult(sample_rate=24000, chunks=2, pcm_bytes=9600)

    provider.synthesize_stream = AsyncMock(side_effect=synthesize_stream)
    monkeypatch.setattr("nanobot.agent.speech.build_tts_provider", lambda _: provider)
    monkeypatch.setattr("nanobot.agent.speech.get_media_dir", lambda: tmp_path)
    runtime = SpeechRuntime(bus)

    result, error = await runtime.synthesize(
        config=_config(),
        context=_context(),
        text='<psb:expression name="笑" />你好',
        voice="voice-1",
    )

    assert error is None
    assert result is not None
    assert result.path.exists()
    with wave.open(str(result.path), "rb") as audio:
        assert audio.getframerate() == 24000
        assert audio.getnchannels() == 1
        assert audio.getsampwidth() == 2
        assert audio.getnframes() == 4800
    events = [call.args[0].metadata["_assistant_audio"] for call in bus.publish_outbound.await_args_list]
    assert [event["phase"] for event in events] == ["start", "chunk", "chunk", "end"]
    assert events[0]["controls"][0]["type"] == "expression"
    assert events[0]["text"] == '<psb:expression name="笑" />你好'
    assert "text" not in events[-1]
    assert "text" not in result.to_dict()
    assert runtime.speech_for("unified:default", "turn-1") == result


@pytest.mark.asyncio
async def test_submit_returns_before_first_chunk_and_finishes_in_background(
    monkeypatch,
    tmp_path,
) -> None:
    bus = MagicMock()
    bus.publish_outbound = AsyncMock()
    provider = MagicMock()
    release = asyncio.Event()

    async def synthesize_stream(text, voice, on_chunk):
        await release.wait()
        await on_chunk(TTSStreamChunk(0, b"\x00\x00" * 100, 24000))
        return TTSStreamResult(sample_rate=24000, chunks=1, pcm_bytes=200)

    provider.synthesize_stream = AsyncMock(side_effect=synthesize_stream)
    monkeypatch.setattr("nanobot.agent.speech.build_tts_provider", lambda _: provider)
    monkeypatch.setattr("nanobot.agent.speech.get_media_dir", lambda: tmp_path)
    tasks: list[asyncio.Task] = []
    completed = AsyncMock()

    def schedule(coro) -> None:
        tasks.append(asyncio.create_task(coro))

    runtime = SpeechRuntime(bus, schedule_background=schedule, on_complete=completed)

    error = runtime.submit(
        config=_config(),
        context=_context(),
        text="慢速语音",
        voice="voice-1",
    )

    assert error is None
    assert runtime.has_speech(_context()) is True
    assert bus.publish_outbound.await_count == 0
    assert runtime.submit(
        config=_config(),
        context=_context(),
        text="重复语音",
        voice="voice-1",
    ) == "本轮已经生成过语音"

    release.set()
    await tasks[0]

    events = [call.args[0].metadata["_assistant_audio"] for call in bus.publish_outbound.await_args_list]
    assert [event["phase"] for event in events] == ["start", "chunk", "end"]
    completed.assert_awaited_once()
    assert runtime.speech_for("unified:default", "turn-1") is not None


@pytest.mark.asyncio
async def test_submit_provider_build_failure_emits_error_and_releases_turn(
    monkeypatch,
    tmp_path,
) -> None:
    bus = MagicMock()
    bus.publish_outbound = AsyncMock()
    tasks: list[asyncio.Task] = []

    def schedule(coro) -> None:
        tasks.append(asyncio.create_task(coro))

    monkeypatch.setattr(
        "nanobot.agent.speech.build_tts_provider",
        MagicMock(side_effect=RuntimeError("broken config")),
    )
    monkeypatch.setattr("nanobot.agent.speech.get_media_dir", lambda: tmp_path)
    runtime = SpeechRuntime(bus, schedule_background=schedule)

    error = runtime.submit(
        config=_config(),
        context=_context(),
        text="构造失败",
        voice="voice-1",
    )
    await tasks[0]

    assert error is None
    assert runtime.has_speech(_context()) is False
    event = bus.publish_outbound.await_args.args[0].metadata["_assistant_audio"]
    assert event["phase"] == "error"
    assert event["error"] == "tts_runtime_failed"


@pytest.mark.asyncio
async def test_rejects_second_audio_in_same_turn(monkeypatch, tmp_path) -> None:
    bus = MagicMock()
    bus.publish_outbound = AsyncMock()
    provider = MagicMock()

    async def synthesize_stream(text, voice, on_chunk):
        await on_chunk(TTSStreamChunk(0, b"\x00\x00" * 100, 24000))
        return TTSStreamResult(sample_rate=24000, chunks=1, pcm_bytes=200)

    provider.synthesize_stream = AsyncMock(side_effect=synthesize_stream)
    monkeypatch.setattr("nanobot.agent.speech.build_tts_provider", lambda _: provider)
    monkeypatch.setattr("nanobot.agent.speech.get_media_dir", lambda: tmp_path)
    runtime = SpeechRuntime(bus)
    await runtime.synthesize(config=_config(), context=_context(), text="一次", voice="v")

    result, error = await runtime.synthesize(
        config=_config(), context=_context(), text="二次", voice="v"
    )

    assert result is None
    assert error == "本轮已经生成过语音"
    assert provider.synthesize_stream.await_count == 1


@pytest.mark.asyncio
async def test_cancel_removes_partial_files_and_emits_error(monkeypatch, tmp_path) -> None:
    bus = MagicMock()
    bus.publish_outbound = AsyncMock()
    provider = MagicMock()
    chunk_sent = asyncio.Event()

    async def synthesize_stream(text, voice, on_chunk):
        await on_chunk(TTSStreamChunk(0, b"\x00\x00" * 100, 24000))
        chunk_sent.set()
        await asyncio.Event().wait()

    provider.synthesize_stream = AsyncMock(side_effect=synthesize_stream)
    monkeypatch.setattr("nanobot.agent.speech.build_tts_provider", lambda _: provider)
    monkeypatch.setattr("nanobot.agent.speech.get_media_dir", lambda: tmp_path)
    runtime = SpeechRuntime(bus)
    task = asyncio.create_task(
        runtime.synthesize(config=_config(), context=_context(), text="取消", voice="v")
    )
    await chunk_sent.wait()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert list(tmp_path.glob(".*.tmp")) == []
    events = [call.args[0].metadata["_assistant_audio"] for call in bus.publish_outbound.await_args_list]
    assert events[-1] == {
        "phase": "error",
        "audioId": events[0]["audioId"],
        "error": "cancelled",
    }


@pytest.mark.asyncio
async def test_falls_back_before_first_chunk_and_strips_language_tags(monkeypatch, tmp_path) -> None:
    bus = MagicMock()
    bus.publish_outbound = AsyncMock()
    primary = MagicMock()
    primary.synthesize_stream = AsyncMock(return_value=None)
    fallback = MagicMock()

    async def fallback_stream(text, voice, on_chunk):
        assert text == "你好こんにちは"
        assert voice == "glm-voice"
        await on_chunk(TTSStreamChunk(0, b"\x00\x00" * 100, 24000))
        return TTSStreamResult(sample_rate=24000, chunks=1, pcm_bytes=200)

    fallback.synthesize_stream = AsyncMock(side_effect=fallback_stream)
    config = SimpleNamespace(provider="index-tts-2.5", model="index-tts-2.5", fallback=_fallback_config())
    monkeypatch.setattr("nanobot.agent.speech.build_tts_provider", MagicMock(side_effect=[primary, fallback]))
    monkeypatch.setattr("nanobot.agent.speech.get_media_dir", lambda: tmp_path)
    result, error = await SpeechRuntime(bus).synthesize(
        config=config,
        context=_context(),
        text="[zh]你好[/zh][ja]こんにちは[/ja]",
        voice="candice-glm",
    )

    assert error is None
    assert result is not None
    assert result.provider == "glm-tts"
    assert result.voice == "glm-voice"
    fallback.synthesize_stream.assert_awaited_once()


@pytest.mark.asyncio
async def test_does_not_fallback_after_first_chunk(monkeypatch, tmp_path) -> None:
    bus = MagicMock()
    bus.publish_outbound = AsyncMock()
    primary = MagicMock()

    async def primary_stream(text, voice, on_chunk):
        await on_chunk(TTSStreamChunk(0, b"\x00\x00" * 100, 24000))
        return None

    primary.synthesize_stream = AsyncMock(side_effect=primary_stream)
    fallback = MagicMock()
    config = SimpleNamespace(provider="index-tts-2.5", model="index-tts-2.5", fallback=_fallback_config())
    factory = MagicMock(side_effect=[primary, fallback])
    monkeypatch.setattr("nanobot.agent.speech.build_tts_provider", factory)
    monkeypatch.setattr("nanobot.agent.speech.get_media_dir", lambda: tmp_path)
    result, error = await SpeechRuntime(bus).synthesize(
        config=config,
        context=_context(),
        text="[zh]你好[/zh]",
        voice="candice-glm",
    )

    assert result is None
    assert error == "TTS 合成失败，provider='index-tts-2.5'"
    assert factory.call_count == 1


@pytest.mark.asyncio
async def test_health_check_failure_skips_primary_and_falls_back(monkeypatch, tmp_path) -> None:
    bus = MagicMock()
    bus.publish_outbound = AsyncMock()
    primary = MagicMock()
    primary.synthesize_stream = AsyncMock()
    fallback = MagicMock()

    async def fallback_stream(text, voice, on_chunk):
        await on_chunk(TTSStreamChunk(0, b"\x00\x00" * 100, 24000))
        return TTSStreamResult(sample_rate=24000, chunks=1, pcm_bytes=200)

    fallback.synthesize_stream = AsyncMock(side_effect=fallback_stream)
    config = SimpleNamespace(
        provider="index-tts-2.5",
        model="index-tts-2.5",
        fallback=_fallback_config(),
        health_check_url="http://index-tts/health",
        health_check_timeout_s=0.5,
    )
    factory = MagicMock(side_effect=[primary, fallback])
    monkeypatch.setattr("nanobot.agent.speech.build_tts_provider", factory)
    monkeypatch.setattr("nanobot.agent.speech._tts_health_check", AsyncMock(return_value=False))
    monkeypatch.setattr("nanobot.agent.speech.get_media_dir", lambda: tmp_path)
    result, error = await SpeechRuntime(bus).synthesize(
        config=config,
        context=_context(),
        text="[zh]你好[/zh]",
        voice="candice-glm",
    )

    assert error is None
    assert result is not None
    primary.synthesize_stream.assert_not_awaited()
    fallback.synthesize_stream.assert_awaited_once()
