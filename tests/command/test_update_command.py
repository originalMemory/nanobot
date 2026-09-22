from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.bus.events import InboundMessage
from nanobot.command import builtin
from nanobot.command.router import CommandContext


@pytest.mark.asyncio
async def test_update_fast_forwards_then_schedules_restart(monkeypatch) -> None:
    git = AsyncMock(side_effect=[(0, ""), (0, "Already up to date.")])
    restart = MagicMock()
    monkeypatch.setattr(builtin, "_git", git)
    monkeypatch.setattr(builtin, "_schedule_restart", restart)
    msg = InboundMessage(
        channel="websocket",
        sender_id="desktop",
        chat_id="desktop",
        content="/update",
        metadata={"webui": True},
    )
    ctx = CommandContext(msg=msg, session=None, key="unified:default", raw="/update", loop=MagicMock())

    response = await builtin.cmd_update(ctx)

    assert "Restarting" in response.content
    assert git.await_args_list[0].args[1:] == ("status", "--porcelain", "--untracked-files=no")
    assert git.await_args_list[1].args[1:] == ("pull", "--ff-only")
    restart.assert_called_once_with(ctx)
