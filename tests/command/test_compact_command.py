from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.bus.events import InboundMessage
from nanobot.command.builtin import (
    build_help_text,
    builtin_command_palette,
    cmd_compact,
)
from nanobot.command.router import CommandContext


def _ctx(
    loop: MagicMock,
    raw: str = "/compact",
    *,
    session: MagicMock | None = None,
) -> CommandContext:
    msg = InboundMessage(channel="cli", sender_id="user", chat_id="direct", content=raw)
    return CommandContext(
        msg=msg,
        session=session,
        key=msg.session_key,
        raw=raw,
        loop=loop,
    )


def _make_loop_mock(*, ctx_est: int = 9000, budget: int = 8000) -> MagicMock:
    loop = MagicMock()
    session = MagicMock()
    loop.sessions.get_or_create.return_value = session
    loop.consolidator.estimate_session_prompt_tokens = MagicMock(return_value=(ctx_est, "tiktoken"))
    loop.consolidator._input_token_budget = budget
    loop.consolidator.consolidation_ratio = 0.5
    loop.consolidator.maybe_consolidate_by_tokens = AsyncMock()
    return loop


def test_compact_command_in_help_and_palette() -> None:
    palette = builtin_command_palette()

    assert any(item["command"] == "/compact" and item["arg_hint"] == "[ratio]" for item in palette)
    assert "/compact [ratio]" in build_help_text()


@pytest.mark.asyncio
async def test_compact_skips_when_under_budget() -> None:
    loop = _make_loop_mock(ctx_est=100, budget=8000)

    out = await cmd_compact(_ctx(loop))

    assert out is not None
    assert "within budget" in out.content
    loop.consolidator.maybe_consolidate_by_tokens.assert_not_awaited()


@pytest.mark.asyncio
async def test_compact_uses_ctx_session() -> None:
    loop = _make_loop_mock(ctx_est=9000, budget=8000)
    session = MagicMock()

    await cmd_compact(_ctx(loop, session=session))

    loop.sessions.get_or_create.assert_not_called()
    loop.consolidator.maybe_consolidate_by_tokens.assert_awaited_once_with(session)


@pytest.mark.asyncio
async def test_compact_runs_when_at_budget() -> None:
    loop = _make_loop_mock(ctx_est=8000, budget=8000)

    out = await cmd_compact(_ctx(loop))

    assert out is not None
    assert "/compact done" in out.content
    loop.consolidator.maybe_consolidate_by_tokens.assert_awaited_once()


@pytest.mark.asyncio
async def test_compact_applies_custom_ratio() -> None:
    loop = _make_loop_mock(ctx_est=9000, budget=8000)
    captured: list[float] = []

    async def _capture(_session: MagicMock) -> None:
        captured.append(loop.consolidator.consolidation_ratio)

    loop.consolidator.maybe_consolidate_by_tokens = AsyncMock(side_effect=_capture)

    await cmd_compact(_ctx(loop, "/compact 0.3"))

    assert captured == [0.3]
    assert loop.consolidator.consolidation_ratio == 0.5


@pytest.mark.asyncio
async def test_compact_rejects_invalid_ratio() -> None:
    loop = _make_loop_mock(ctx_est=9000, budget=8000)

    out = await cmd_compact(_ctx(loop, "/compact abc"))

    assert out is not None
    assert "Usage: /compact [ratio]" in out.content
    loop.consolidator.maybe_consolidate_by_tokens.assert_not_awaited()
