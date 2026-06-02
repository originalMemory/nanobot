"""ProactiveChatService 单测（任务组 7）。"""

from __future__ import annotations

from datetime import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.proactive_chat.service import (
    ProactiveChatService,
    _parse_hhmm,
    _time_in_range,
)

# ---------------------------------------------------------------------------
# 测试用配置工厂
# ---------------------------------------------------------------------------


def _cfg(
    *,
    enabled: bool = True,
    interval_s: int = 1,
    quiet_hours: list[str] | None = None,
    voice: str = "tongtong",
) -> Any:
    """构造一个最小 ProactiveChatConfig 替代对象。"""
    cfg = MagicMock()
    cfg.enabled = enabled
    cfg.interval_s = interval_s
    cfg.quiet_hours = quiet_hours or []
    cfg.voice = voice
    return cfg


def _mock_ws(*, target: tuple[Any, str] | None = None) -> MagicMock:
    """构造 mock WS 通道。

    ``target`` 模拟「用户最后交互的失焦 Electron 连接」：
    None 表示无可触发目标（无连接 / 已断开 / 仍在前台）。
    """
    ws = MagicMock()
    ws.get_unfocused_last_user_connection.return_value = target
    ws.request_screenshot = AsyncMock(return_value=None)
    return ws


# ---------------------------------------------------------------------------
# 未启用时跳过触发
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_disabled_config_skips_start() -> None:
    """cfg.enabled=False 时 start() 直接返回，不启动循环任务。"""
    ws = _mock_ws()
    on_trigger = AsyncMock()
    svc = ProactiveChatService(_cfg(enabled=False), ws, on_trigger)
    await svc.start()
    assert not svc._running
    assert svc._task is None


@pytest.mark.asyncio
async def test_disabled_tick_skips() -> None:
    """cfg.enabled=False 时 _tick 早返回，不访问 WS 通道。"""
    ws = _mock_ws(target=("conn1", "chat-1"))
    on_trigger = AsyncMock()
    svc = ProactiveChatService(_cfg(enabled=False), ws, on_trigger)
    await svc._tick()
    ws.get_unfocused_last_user_connection.assert_not_called()
    on_trigger.assert_not_called()


# ---------------------------------------------------------------------------
# 静默时段跳过触发
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_quiet_hours_skips(monkeypatch: pytest.MonkeyPatch) -> None:
    """在静默时段内 _tick 不触发。"""
    import nanobot.proactive_chat.service as svc_mod

    # 固定当前时间为 23:00
    monkeypatch.setattr(svc_mod, "_current_time", lambda _tz: time(23, 0))

    ws = _mock_ws(target=("conn1", "chat-1"))
    on_trigger = AsyncMock()
    cfg = _cfg(quiet_hours=["22:00", "08:00"])
    svc = ProactiveChatService(cfg, ws, on_trigger)
    await svc._tick()
    on_trigger.assert_not_called()


@pytest.mark.asyncio
async def test_outside_quiet_hours_triggers(monkeypatch: pytest.MonkeyPatch) -> None:
    """在静默时段外 _tick 正常触发。"""
    import nanobot.proactive_chat.service as svc_mod

    # 固定当前时间为 12:00（不在 22:00-08:00 内）
    monkeypatch.setattr(svc_mod, "_current_time", lambda _tz: time(12, 0))

    ws = _mock_ws(target=("conn1", "chat-1"))
    on_trigger = AsyncMock()
    svc = ProactiveChatService(_cfg(quiet_hours=["22:00", "08:00"]), ws, on_trigger)
    await svc._tick()
    on_trigger.assert_called_once()
    (media,) = on_trigger.call_args[0]
    assert media == []  # 截图失败返回 None → media 空列表


# ---------------------------------------------------------------------------
# 无失焦连接时跳过触发
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_unfocused_connection_skips() -> None:
    """无可触发目标（无最近用户连接）时 _tick 不触发。"""
    ws = _mock_ws(target=None)
    on_trigger = AsyncMock()
    svc = ProactiveChatService(_cfg(), ws, on_trigger)
    await svc._tick()
    on_trigger.assert_not_called()


# ---------------------------------------------------------------------------
# 最近用户连接在前台（focused）时跳过触发
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_focused_connection_skips() -> None:
    """最近用户连接仍在前台时 get_unfocused_last_user_connection 返回 None → 跳过。"""
    ws = _mock_ws(target=None)  # 在前台 → 通道返回 None
    on_trigger = AsyncMock()
    svc = ProactiveChatService(_cfg(), ws, on_trigger)
    await svc._tick()
    on_trigger.assert_not_called()


# ---------------------------------------------------------------------------
# 正常触发路径：截图成功 → media 非空
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tick_with_screenshot(tmp_path: Any) -> None:
    """截图成功时，media 列表包含截图路径。"""
    screenshot = tmp_path / "shot.jpg"
    screenshot.write_bytes(b"\xff\xd8\xff")

    ws = _mock_ws(target=("conn1", "chat-42"))
    ws.request_screenshot = AsyncMock(return_value=screenshot)
    on_trigger = AsyncMock()

    svc = ProactiveChatService(_cfg(), ws, on_trigger)
    await svc._tick()

    on_trigger.assert_called_once()
    (media,) = on_trigger.call_args[0]
    assert len(media) == 1
    assert media[0] == str(screenshot)


# ---------------------------------------------------------------------------
# on_trigger 抛出异常时不向外传播
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_trigger_exception_is_swallowed() -> None:
    """on_trigger 异常不应从 _tick 向外抛出。"""
    ws = _mock_ws(target=("conn1", "chat-1"))
    on_trigger = AsyncMock(side_effect=RuntimeError("agent crash"))
    svc = ProactiveChatService(_cfg(), ws, on_trigger)
    # 不应 raise
    await svc._tick()


# ---------------------------------------------------------------------------
# stop() 取消循环任务
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stop_cancels_task() -> None:
    """stop() 后服务停止运行，task 被取消。"""
    ws = _mock_ws()
    on_trigger = AsyncMock()
    svc = ProactiveChatService(_cfg(interval_s=3600), ws, on_trigger)
    await svc.start()
    assert svc._running
    svc.stop()
    assert not svc._running
    assert svc._task is None


# ---------------------------------------------------------------------------
# _time_in_range 工具函数
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "start,end,now,expected",
    [
        # 普通日间区间
        ("08:00", "22:00", "12:00", True),
        ("08:00", "22:00", "07:59", False),
        ("08:00", "22:00", "22:00", False),
        # 跨午夜
        ("22:00", "08:00", "23:00", True),
        ("22:00", "08:00", "00:00", True),
        ("22:00", "08:00", "07:59", True),
        ("22:00", "08:00", "08:00", False),
        ("22:00", "08:00", "12:00", False),
    ],
)
def test_time_in_range(start: str, end: str, now: str, expected: bool) -> None:
    assert _time_in_range(_parse_hhmm(start), _parse_hhmm(end), _parse_hhmm(now)) == expected


# ---------------------------------------------------------------------------
# quiet_hours 格式错误时降级为不静默
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_malformed_quiet_hours_skips_silence() -> None:
    """quiet_hours 格式错误时不进入静默，正常触发。"""
    ws = _mock_ws(target=("conn1", "chat-1"))
    on_trigger = AsyncMock()
    cfg = _cfg(quiet_hours=["bad", "format"])
    svc = ProactiveChatService(cfg, ws, on_trigger)
    await svc._tick()
    on_trigger.assert_called_once()
