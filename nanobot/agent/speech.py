"""Turn-scoped shared streaming TTS runtime."""

from __future__ import annotations

import asyncio
import base64
import os
import uuid
import wave
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from loguru import logger

from nanobot.agent.playback_segments import (
    parse_segment_controls,
    strip_tts_language_tags,
    to_speech_text,
)
from nanobot.agent.tools.context import RequestContext
from nanobot.bus.events import OutboundMessage
from nanobot.config.paths import get_media_dir
from nanobot.providers.tts import TTSStreamChunk, build_tts_provider
from nanobot.webui.metadata import WEBUI_TURN_METADATA_KEY


async def _tts_health_check(config: Any) -> bool:
    """快速检查本地 TTS；未配置检查地址时保持原行为。"""
    url = str(getattr(config, "health_check_url", "") or "").strip()
    if not url:
        return True
    timeout = float(getattr(config, "health_check_timeout_s", 0.5))
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            return (await client.get(url)).is_success
    except (httpx.HTTPError, ValueError):
        return False


@dataclass(frozen=True, slots=True)
class SpeechResult:
    """完整语音文件及其持久化元数据。"""

    audio_id: str
    path: Path
    mime_type: str
    sample_rate: int
    duration_ms: int
    provider: str
    model: str
    voice: str
    controls: tuple[dict[str, Any], ...]

    def to_dict(self, *, include_path: bool = True) -> dict[str, Any]:
        result: dict[str, Any] = {
            "audioId": self.audio_id,
            "mimeType": self.mime_type,
            "sampleRate": self.sample_rate,
            "durationMs": self.duration_ms,
            "provider": self.provider,
            "model": self.model,
            "voice": self.voice,
            "controls": [dict(item) for item in self.controls],
        }
        if include_path:
            result["path"] = str(self.path)
        return result


