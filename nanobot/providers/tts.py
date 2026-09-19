"""MiniMax TTS，复用 lover 的中日分段和有序 PCM 流。"""
from __future__ import annotations

import asyncio
import json
import re
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, cast

import httpx
from loguru import logger

from nanobot.security.network import PinnedDNSAsyncTransport

_MINIMAX_T2A_PATH = "v1/t2a_v2"
_LANGUAGE_SEGMENT_RE = re.compile(r"\[(zh|ja)\](.*?)\[/\1\]", re.IGNORECASE | re.DOTALL)

@dataclass(frozen=True, slots=True)
class TTSStreamChunk:
    """TTS provider 返回的一块裸 PCM 音频。"""

    sequence: int
    pcm: bytes
    sample_rate: int


@dataclass(frozen=True, slots=True)
class TTSStreamResult:
    """一次完整流式合成的统计结果。"""

    sample_rate: int
    chunks: int
    pcm_bytes: int


def _split_language_segments(text: str) -> list[tuple[str, str]]:
    """将带语言标签的文本切成有序片段，并合并相邻同语言片段。"""
    matches = list(_LANGUAGE_SEGMENT_RE.finditer(text))
    if not matches:
        stripped = text.strip()
        return [("zh", stripped)] if stripped else []

    segments: list[tuple[str, str]] = []
    cursor = 0
    for match in matches:
        if text[cursor:match.start()].strip():
            raise ValueError("中日混合 TTS 存在未标注文本")
        language = match.group(1).lower()
        content = match.group(2).strip()
        if content:
            if segments and segments[-1][0] == language:
                segments[-1] = (language, f"{segments[-1][1]}{content}")
            else:
                segments.append((language, content))
        cursor = match.end()
    if text[cursor:].strip():
        raise ValueError("中日混合 TTS 存在未标注文本")
    return segments


class _RequestRateLimiter:
    """进程内滑动窗口限流器；一次为并发片段批量预留配额。"""

    def __init__(self, limit: int, window_s: float = 60.0) -> None:
        self.limit = limit
        self.window_s = window_s
        self._timestamps: deque[float] = deque()
        self._lock = asyncio.Lock()

    async def acquire(self, count: int) -> None:
        if count > self.limit:
            raise ValueError(f"单次 TTS 分段数 {count} 超过 RPM {self.limit}")
        while True:
            async with self._lock:
                now = time.monotonic()
                while self._timestamps and self._timestamps[0] <= now - self.window_s:
                    self._timestamps.popleft()
                available = self.limit - len(self._timestamps)
                if count <= available:
                    self._timestamps.extend([now] * count)
                    return
                wait_until = self._timestamps[count - available - 1] + self.window_s
            await asyncio.sleep(max(0.01, wait_until - now))


