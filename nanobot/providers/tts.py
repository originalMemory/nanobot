"""文本转语音 provider（OpenAI 兼容 POST /audio/speech）。"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
from loguru import logger

if TYPE_CHECKING:
    from nanobot.config.schema import TtsConfig

_SPEECH_PATH = "audio/speech"

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


def build_tts_provider(config: TtsConfig) -> OpenAICompatTTSProvider:
    """从 :class:`~nanobot.config.schema.TtsConfig` 构造 :class:`OpenAICompatTTSProvider`。

    生命周期由调用方持有；通常由 TTS 工具构造一次并跨调用复用。
    """
    return OpenAICompatTTSProvider(
        api_key=config.api_key,
        api_base=config.api_base,
        model=config.model,
        response_format=config.response_format,
        speed=config.speed,
        extra_body=config.extra_body,
        provider_label=config.provider,
    )
