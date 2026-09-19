"""MiniMax 后台合成与按 turn 保存的重播文件，不改动模型历史。"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import re
import shutil
import uuid
import wave
from collections.abc import Awaitable, Callable, Coroutine
from contextvars import ContextVar
from pathlib import Path
from typing import TYPE_CHECKING, Any

from nanobot.bus.events import OutboundMessage
from nanobot.config.schema import Config, TtsOptions
from nanobot.providers.tts import MiniMaxTTSProvider, TTSStreamChunk
from nanobot.webui.settings_services import WebUISettingsConfig

if TYPE_CHECKING:
    from nanobot.session.manager import SessionManager

DEFERRED_VOICE: ContextVar[list[str] | None] = ContextVar("deferred_heartbeat_voice", default=None)


async def encode_mp3(source: Path, target: Path) -> None:
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", str(source), "-codec:a", "libmp3lame", "-b:a", "64k",
        "-ar", "24000", "-ac", "1", "-f", "mp3", str(target),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    try:
        await asyncio.wait_for(process.communicate(), timeout=60)
        if process.returncode != 0 or not target.is_file() or target.stat().st_size == 0:
            raise ValueError("MP3 编码失败")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


class VoiceService:
    def __init__(self, config: WebUISettingsConfig):
        self.config = config
        self.sessions: SessionManager | None = None
        self.directory = config.path.parent / "media" / "voice"
        self.active: set[str] = set()
        self.provider: MiniMaxTTSProvider | None = None
        self.provider_key = ""
        self.emit: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None
        self.deliver: Callable[[OutboundMessage], Awaitable[None]] | None = None
        self.schedule: Callable[[Coroutine[Any, Any, None]], None] | None = None
        self.lock = asyncio.Lock()

    def settings(self) -> dict[str, Any]:
        config = self.config.load()
        return {**config.tools.tts.model_dump(), "presets": [
            {"id": key, "label": value.label,
             "voices": [{"id": voice.id, "label": voice.label} for voice in value.voices]}
            for key, value in config.tts_presets.items() if value.config.provider == "minimax"
        ]}

    def update(self, value: dict[str, Any]) -> dict[str, Any]:
        options = TtsOptions.model_validate(value)
        def apply(config: Config) -> None:
            preset = config.tts_presets.get(options.preset or "")
            if not preset or preset.config.provider != "minimax" or not any(
                v.id == options.voice and v.language_voices.get("default") for v in preset.voices
            ):
                raise ValueError("请选择 MiniMax 服务与音色")
            config.tools.tts = options
        self.config.update(apply)
        return self.settings()

    def path(self, turn_id: object) -> Path:
        if not isinstance(turn_id, str) or not 1 <= len(turn_id) <= 1024:
            raise ValueError("invalid voice turn id")
        return self.directory / (hashlib.sha256(turn_id.encode()).hexdigest() + ".mp3")

    def submit(self, chat_id: str, turn_id: str, text: str, *, channel: str = "websocket",
               metadata: dict[str, Any] | None = None, session_key: str | None = None) -> dict[str, Any]:
        path = self.path(turn_id)
        text = re.sub(r"<[^>]+>", "", text).strip()
        if not text or len(text) > 10000:
            raise ValueError("语音文本须为 1–10000 字符")
        if not shutil.which("ffmpeg"):
            raise ValueError("MP3 编码需要 gateway 安装 ffmpeg")
        if self.schedule is None:
            raise ValueError("语音服务未启动")
        if len(self.active) >= 4:
            raise ValueError("语音服务繁忙")
        config = self.config.load()
        preset = config.tts_presets.get(config.tools.tts.preset or "")
        if not preset or preset.config.provider != "minimax" or not preset.config.api_key:
            raise ValueError("MiniMax 服务未配置")
        voice = next((v for v in preset.voices if v.id == config.tools.tts.voice), None)
        if not voice or not voice.language_voices.get("default"):
            raise ValueError("MiniMax 音色未配置")
        audio: dict[str, Any] = {"audioId": path.stem, "path": str(path),
                 "mimeType": "audio/mpeg",
                 "sampleRate": 24000, "durationMs": 0, "provider": "minimax", "model": preset.config.model,
                 "voice": voice.language_voices["default"], "controls": []}
        if turn_id in self.active or path.is_file():
            return audio
        self.active.add(turn_id)
        task = self._generate(chat_id, turn_id, text, preset.config.model_dump(), voice.language_voices,
                              channel=channel, metadata=dict(metadata or {}), audio=audio, session_key=session_key)
        try:
            self.schedule(task)
        except BaseException:
            task.close()
            self.active.discard(turn_id)
            raise
        return audio

    async def _generate(self, chat_id: str, turn_id: str, text: str,
                        settings: dict[str, Any], voices: dict[str, str], *,
                        channel: str, metadata: dict[str, Any], audio: dict[str, Any], session_key: str | None) -> None:
        path = self.path(turn_id)
        temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        wav_temporary = temporary.with_suffix(".wav")
        async def emit(phase: str, **fields: Any) -> None:
            if channel == "websocket" and self.emit:
                await self.emit(chat_id, {"turn_id": turn_id, "phase": phase, **fields})
        try:
            async with self.lock:
                key = repr((settings, voices))
                if self.provider is None or key != self.provider_key:
                    self.provider = MiniMaxTTSProvider(
                        api_key=settings["api_key"], api_base=settings["api_base"],
                        model=settings["model"], speed=settings["speed"], rpm=settings["rpm"],
                        japanese_voice=voices.get("ja"), extra_body=settings["extra_body"],
                    )
                    self.provider_key = key
                self.directory.mkdir(parents=True, exist_ok=True)
                await emit("start")
                size = 0
                sequence = 0
                with wave.open(str(wav_temporary), "wb") as output:
                    output.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                    async def chunk(value: TTSStreamChunk) -> None:
                        nonlocal size, sequence
                        size += len(value.pcm)
                        if size > 24 * 1024 * 1024:
                            raise ValueError("语音过长")
                        output.writeframesraw(value.pcm)
                        for offset in range(0, len(value.pcm), 48 * 1024):
                            await emit("chunk", pcm=base64.b64encode(value.pcm[offset:offset + 48 * 1024]).decode(), sequence=sequence)
                            sequence += 1
                            await asyncio.sleep(0)  # 让已有 socket writer 排出片段，避免一次完整包挤满发送队列。
                    result = await self.provider.synthesize_stream(text, voices["default"], chunk)
                    if result is None:
                        raise ValueError("MiniMax 合成失败")
                await encode_mp3(wav_temporary, temporary)
                os.replace(temporary, path)
                audio["durationMs"] = round(size * 1000 / (24000 * 2))
                if self.sessions is not None and session_key:
                    session = self.sessions.get_or_create(session_key)
                    for message in reversed(session.messages):
                        if message.get("role") == "assistant" and isinstance(message.get("voice"), dict) and message["voice"].get("audioId") == audio["audioId"]:
                            message["voice"] = dict(audio)
                            self.sessions.save(session)
                            break
                await emit("end")
            if channel != "websocket" and self.deliver:
                await self.deliver(OutboundMessage(channel=channel, chat_id=chat_id,
                    content="", media=[str(path)], metadata=metadata))
        except asyncio.CancelledError:
            await emit("error")
            raise
        except Exception:
            # 不把 provider 响应、密钥或完整语音文本带到客户端错误里。
            await emit("error")
        finally:
            temporary.unlink(missing_ok=True)
            wav_temporary.unlink(missing_ok=True)
            self.active.discard(turn_id)
