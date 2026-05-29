"""Tests for base.py strip-image retry branch.

When the LLM returns a non-transient error on a message that contains
image_url blocks, _run_with_retry should:
  1. Strip the images and retry.
  2. Call on_retry_wait with a hint mentioning ``vision_model`` configuration.
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
async def test_strip_retry_calls_on_retry_wait_with_vision_model_hint() -> None:
    """去图重试触发时，on_retry_wait 应收到含 vision_model 配置提示的文本。"""
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

    # on_retry_wait 应被调用一次，且内容包含 vision_model 配置提示
    assert len(retry_wait_calls) == 1
    hint = retry_wait_calls[0]
    assert "vision_model" in hint
    assert "vision_provider" in hint


@pytest.mark.asyncio
async def test_strip_retry_hint_contains_example_config() -> None:
    """on_retry_wait 提示文本应包含 JSON 示例，方便用户配置。"""
    provider = _FakeProvider()
    messages = _image_messages()

    error_response = LLMResponse(
        content="image not supported",
        finish_reason="error",
        tool_calls=[],
    )
    success_response = LLMResponse(
        content="ok", finish_reason="stop", tool_calls=[],
    )
    call_mock = AsyncMock(side_effect=[error_response, success_response])

    retry_wait_calls: list[str] = []

    async def on_retry_wait(text: str) -> None:
        retry_wait_calls.append(text)

    await provider._run_with_retry(
        call=call_mock,
        kw={"messages": messages},
        original_messages=messages,
        retry_mode="standard",
        on_retry_wait=on_retry_wait,
    )

    # 提示中应包含示例（JSON 格式或关键字段名）
    hint = retry_wait_calls[0]
    assert "gemini" in hint.lower() or "vision" in hint.lower()


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