class MiniMaxTTSProvider:
    """MiniMax T2A：中日分段并发生成，对外保持一个有序 PCM 流。"""

    def __init__(
        self,
        *,
        api_key: str | None,
        api_base: str | None,
        model: str,
        japanese_voice: str | None,
        speed: float,
        extra_body: dict[str, Any],
        rpm: int,
    ) -> None:
        base = (api_base or "https://api.minimaxi.com").rstrip("/")
        if base.endswith("/t2a_v2"):
            self.api_url = base
        elif base.endswith("/v1"):
            self.api_url = f"{base}/t2a_v2"
        else:
            self.api_url = f"{base}/{_MINIMAX_T2A_PATH}"
        self.api_key = api_key
        self.model = model
        self.japanese_voice = japanese_voice
        self.speed = speed
        self.extra_body = extra_body
        self.rpm = rpm
        self._rate_limiter = _RequestRateLimiter(rpm)

    async def _stream_segment(
        self,
        *,
        text: str,
        language: str,
        voice: str,
        output: asyncio.Queue[bytes | None],
    ) -> TTSStreamResult | None:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        body = {
            "model": self.model,
            "text": text,
            "stream": True,
            "voice_setting": {
                "voice_id": voice,
                "speed": self.speed,
                "vol": 1,
                "pitch": 0,
            },
            "audio_setting": {
                "sample_rate": 24000,
                "bitrate": 128000,
                "format": "pcm",
                "channel": 1,
            },
            "language_boost": "Japanese" if language == "ja" else "Chinese",
            **self.extra_body,
        }
        chunks = 0
        pcm_bytes = 0
        final_bytes: int | None = None
        try:
            async with httpx.AsyncClient(transport=PinnedDNSAsyncTransport(), follow_redirects=False) as client:
                async with client.stream(
                    "POST",
                    self.api_url,
                    headers=headers,
                    json=body,
                    timeout=60.0,
                ) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        raw = line[5:].strip()
                        if not raw or raw == "[DONE]":
                            continue
                        if len(raw) > 64 * 1024 * 1024:
                            raise ValueError("MiniMax TTS event too large")
                        parsed = json.loads(raw)
                        if not isinstance(parsed, dict):
                            raise ValueError("Invalid MiniMax TTS event")
                        event = cast(dict[str, Any], parsed)
                        base_resp_object: object = event.get("base_resp") or {}
                        if not isinstance(base_resp_object, dict):
                            raise ValueError("Invalid MiniMax TTS status")
                        base_resp = cast(dict[str, Any], base_resp_object)
                        if base_resp.get("status_code") not in (0, None):
                            raise ValueError(base_resp.get("status_msg") or "MiniMax TTS 失败")
                        data_object: object = event.get("data") or {}
                        if not isinstance(data_object, dict):
                            raise ValueError("Invalid MiniMax TTS data")
                        data = cast(dict[str, Any], data_object)
                        encoded = data.get("audio")
                        if not isinstance(encoded, str) or not encoded:
                            continue
                        pcm = bytes.fromhex(encoded)
                        if not pcm or len(pcm) % 2:
                            raise ValueError("MiniMax TTS PCM chunk 无效")
                        if data.get("status") == 2:
                            final_bytes = len(pcm)
                            continue
                        if pcm_bytes + len(pcm) > 24 * 1024 * 1024:
                            raise ValueError("MiniMax TTS audio too large")
                        await output.put(pcm)
                        chunks += 1
                        pcm_bytes += len(pcm)
            if not chunks or final_bytes != pcm_bytes:
                raise ValueError(
                    f"MiniMax TTS 完整包不匹配: streamed={pcm_bytes}, final={final_bytes}"
                )
            return TTSStreamResult(sample_rate=24000, chunks=chunks, pcm_bytes=pcm_bytes)
        except asyncio.CancelledError:
            raise
        except (httpx.HTTPError, ValueError, json.JSONDecodeError):
            logger.warning("MiniMax 流式 TTS 片段失败", exc_info=True)
            return None
        finally:
            await output.put(None)

    async def synthesize_stream(
        self,
        text: str,
        voice: str,
        on_chunk: Callable[[TTSStreamChunk], Awaitable[None]],
    ) -> TTSStreamResult | None:
        if not self.api_key:
            logger.warning("MiniMax TTS 未配置 API key")
            return None
        try:
            segments = _split_language_segments(text)
            if not segments:
                return None
            if any(language == "ja" for language, _ in segments) and not self.japanese_voice:
                raise ValueError("MiniMax TTS 未配置 japaneseVoice")
            await self._rate_limiter.acquire(len(segments))
        except ValueError as exc:
            logger.warning("MiniMax TTS 分段失败: {}", exc)
            return None

        queues: list[asyncio.Queue[bytes | None]] = [asyncio.Queue() for _ in segments]
        tasks = [
            asyncio.create_task(
                self._stream_segment(
                    text=content,
                    language=language,
                    voice=(self.japanese_voice or voice) if language == "ja" else voice,
                    output=queues[index],
                )
            )
            for index, (language, content) in enumerate(segments)
        ]
        sequence = 0
        pcm_bytes = 0
        try:
            for index, output in enumerate(queues):
                while (pcm := await output.get()) is not None:
                    await on_chunk(TTSStreamChunk(sequence, pcm, 24000))
                    sequence += 1
                    pcm_bytes += len(pcm)
                if await tasks[index] is None:
                    for task in tasks[index + 1:]:
                        task.cancel()
                    await asyncio.gather(*tasks[index + 1:], return_exceptions=True)
                    return None
            return TTSStreamResult(sample_rate=24000, chunks=sequence, pcm_bytes=pcm_bytes)
        except asyncio.CancelledError:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        except Exception:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            logger.exception("MiniMax TTS 有序汇流失败")
            return None
