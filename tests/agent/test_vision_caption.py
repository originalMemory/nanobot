"""Tests for vision_caption module and _state_caption handler.

Covers:
- caption_images: normal path, partial failure, all failure  (task 4.1)
- _state_caption: skip conditions and invocation path        (task 4.2)
- _CAPTION_PROMPT is Chinese                                 (task 4.5)
"""
from __future__ import annotations

import types
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanobot.agent.vision_caption import (
    CaptionResult,
    _CAPTION_PROMPT,
    caption_images,
    format_captions,
)
from nanobot.bus.events import InboundMessage


# ── helpers ──────────────────────────────────────────────────────────────────

def _fake_msg(content: str = "hello", media: list[str] | None = None) -> InboundMessage:
    return InboundMessage(
        channel="test",
        sender_id="user1",
        chat_id="chat1",
        content=content,
        timestamp=datetime(2026, 1, 1),
        media=media or [],
    )


def _make_provider(text: str = "这是图片描述") -> MagicMock:
    """创建 mock provider，chat_with_retry 固定返回含 text 的 LLMResponse。"""
    from nanobot.providers.base import LLMResponse

    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(
        return_value=LLMResponse(content=text, tool_calls=[])
    )
    return provider


# ── task 4.5: prompt is Chinese ───────────────────────────────────────────────

def test_caption_prompt_is_chinese() -> None:
    """固定 prompt 中应含中文字符。"""
    assert any("\u4e00" <= ch <= "\u9fff" for ch in _CAPTION_PROMPT), (
        "Caption prompt must contain Chinese characters"
    )
    assert "图片" in _CAPTION_PROMPT or "描述" in _CAPTION_PROMPT


# ── task 4.1: caption_images ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_caption_images_normal_path() -> None:
    """所有图片成功时返回正确数量的成功结果。"""
    provider = _make_provider("漂亮的风景照")

    with patch("nanobot.agent.vision_caption._build_image_message") as mock_build:
        mock_build.return_value = [{"role": "user", "content": [{"type": "text", "text": "prompt"}]}]
        results = await caption_images(["a.png", "b.png"], provider, "vision-model")

    assert len(results) == 2
    assert all(r.success for r in results)
    assert results[0].text == "漂亮的风景照"
    assert results[1].text == "漂亮的风景照"
    assert results[0].index == 0
    assert results[1].index == 1