class SpeechRuntime:
    """Serialize TTS calls and retain completed audio until the turn is saved."""

    def __init__(
        self,
        bus: Any | None,
        *,
        schedule_background: Callable[[Coroutine[Any, Any, None]], None] | None = None,
        on_complete: Callable[[str, str, SpeechResult], Awaitable[None]] | None = None,
    ) -> None:
        self._bus = bus
        self._schedule_background = schedule_background
        self._on_complete = on_complete
        self._semaphore = asyncio.Semaphore(1)
        self._active: set[tuple[str, str]] = set()
        self._pending: dict[tuple[str, str], SpeechResult] = {}
        self._provider_config: Any | None = None
        self._provider: Any | None = None

    @staticmethod
    def _key(context: RequestContext) -> tuple[str, str] | None:
        session_key = str(context.session_key or "").strip()
        turn_id = str(context.metadata.get(WEBUI_TURN_METADATA_KEY) or "").strip()
        if not session_key or not turn_id:
            return None
        return session_key, turn_id

    def has_speech(self, context: RequestContext) -> bool:
        key = self._key(context)
        return key is not None and (key in self._active or key in self._pending)

    def speech_for(self, session_key: str, turn_id: str) -> SpeechResult | None:
        return self._pending.get((session_key, turn_id))

    def clear_speech(self, session_key: str, turn_id: str) -> None:
        self._pending.pop((session_key, turn_id), None)

    def _provider_for(self, config: Any) -> Any:
        """复用 provider，使 MiniMax RPM 窗口跨 turn 生效。"""
        if self._provider_config is not config:
            self._provider = build_tts_provider(config)
            self._provider_config = config
        return self._provider

    def submit(
        self,
        *,
        config: Any,
        context: RequestContext,
        text: str,
        voice: str,
    ) -> str | None:
        """提交后台合成；返回错误时任务未启动。"""
        key = self._key(context)
        if key is None:
            return "当前请求缺少 session/turn 上下文"
        if key in self._active or key in self._pending:
            return "本轮已经生成过语音"
        if not to_speech_text(text):
            return "TTS 文本在剥离桌宠标签后为空"
        if self._schedule_background is None:
            return "TTS 后台调度未配置"

        task = self._synthesize_submitted(
            key=key,
            config=config,
            context=context,
            text=text,
            voice=voice,
        )
        self._active.add(key)
        try:
            self._schedule_background(task)
        except Exception:
            task.close()
            self._active.discard(key)
            logger.exception("TTS 后台任务提交失败")
            return "TTS 后台任务提交失败"
        return None

    async def _synthesize_submitted(
        self,
        *,
        key: tuple[str, str],
        config: Any,
        context: RequestContext,
        text: str,
        voice: str,
    ) -> None:
        result, _ = await self.synthesize(
            config=config,
            context=context,
            text=text,
            voice=voice,
            _reserved=True,
        )
        if result is not None and self._on_complete is not None:
            try:
                await self._on_complete(key[0], key[1], result)
            except Exception:
                logger.exception("TTS 完成后写入历史失败")

    async def _publish(
        self,
        context: RequestContext,
        phase: str,
        payload: dict[str, Any],
    ) -> None:
        if self._bus is None:
            return
        await self._bus.publish_outbound(
            OutboundMessage(
                channel=context.channel,
                chat_id=context.chat_id,
                content="",
                metadata={
                    **context.metadata,
                    "_assistant_audio": {"phase": phase, **payload},
                },
            )
        )

    async def synthesize(
        self,
        *,
        config: Any,
        context: RequestContext,
        text: str,
        voice: str,
        _reserved: bool = False,
    ) -> tuple[SpeechResult | None, str | None]:
        """Generate one logical audio stream for the active turn."""
        key = self._key(context)
        if key is None:
            return None, "当前请求缺少 session/turn 上下文"
        if not _reserved and (key in self._active or key in self._pending):
            return None, "本轮已经生成过语音"

        spoken_text = to_speech_text(text)
        if not spoken_text:
            return None, "TTS 文本在剥离桌宠标签后为空"
        _, controls, _ = parse_segment_controls(text)
        audio_id = uuid.uuid4().hex
        media_dir = get_media_dir() / "tts"
        output_path = media_dir / f"speech_{audio_id}.wav"
        pcm_tmp = media_dir / f".{audio_id}.pcm.tmp"
        wav_tmp = media_dir / f".{audio_id}.wav.tmp"
        effective_config = config
        effective_voice = voice
        started = False

        if not _reserved:
            self._active.add(key)
        try:
            provider = self._provider_for(config)
            async with self._semaphore:
                media_dir.mkdir(parents=True, exist_ok=True)
                with pcm_tmp.open("wb") as pcm_file:
                    async def _on_chunk(chunk: TTSStreamChunk) -> None:
                        nonlocal started
                        if not started:
                            await self._publish(
                                context,
                                "start",
                                {
                                    "audioId": audio_id,
                                    "sampleRate": chunk.sample_rate,
                                    "channels": 1,
                                    "encoding": "pcm_s16le",
                                    "controls": controls,
                                    "text": text,
                                },
                            )
                            started = True
                        pcm_file.write(chunk.pcm)
                        await self._publish(
                            context,
                            "chunk",
                            {
                                "audioId": audio_id,
                                "sequence": chunk.sequence,
                                "data": base64.b64encode(chunk.pcm).decode("ascii"),
                            },
                        )

                    fallback = getattr(config, "fallback", None)
                    fallback_voice = getattr(fallback, "default_voice", "") if fallback else ""
                    fallback_text = strip_tts_language_tags(spoken_text)
                    if fallback and not await _tts_health_check(config):
                        logger.warning("主 TTS 健康检查失败，直接切换备用 provider")
                        stream_result = None
                    else:
                        stream_result = await provider.synthesize_stream(
                            spoken_text,
                            voice,
                            _on_chunk,
                        )
                    if stream_result is None and not started and fallback_voice and fallback_text:
                        logger.warning(
                            "主 TTS 未返回音频，切换到备用 provider='{}'",
                            fallback.provider,
                        )
                        effective_config = fallback
                        effective_voice = fallback_voice
                        stream_result = await build_tts_provider(fallback).synthesize_stream(
                            fallback_text,
                            fallback_voice,
                            _on_chunk,
                        )

                if stream_result is None:
                    await self._publish(
                        context,
                        "error",
                        {"audioId": audio_id, "error": "tts_synthesis_failed"},
                    )
                    return None, f"TTS 合成失败，provider='{config.provider}'"

                with wave.open(str(wav_tmp), "wb") as wav_file:
                    wav_file.setnchannels(1)
                    wav_file.setsampwidth(2)
                    wav_file.setframerate(stream_result.sample_rate)
                    with pcm_tmp.open("rb") as pcm_file:
                        while data := pcm_file.read(1024 * 1024):
                            wav_file.writeframesraw(data)
                os.replace(wav_tmp, output_path)

                duration_ms = round(
                    stream_result.pcm_bytes * 1000 / (stream_result.sample_rate * 2)
                )
                result = SpeechResult(
                    audio_id=audio_id,
                    path=output_path,
                    mime_type="audio/wav",
                    sample_rate=stream_result.sample_rate,
                    duration_ms=duration_ms,
                    provider=str(effective_config.provider),
                    model=str(effective_config.model),
                    voice=effective_voice,
                    controls=tuple(controls),
                )
                self._pending[key] = result
                await self._publish(context, "end", result.to_dict())

                if context.channel != "websocket" and self._bus is not None:
                    await self._bus.publish_outbound(
                        OutboundMessage(
                            channel=context.channel,
                            chat_id=context.chat_id,
                            content="",
                            media=[str(output_path)],
                            metadata={
                                **context.metadata,
                                "_assistant_audio_file_delivery": True,
                            },
                        )
                    )
                return result, None
        except asyncio.CancelledError:
            await self._publish(
                context,
                "error",
                {"audioId": audio_id, "error": "cancelled"},
            )
            raise
        except Exception:
            logger.exception("流式 TTS runtime 失败")
            await self._publish(
                context,
                "error",
                {"audioId": audio_id, "error": "tts_runtime_failed"},
            )
            return None, "TTS runtime 失败"
        finally:
            self._active.discard(key)
            pcm_tmp.unlink(missing_ok=True)
            wav_tmp.unlink(missing_ok=True)
