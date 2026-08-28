"""文本转语音 provider（OpenAI 兼容 POST /audio/speech）。"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
from loguru import logger

if TYPE_CHECKING:
    from nanobot.config.schema import TtsConfig

_SPEECH_PATH = "audio/speech"
_MINIMAX_T2A_PATH = "v1/t2a_v2"
_LANGUAGE_SEGMENT_RE = re.compile(r"\[(zh|ja)\](.*?)\[/\1\]", re.IGNORECASE | re.DOTALL)

# 沿用与 transcription.py 相同的重试常量
_MAX_RETRIES = 3
_BACKOFF_S = (1.0, 2.0, 4.0)
_RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}
_RETRYABLE_EXCEPTIONS = (
    httpx.TimeoutException,
    httpx.ConnectError,
    httpx.ReadError,
    httpx.WriteError,
    httpx.RemoteProtocolError,
)


@dataclass(frozen=True, slots=True)
class TTSStreamChunk:
    """GLM-TTS 返回的一块裸 PCM 音频。"""

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


def _resolve_speech_url(api_base: str | None, default_url: str) -> str:
    """解析最终的语音合成端点 URL。

    接受聊天风格基址（如 ``https://open.bigmodel.cn/api/paas/v4``）或已完整以
    ``/audio/speech`` 结尾的 URL。聊天风格基址会自动追加路径，与
    :func:`transcription._resolve_transcription_url` 逻辑对称。
    """
    if not api_base:
        return default_url
    base = api_base.rstrip("/")
    if base.endswith(_SPEECH_PATH):
        return base
    return f"{base}/{_SPEECH_PATH}"


async def _post_speech_with_retry(
    url: str,
    *,
    api_key: str,
    text: str,
    model: str,
    voice: str,
    response_format: str,
    speed: float,
    extra_body: dict[str, Any],
    output_path: Path,
    provider_label: str,
) -> bool:
    """发送 TTS 合成请求，将二进制音频写入 *output_path*。

    成功返回 ``True``，任何失败（不可重试的 4xx、重试耗尽、写文件出错）返回 ``False``。
    在 408/429/5xx 及瞬时网络异常时按退避策略重试，策略与
    :func:`transcription._post_transcription_with_retry` 一致。

    ``extra_body`` 的键值直接合并进请求体，供厂商自定义字段使用
    （如 GLM 的 ``watermark_enabled``、OpenAI 的 ``instructions``）。
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body: dict[str, Any] = {
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": response_format,
        "speed": speed,
        **extra_body,
    }

    async with httpx.AsyncClient() as client:
        for attempt in range(_MAX_RETRIES + 1):
            try:
                response = await client.post(url, headers=headers, json=body, timeout=60.0)
            except _RETRYABLE_EXCEPTIONS as e:
                if attempt < _MAX_RETRIES:
                    logger.warning(
                        "{} TTS 瞬时错误（第 {}/{} 次）: {}",
                        provider_label, attempt + 1, _MAX_RETRIES + 1, e,
                    )
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue
                logger.exception(
                    "{} TTS 在 {} 次尝试后仍失败: {}",
                    provider_label, _MAX_RETRIES + 1, e,
                )
                return False
            except Exception as e:
                logger.exception("{} TTS 错误: {}", provider_label, e)
                return False

            if response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                logger.warning(
                    "{} TTS 瞬时 HTTP {}（第 {}/{} 次）",
                    provider_label, response.status_code, attempt + 1, _MAX_RETRIES + 1,
                )
                await asyncio.sleep(_BACKOFF_S[attempt])
                continue

            try:
                response.raise_for_status()
            except Exception as e:
                logger.exception("{} TTS 错误: {}", provider_label, e)
                return False

            try:
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(response.content)
            except OSError as e:
                logger.exception("{} TTS 写音频文件失败: {}", provider_label, e)
                return False

            logger.debug("{} TTS 合成 {} 字节 → {}", provider_label, len(response.content), output_path)
            return True

    return False  # 重试耗尽（正常情况下循环内已 return，此行不可达）


