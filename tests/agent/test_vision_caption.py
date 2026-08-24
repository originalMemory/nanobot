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
    _CAPTION_PROMPT,
    CaptionResult,
    caption_images,
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
    """创建 mock provider，chat_stream_with_retry 固定返回含 text 的 LLMResponse。"""
    from nanobot.providers.base import LLMResponse

    provider = MagicMock()

    async def _chat_stream_with_retry(**kwargs):
        content = text
        cb = kwargs.get("on_content_delta")
        if cb and content:
            await cb(content)
        return LLMResponse(content=content, tool_calls=[])

    provider.chat_stream_with_retry = _chat_stream_with_retry
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

    provider.chat_stream_with_retry = side_effect

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
    provider.chat_stream_with_retry = AsyncMock(side_effect=RuntimeError("模型不可用"))

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


@pytest.mark.asyncio
async def test_caption_images_streams_deltas_via_callback() -> None:
    """流式 callback 应逐 chunk 收到 delta。"""
    provider = _make_provider("逐字描述")
    deltas: list[tuple[int, str]] = []

    async def on_delta(index: int, chunk: str) -> None:
        deltas.append((index, chunk))

    with patch("nanobot.agent.vision_caption._build_image_message") as mock_build:
        mock_build.return_value = [{"role": "user", "content": []}]
        results = await caption_images(
            ["a.png"],
            provider,
            "vision-model",
            on_delta=on_delta,
        )

    assert len(results) == 1
    assert results[0].success
    assert deltas == [(0, "逐字描述")]


@pytest.mark.asyncio
async def test_caption_images_gather_failure_still_calls_on_image_end() -> None:
    """``on_image_end`` 抛错导致 ``gather`` 异常时，仍应补发 end 回调。"""
    provider = _make_provider()
    ends: list[tuple[int, CaptionResult]] = []
    end_calls = 0

    async def on_image_end(index: int, result: CaptionResult) -> None:
        nonlocal end_calls
        end_calls += 1
        if end_calls == 1:
            raise RuntimeError("callback exploded")
        ends.append((index, result))

    with patch("nanobot.agent.vision_caption._build_image_message") as mock_build:
        mock_build.return_value = [{"role": "user", "content": []}]
        results = await caption_images(
            ["a.png"],
            provider,
            "vision-model",
            on_image_end=on_image_end,
        )

    assert len(results) == 1
    assert not results[0].success
    assert "callback exploded" in (results[0].error or "")
    assert len(ends) == 1
    assert ends[0][0] == 0
    assert ends[0][1].error is not None


@pytest.mark.asyncio
async def test_state_caption_publishes_stream_events_for_websocket() -> None:
    """WebSocket + _wants_stream 时应推送 vision_caption_* 事件。"""
    from dataclasses import replace

    from nanobot.agent.loop import AgentLoop

    loop = _make_fake_loop(vision_provider=MagicMock(), vision_model="vision-model")
    ctx = _make_turn_ctx(content="看图", media=["/img/a.png"])
    ctx.msg = replace(
        ctx.msg,
        channel="websocket",
        metadata={"_wants_stream": True},
    )

    ok_results = [CaptionResult(index=0, path="/img/a.png", text="识别结果")]

    async def fake_caption_images(*args, **kwargs):
        on_delta = kwargs.get("on_delta")
        on_image_end = kwargs.get("on_image_end")
        if on_delta:
            await on_delta(0, "识别")
        if on_image_end:
            await on_image_end(0, ok_results[0])
        return ok_results

    with patch("nanobot.agent.vision_caption.caption_images", new=fake_caption_images), \
         patch("nanobot.agent.vision_caption.format_captions", return_value="图片描述：识别结果"):
        result = await AgentLoop._state_caption(loop, ctx)

    assert result == "ok"
    events = loop._outbound_calls
    assert any((m.metadata or {}).get("_vision_caption_delta") for m in events)
    assert any((m.metadata or {}).get("_vision_caption_end") for m in events)


