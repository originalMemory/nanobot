from __future__ import annotations

import asyncio
import wave
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
    return config


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