class OpenAICompatTTSProvider:
    """支持任意 OpenAI 兼容 ``POST /audio/speech`` 端点的 TTS provider。

    GLM-TTS、OpenAI、Groq 等厂商均通过配置差异区分，不存在独立代码路径。
    厂商自定义字段（如 GLM 的 ``watermark_enabled``）通过 ``extra_body`` 透传，
    无需特殊处理。
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        api_base: str | None = None,
        model: str = "tts-1",
        response_format: str = "wav",
        speed: float = 1.0,
        extra_body: dict[str, Any] | None = None,
        provider_label: str = "TTS",
    ) -> None:
        # API key 回退链：显式传入 → ZHIPUAI（GLM-TTS 默认）→ GLM_TTS → OPENAI
        self.api_key = (
            api_key
            or os.environ.get("ZHIPUAI_API_KEY")
            or os.environ.get("GLM_TTS_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
        )
        self.api_url = _resolve_speech_url(
            api_base,
            "https://api.openai.com/v1/audio/speech",
        )
        self.model = model
        self.response_format = response_format
        self.speed = speed
        self.extra_body = extra_body or {}
        self.provider_label = provider_label
        logger.debug("{} TTS 端点: {}", provider_label, self.api_url)

    async def synthesize(self, text: str, voice: str, output_path: Path) -> bool:
        """将 *text* 用 *voice* 合成语音并写入 *output_path*。

        成功返回 ``True``，任何失败（缺少 key、空文本、API 报错、写文件失败）
        返回 ``False``，不抛出异常。
        """
        if not self.api_key:
            logger.warning("{} TTS 未配置 API key", self.provider_label)
            return False
        if not text.strip():
            logger.warning("{} TTS: 文本为空，跳过", self.provider_label)
            return False
        return await _post_speech_with_retry(
            self.api_url,
            api_key=self.api_key,
            text=text,
            model=self.model,
            voice=voice,
            response_format=self.response_format,
            speed=self.speed,
            extra_body=self.extra_body,
            output_path=output_path,
            provider_label=self.provider_label,
        )

    async def synthesize_stream(
        self,
        text: str,
        voice: str,
        on_chunk: Callable[[TTSStreamChunk], Awaitable[None]],
    ) -> TTSStreamResult | None:
        """以 SSE 接收 base64 编码的 16-bit mono PCM，并逐块回调。"""
        if not self.api_key:
            logger.warning("{} TTS 未配置 API key", self.provider_label)
            return None
        if not text.strip():
            logger.warning("{} TTS: 文本为空，跳过", self.provider_label)
            return None

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        body: dict[str, Any] = {
            "model": self.model,
            "input": text,
            "voice": voice,
            "response_format": "pcm",
            "encode_format": "base64",
            "stream": True,
            "speed": self.speed,
            **self.extra_body,
        }

        for attempt in range(_MAX_RETRIES + 1):
            emitted = False
            try:
                async with httpx.AsyncClient() as client:
                    async with client.stream(
                        "POST",
                        self.api_url,
                        headers=headers,
                        json=body,
                        timeout=60.0,
                    ) as response:
                        if response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                            await response.aread()
                            await asyncio.sleep(_BACKOFF_S[attempt])
                            continue
                        response.raise_for_status()

                        sample_rate: int | None = None
                        chunks = 0
                        pcm_bytes = 0
                        finished = False
                        expected_index = 0
                        async for line in response.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            raw = line[5:].strip()
                            if not raw or raw == "[DONE]":
                                continue
                            event = json.loads(raw)
                            choices = event.get("choices")
                            if not isinstance(choices, list):
                                raise ValueError("TTS SSE 缺少 choices")
                            for choice in choices:
                                if not isinstance(choice, dict):
                                    continue
                                choice_index = choice.get("index")
                                if choice_index != expected_index:
                                    raise ValueError(
                                        "TTS SSE sequence 无效: "
                                        f"expected={expected_index}, actual={choice_index}"
                                    )
                                delta = choice.get("delta") or {}
                                encoded = delta.get("content") if isinstance(delta, dict) else None
                                if isinstance(encoded, str) and encoded:
                                    chunk_rate = delta.get("return_sample_rate") or sample_rate or 24000
                                    if not isinstance(chunk_rate, int) or chunk_rate <= 0:
                                        raise ValueError("TTS SSE sample rate 无效")
                                    if sample_rate is not None and chunk_rate != sample_rate:
                                        raise ValueError("TTS SSE sample rate 在流中发生变化")
                                    sample_rate = chunk_rate
                                    pcm = base64.b64decode(encoded, validate=True)
                                    if not pcm or len(pcm) % 2:
                                        raise ValueError("TTS SSE PCM chunk 无效")
                                    chunk = TTSStreamChunk(chunks, pcm, sample_rate)
                                    await on_chunk(chunk)
                                    emitted = True
                                    chunks += 1
                                    pcm_bytes += len(pcm)
                                if choice.get("finish_reason") == "stop":
                                    finished = True
                                expected_index += 1
                        if not emitted or sample_rate is None:
                            raise ValueError("TTS SSE 未返回音频")
                        if not finished:
                            raise ValueError("TTS SSE 未正常结束")
                        return TTSStreamResult(sample_rate, chunks, pcm_bytes)
            except asyncio.CancelledError:
                raise
            except _RETRYABLE_EXCEPTIONS as e:
                if not emitted and attempt < _MAX_RETRIES:
                    logger.warning(
                        "{} 流式 TTS 瞬时错误（第 {}/{} 次）: {}",
                        self.provider_label,
                        attempt + 1,
                        _MAX_RETRIES + 1,
                        e,
                    )
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue
                logger.warning("{} 流式 TTS 失败: {}", self.provider_label, e)
                return None
            except (httpx.HTTPStatusError, ValueError, json.JSONDecodeError) as e:
                logger.warning("{} 流式 TTS 响应无效: {}", self.provider_label, e)
                return None
            except Exception:
                logger.exception("{} 流式 TTS 错误", self.provider_label)
                return None
        return None


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
            async with httpx.AsyncClient() as client:
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
                        event = json.loads(raw)
                        base_resp = event.get("base_resp") or {}
                        if base_resp.get("status_code") not in (0, None):
                            raise ValueError(base_resp.get("status_msg") or "MiniMax TTS 失败")
                        data = event.get("data") or {}
                        encoded = data.get("audio")
                        if not isinstance(encoded, str) or not encoded:
                            continue
                        pcm = bytes.fromhex(encoded)
                        if not pcm or len(pcm) % 2:
                            raise ValueError("MiniMax TTS PCM chunk 无效")
                        if data.get("status") == 2:
                            final_bytes = len(pcm)
                            continue
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

        queues = [asyncio.Queue() for _ in segments]
        tasks = [
            asyncio.create_task(
                self._stream_segment(
                    text=content,
                    language=language,
                    voice=self.japanese_voice if language == "ja" else voice,
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


def build_tts_provider(config: TtsConfig) -> OpenAICompatTTSProvider | MiniMaxTTSProvider:
    """按配置构造 TTS provider。

    生命周期由调用方持有；SpeechRuntime 会跨 turn 复用以保留 RPM 窗口。
    """
    if config.provider.lower() == "minimax":
        return MiniMaxTTSProvider(
            api_key=config.api_key,
            api_base=config.api_base,
            model=config.model,
            japanese_voice=config.japanese_voice,
            speed=config.speed,
            extra_body=config.extra_body,
            rpm=config.rpm,
        )
    return OpenAICompatTTSProvider(
        api_key=config.api_key,
        api_base=config.api_base,
        model=config.model,
        response_format=config.response_format,
        speed=config.speed,
        extra_body=config.extra_body,
        provider_label=config.provider,
    )