@pytest.mark.asyncio
async def test_caption_images_partial_failure() -> None:
    """部分图片失败时返回混合结果（成功+失败）。"""
    from nanobot.providers.base import LLMResponse

    provider = MagicMock()
    call_count = 0

    async def side_effect(**kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return LLMResponse(content="成功描述", tool_calls=[])
        raise RuntimeError("网络超时")

    provider.chat_with_retry = side_effect

    with patch("nanobot.agent.vision_caption._build_image_message") as mock_build:
        mock_build.return_value = [{"role": "user", "content": []}]
        results = await caption_images(["ok.png", "fail.png"], provider, "vision-model")

    assert len(results) == 2
    assert results[0].success
    assert results[0].text == "成功描述"
    assert not results[1].success
    assert "网络超时" in results[1].error


@pytest.mark.asyncio
async def test_caption_images_all_failure() -> None:
    """全部图片失败时返回全部错误结果。"""
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(side_effect=RuntimeError("模型不可用"))

    with patch("nanobot.agent.vision_caption._build_image_message") as mock_build:
        mock_build.return_value = [{"role": "user", "content": []}]
        results = await caption_images(["x.png", "y.png", "z.png"], provider, "vision-model")

    assert len(results) == 3
    assert not any(r.success for r in results)
    for r in results:
        assert r.error is not None


@pytest.mark.asyncio
async def test_caption_images_empty_returns_empty() -> None:
    """空 image_paths 直接返回空列表。"""
    provider = _make_provider()
    results = await caption_images([], provider, "vision-model")
    assert results == []


@pytest.mark.asyncio
async def test_caption_images_invalid_file_returns_error() -> None:
    """文件不存在时（_build_image_message 返回 None）应返回错误结果。"""
    provider = _make_provider()
    # 不 patch _build_image_message，让其真实检测不存在的文件
    results = await caption_images(["/nonexistent/path/img.png"], provider, "vision-model")
    assert len(results) == 1
    assert not results[0].success
    assert results[0].error is not None


# ── task 4.2: _state_caption ─────────────────────────────────────────────────

def _make_fake_loop(
    *,
    vision_provider: object = None,
    vision_model: str | None = None,
) -> types.SimpleNamespace:
    """构造最小化的 fake AgentLoop，仅含 _state_caption 所需属性。"""
    outbound_calls: list = []

    async def publish_outbound(msg):
        outbound_calls.append(msg)

    bus = types.SimpleNamespace(publish_outbound=publish_outbound)
    loop = types.SimpleNamespace(
        _vision_provider=vision_provider,
        _vision_model=vision_model,
        bus=bus,
        _outbound_calls=outbound_calls,
    )
    return loop


def _make_turn_ctx(content: str = "用户消息", media: list[str] | None = None):
    from nanobot.agent.loop import TurnContext, TurnState

    msg = _fake_msg(content=content, media=media or [])
    return TurnContext(
        msg=msg,
        session_key="test:chat1",
        state=TurnState.CAPTION,
        turn_id="turn-1",
    )


@pytest.mark.asyncio
async def test_state_caption_skips_when_vision_model_none() -> None:
    """vision_model=None 时直接返回 'ok'，不调用 caption_images。"""
    from nanobot.agent.loop import AgentLoop

    loop = _make_fake_loop(vision_provider=None, vision_model=None)
    ctx = _make_turn_ctx(media=["/some/img.png"])

    with patch("nanobot.agent.vision_caption.caption_images") as mock_caption:
        result = await AgentLoop._state_caption(loop, ctx)

    assert result == "ok"
    mock_caption.assert_not_called()
    assert ctx.msg.media == ["/some/img.png"]  # 未被清空


@pytest.mark.asyncio
async def test_state_caption_skips_when_media_empty() -> None:
    """media 为空时，即使配置了 vision_model 也直接跳过。"""
    from nanobot.agent.loop import AgentLoop

    loop = _make_fake_loop(vision_provider=MagicMock(), vision_model="vision-model")
    ctx = _make_turn_ctx(media=[])

    with patch("nanobot.agent.vision_caption.caption_images") as mock_caption:
        result = await AgentLoop._state_caption(loop, ctx)

    assert result == "ok"
    mock_caption.assert_not_called()


@pytest.mark.asyncio
async def test_state_caption_invokes_and_modifies_msg() -> None:
    """有 media 且配置了 vision_model 时，调用 caption_images 并修改 ctx.msg。"""
    from nanobot.agent.loop import AgentLoop

    loop = _make_fake_loop(vision_provider=MagicMock(), vision_model="vision-model")
    ctx = _make_turn_ctx(content="请帮我分析这张图", media=["/img/cat.png"])

    ok_results = [CaptionResult(index=0, path="/img/cat.png", text="一只橘色猫咪坐在窗台上")]

    with patch("nanobot.agent.vision_caption.caption_images", new=AsyncMock(return_value=ok_results)), \
         patch("nanobot.agent.vision_caption.format_captions", return_value="图片描述：一只橘色猫咪坐在窗台上"):
        result = await AgentLoop._state_caption(loop, ctx)

    assert result == "ok"
    assert ctx.msg.media == []  # media 已清空
    assert "一只橘色猫咪坐在窗台上" in ctx.msg.content
    assert len(loop._outbound_calls) == 0  # 无 warning


@pytest.mark.asyncio
async def test_state_caption_partial_failure_continues_and_warns() -> None:
    """部分图片失败时：turn 继续（返回 'ok'）且 channel 收到 warning 消息。"""
    from nanobot.agent.loop import AgentLoop

    loop = _make_fake_loop(vision_provider=MagicMock(), vision_model="vision-model")
    ctx = _make_turn_ctx(content="两张图", media=["/img/a.png", "/img/b.png"])

    mixed_results = [
        CaptionResult(index=0, path="/img/a.png", text="成功的描述"),
        CaptionResult(index=1, path="/img/b.png", error="模型调用失败"),
    ]

    with patch("nanobot.agent.vision_caption.caption_images", new=AsyncMock(return_value=mixed_results)), \
         patch("nanobot.agent.vision_caption.format_captions", return_value="**图片 1**\n成功的描述\n\n**图片 2**\n（描述获取失败 - 模型调用失败）"):
        result = await AgentLoop._state_caption(loop, ctx)

    assert result == "ok"
    assert ctx.msg.media == []  # media 仍被清空
    # channel 收到 warning
    assert len(loop._outbound_calls) == 1
    warning_msg = loop._outbound_calls[0]
    assert warning_msg.metadata.get("_caption_warning") is True
    assert "辅助视觉模型" in warning_msg.content
