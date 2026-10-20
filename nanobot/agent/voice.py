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
from pathlib import Path
from typing import TYPE_CHECKING, Any

from nanobot.bus.events import OutboundMessage
from nanobot.config.schema import Config, TtsOptions
from nanobot.providers.tts import MiniMaxTTSProvider, TTSStreamChunk
from nanobot.webui.settings_services import WebUISettingsConfig

if TYPE_CHECKING:
    from nanobot.session.manager import SessionManager


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
        data = config.tools.tts.model_dump(by_alias=True)
        data.pop("apiKey", None)  # 不向客户端暴露密钥
        data["hasApiKey"] = bool(config.tools.tts.api_key)  # 仅提示是否已配置
        return data

    def update(self, value: dict[str, Any]) -> dict[str, Any]:
        options = TtsOptions.model_validate(value)
        if options.provider != "minimax":
            raise ValueError("仅支持 MiniMax 服务")
        # 部分更新合并：apiKey/voices/defaultVoice 缺省时继承已保存配置，避免整体覆盖清空。
        current = self.config.load().tools.tts
        if not options.api_key:
            options.api_key = current.api_key
        if not options.voices:
            options.voices = current.voices
        if not options.default_voice:
            options.default_voice = current.default_voice
        if not options.api_key:
            raise ValueError("请配置 MiniMax API Key")
        if options.voices:
            if not options.default_voice or not any(
                v.id == options.default_voice for v in options.voices
            ):
                raise ValueError("请选择 MiniMax 音色")
        elif not options.default_voice:
            raise ValueError("请配置默认音色")
        def apply(config: Config) -> None:
            config.tools.tts = options
        self.config.update(apply)
        return self.settings()

    def path(self, turn_id: object) -> Path:
        if not isinstance(turn_id, str) or not 1 <= len(turn_id) <= 1024:
            raise ValueError("invalid voice turn id")
        return self.directory / (hashlib.sha256(turn_id.encode()).hexdigest() + ".mp3")

    def _selected_voices(self, options: TtsOptions) -> tuple[str, str]:
        """解析当前选中音色：(default 音色 id, ja 音色 id 或空)。

        voices 数组非空时按 default_voice 引用 voices[].id；
        voices 为空时兼容旧扁平结构（default_voice/japanese_voice 直接是音色 id）。
        """
        if options.voices:
            selected = next((v for v in options.voices if v.id == options.default_voice), None)
            if selected is None:
                raise ValueError("MiniMax 音色未配置")
            return selected.language_voices.get("default") or selected.id, selected.language_voices.get("ja") or ""
        return options.default_voice, options.japanese_voice

    def _audio_payload(self, turn_id: str) -> dict[str, Any]:
        """构造当前音色的音频元数据（durationMs=0），并校验 MiniMax 配置与 ffmpeg。"""
        path = self.path(turn_id)
        options = self.config.load().tools.tts
        if options.provider != "minimax" or not options.api_key:
            raise ValueError("MiniMax 服务未配置")
        default_voice, _ = self._selected_voices(options)
        if not default_voice:
            raise ValueError("MiniMax 音色未配置")
        if not shutil.which("ffmpeg"):
            raise ValueError("MP3 编码需要 gateway 安装 ffmpeg")
        return {"audioId": path.stem, "path": str(path), "mimeType": "audio/mpeg",
                "sampleRate": 24000, "durationMs": 0, "provider": "minimax",
                "model": options.model, "voice": default_voice,
                "controls": []}

    def placeholder(self, turn_id: str) -> dict[str, Any]:
        """构造占位 audio（durationMs=0），不启动合成；供后台打标/摘要完成前先挂载。"""
        return self._audio_payload(turn_id)

    def remove_voice_placeholder(self, session_key: str | None, turn_id: str) -> None:
        """摘除已落库的占位 voice：后台提交失败时回滚，避免留下无法重播的语音按钮。"""
        if self.sessions is None or not session_key:
            return
        session = self.sessions.get_or_create(session_key)
        path = self.path(turn_id)
        audio_id = path.stem
        for message in reversed(session.messages):
            voice = message.get("voice")
            if (
                message.get("role") == "assistant"
                and isinstance(voice, dict)
                and voice.get("audioId") == audio_id
                and voice.get("durationMs") == 0
                and not path.is_file()
            ):
                message.pop("voice", None)
                self.sessions.save(session)
                return

    def submit(self, chat_id: str, turn_id: str, text: str, *, channel: str = "websocket",
               metadata: dict[str, Any] | None = None, session_key: str | None = None,
               playback_chat_id: str | None = None) -> dict[str, Any]:
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
        audio = self._audio_payload(turn_id)
        if turn_id in self.active or path.is_file():
            return audio
        self.active.add(turn_id)
        options = self.config.load().tools.tts
        default_voice, ja_voice = self._selected_voices(options)
        task = self._generate(chat_id, turn_id, text,
                              settings=options.model_dump(),
                              voices={"default": default_voice, "ja": ja_voice},
                              channel=channel, metadata=dict(metadata or {}), audio=audio,
                              session_key=session_key, playback_chat_id=playback_chat_id)
        try:
            self.schedule(task)
        except BaseException:
            task.close()
            self.active.discard(turn_id)
            raise
        return audio

    async def _generate(self, chat_id: str, turn_id: str, text: str,
                        settings: dict[str, Any], voices: dict[str, str], *,
                        channel: str, metadata: dict[str, Any], audio: dict[str, Any],
                        session_key: str | None, playback_chat_id: str | None) -> None:
        path = self.path(turn_id)
        temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        wav_temporary = temporary.with_suffix(".wav")
        async def emit(phase: str, **fields: Any) -> None:
            target = chat_id if channel == "websocket" else playback_chat_id
            if target and self.emit:
                await self.emit(target, {"turn_id": turn_id, "phase": phase, **fields})
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