@pytest.mark.asyncio
async def test_state_caption_publishes_stream_events_for_unified_external_channel() -> None:
    """统一会话下，Telegram 等外部通道入站带图消息也应推送 vision_caption_* 事件。"""
    from dataclasses import replace

    from nanobot.agent.loop import AgentLoop

    loop = _make_fake_loop(
        vision_provider=MagicMock(),
        vision_model="vision-model",
        unified_session=True,
    )
    ctx = _make_turn_ctx(content="看图", media=["/img/a.png"])
    ctx.msg = replace(ctx.msg, channel="telegram", metadata={})

    ok_results = [CaptionResult(index=0, path="/img/a.png", text="识别结果")]

    async def fake_caption_images(*args, **kwargs):
        on_delta = kwargs.get("on_delta")
        on_image_end = kwargs.get("on_image_end")
        if on_delta:
            await on_delta(0, "识别")
        if on_image_end:
            await on_image_end(0, ok_results[0])
        return ok_results

    with patch("nanobot.agent.vision_caption.caption_images", new=fake_caption_images), \
         patch("nanobot.agent.vision_caption.format_captions", return_value="图片描述：识别结果"):
        result = await AgentLoop._state_caption(loop, ctx)

    assert result == "ok"
    events = loop._outbound_calls
    assert all(m.channel == "telegram" for m in events)
    assert any((m.metadata or {}).get("_vision_caption_delta") for m in events)
    assert any((m.metadata or {}).get("_vision_caption_end") for m in events)


# ── task 4.2: _state_caption ─────────────────────────────────────────────────

def _make_fake_loop(
    *,
    vision_provider: object = None,
    vision_model: str | None = None,
    unified_session: bool = False,
) -> types.SimpleNamespace:
    """构造最小化的 fake AgentLoop，仅含 _state_caption 所需属性。"""
    outbound_calls: list = []

    async def publish_outbound(msg):
        outbound_calls.append(msg)

    bus = types.SimpleNamespace(publish_outbound=publish_outbound)
    loop = types.SimpleNamespace(
        _vision_provider=vision_provider,
        _vision_model=vision_model,
        _configured_vision_model=vision_model,
        _configured_vision_provider_name=None,
        _vision_provider_factory=None,
        provider=None,
        _unified_session=unified_session,
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
async def test_state_caption_uses_vision_enabled_fallback_when_primary_vision_disabled() -> None:
    """主模型关闭辅助视觉时，启用视觉的 fallback 仍应先生成 caption。"""
    from nanobot.agent.loop import AgentLoop
    from nanobot.config.schema import ModelPresetConfig
    from nanobot.providers.fallback_provider import FallbackProvider

    vision_provider = MagicMock()
    loop = _make_fake_loop()
    loop.provider = FallbackProvider(
        primary=MagicMock(),
        fallback_presets=[ModelPresetConfig(model="fallback", vision_enabled=True)],
        provider_factory=MagicMock(),
    )
    loop._configured_vision_model = "vision-model"
    loop._configured_vision_provider_name = "gemini"
    loop._vision_provider_factory = MagicMock(return_value=vision_provider)
    ctx = _make_turn_ctx(media=["/img/cat.png"])
    results = [CaptionResult(index=0, path="/img/cat.png", text="一只猫")]

    with (
        patch("nanobot.agent.vision_caption.caption_images", new=AsyncMock(return_value=results)) as caption,
        patch("nanobot.agent.vision_caption.format_captions", return_value="图片描述：一只猫"),
    ):
        result = await AgentLoop._state_caption(loop, ctx)

    assert result == "ok"
    loop._vision_provider_factory.assert_called_once_with("vision-model", "gemini")
    assert caption.await_args.kwargs["provider"] is vision_provider
    assert ctx.msg.media == []


@pytest.mark.asyncio
async def test_state_caption_does_not_forward_media_when_fallback_vision_init_fails() -> None:
    """fallback 的辅助视觉 provider 初始化失败也必须移除原始图片。"""
    from nanobot.agent.loop import AgentLoop
    from nanobot.config.schema import ModelPresetConfig
    from nanobot.providers.fallback_provider import FallbackProvider

    loop = _make_fake_loop()
    loop.provider = FallbackProvider(
        primary=MagicMock(),
        fallback_presets=[ModelPresetConfig(model="fallback", vision_enabled=True)],
        provider_factory=MagicMock(),
    )
    loop._configured_vision_model = "vision-model"
    loop._vision_provider_factory = MagicMock(side_effect=RuntimeError("unavailable"))
    ctx = _make_turn_ctx(media=["/img/cat.png"])

    with patch("nanobot.agent.vision_caption.caption_images") as caption:
        result = await AgentLoop._state_caption(loop, ctx)

    assert result == "ok"
    caption.assert_not_called()
    assert ctx.msg.media == []
    assert "初始化失败" in ctx.msg.content


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
