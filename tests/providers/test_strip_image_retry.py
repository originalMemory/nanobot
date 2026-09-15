"""Tests for base.py strip-image retry branch.

When the LLM returns a non-transient error on a message that contains
image_url blocks, _run_with_retry should:
  1. Strip the images and retry.
  2. Call on_retry_wait with an image retry hint.
                                                                (task 4.3)
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from nanobot.providers.base import GenerationSettings, LLMProvider, LLMResponse

# ── minimal concrete provider ─────────────────────────────────────────────────

class _FakeProvider(LLMProvider):
    """Minimal concrete LLMProvider for testing _run_with_retry directly."""

    def __init__(self) -> None:
        self.generation = GenerationSettings()

    async def chat(self, messages, tools=None, model=None, max_tokens=4096,
                   temperature=0.7, reasoning_effort=None, tool_choice=None) -> LLMResponse:
        raise NotImplementedError

    def get_default_model(self) -> str:
        return "test-model"


# ── helpers ───────────────────────────────────────────────────────────────────

def _image_messages() -> list[dict]:
    """Construct a messages list that contains an image_url block."""
    return [
        {
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,abc"},
                    "_meta": {"path": "/tmp/test.png"},
                },
                {"type": "text", "text": "请分析这张图"},
            ],
        }
    ]


# ── task 4.3 ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_strip_retry_calls_on_retry_wait_with_image_error_hint() -> None:
    """去图重试时应提示图片处理失败，不再引导配置辅助模型。"""
    provider = _FakeProvider()
    messages = _image_messages()

    # 第一次调用返回非瞬态错误（content 不含已知瞬态标志）
    # 第二次（去图后）调用返回成功
    error_response = LLMResponse(
        content="unsupported media type: images not allowed",
        finish_reason="error",
        tool_calls=[],
    )
    success_response = LLMResponse(
        content="好的，我来帮你分析",
        finish_reason="stop",
        tool_calls=[],
    )
    call_mock = AsyncMock(side_effect=[error_response, success_response])

    retry_wait_calls: list[str] = []

    async def on_retry_wait(text: str) -> None:
        retry_wait_calls.append(text)

    result = await provider._run_with_retry(
        call=call_mock,
        kw={"messages": messages},
        original_messages=messages,
        retry_mode="standard",
        on_retry_wait=on_retry_wait,
    )

    assert result.finish_reason == "stop"
    assert result.content == "好的，我来帮你分析"

    # 重试提示不应包含已删除的辅助模型配置。
    assert len(retry_wait_calls) == 1
    hint = retry_wait_calls[0]
    assert "vision_model" not in hint
    assert "vision_provider" not in hint


@pytest.mark.asyncio
async def test_no_strip_retry_when_no_images() -> None:
    """消息中无图片时，非瞬态错误不会触发去图重试，直接返回原始错误响应。"""
    provider = _FakeProvider()
    messages = [{"role": "user", "content": "纯文本消息"}]

    error_response = LLMResponse(
        content="some permanent error",
        finish_reason="error",
        tool_calls=[],
    )
    call_mock = AsyncMock(return_value=error_response)

    retry_wait_calls: list[str] = []

    async def on_retry_wait(text: str) -> None:
        retry_wait_calls.append(text)

    result = await provider._run_with_retry(
        call=call_mock,
        kw={"messages": messages},
        original_messages=messages,
        retry_mode="standard",
        on_retry_wait=on_retry_wait,
    )

    assert result.finish_reason == "error"
    # on_retry_wait 不应因去图而被调用
    assert not any("vision_model" in c for c in retry_wait_calls)
    call_mock.assert_called_once()
