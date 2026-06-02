"""主动陪伴触发服务（proactive-chat）。

在用户切到后台时，按 interval_s 周期触发一次 agent turn，
由 SKILL（任务组 8）负责截图、生成文案和语音。

本服务只做"是否触发"的判断，不参与 agent 对话逻辑本身。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, time
from typing import TYPE_CHECKING, Any, Callable, Coroutine

from loguru import logger

if TYPE_CHECKING:
    from nanobot.channels.websocket import WebSocketChannel
    from nanobot.config.schema import ProactiveChatConfig


# 触发回调类型：接收可选的截图路径列表，由调用方启动 agent turn。
OnTrigger = Callable[
    [list[str]],
    Coroutine[Any, Any, None],
]


class ProactiveChatService:
    """主动陪伴触发服务。

    每隔 ``cfg.interval_s`` 检查一次：
    1. 功能是否已启用（``cfg.enabled``）
    2. 当前是否在静默时段（``cfg.quiet_hours``）
    3. 用户最后交互的 Electron 窗口是否仍在线且当前失焦
    满足以上条件则调用 ``on_trigger(media)``，
    由调用方通过 agent turn 完成截图、文案和语音生成。
    """

    def __init__(
        self,
        cfg: "ProactiveChatConfig",
        ws_channel: "WebSocketChannel",
        on_trigger: OnTrigger,
        *,
        timezone: str | None = None,
    ) -> None:
        self._cfg = cfg
        self._ws = ws_channel
        self._on_trigger = on_trigger
        self._timezone = timezone
        self._running = False
        self._task: asyncio.Task[None] | None = None

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """启动周期循环。未启用时直接返回。"""
        if not self._cfg.enabled:
            logger.info("主动陪伴：已禁用，跳过启动")
            return
        if self._running:
            logger.warning("主动陪伴：已在运行，忽略重复启动")
            return
        self._running = True
        self._task = asyncio.create_task(self._run_loop())
        # 隐私提示由 CLI 启动横幅统一打印，此处不再重复。
        logger.info("主动陪伴：已启动（间隔 {}s）", self._cfg.interval_s)

    def stop(self) -> None:
        """停止周期循环。"""
        self._running = False
        if self._task is not None:
            self._task.cancel()
            self._task = None

    # ------------------------------------------------------------------
    # 内部循环
    # ------------------------------------------------------------------

    async def _run_loop(self) -> None:
        """主循环：每隔 interval_s 执行一次 tick。"""
        while self._running:
            try:
                await asyncio.sleep(self._cfg.interval_s)
                if self._running:
                    await self._tick()
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("主动陪伴：tick 执行异常")

    async def _tick(self) -> None:
        """单次触发检查。"""
        if not self._cfg.enabled:
            return

        if self._is_quiet_hours():
            logger.debug("主动陪伴：静默时段，跳过")
            return

        # 仅当「用户最后交互的 Electron 窗口」仍在线且当前失焦时才触发。
        target = self._ws.get_unfocused_last_user_connection()
        if target is None:
            logger.debug("主动陪伴：最近用户连接不存在或仍在前台，跳过")
            return

        conn, _chat_id = target
        logger.info("主动陪伴：触发")

        # 向 Electron 请求截图（非阻塞降级：超时或失败时媒体列表为空）
        screenshot_path = await self._ws.request_screenshot(conn, timeout_s=10.0)
        media: list[str] = [str(screenshot_path)] if screenshot_path is not None else []

        try:
            await self._on_trigger(media)
        except Exception:
            logger.exception("主动陪伴：on_trigger 执行失败")

    # ------------------------------------------------------------------
    # 静默时段判断
    # ------------------------------------------------------------------

    def _is_quiet_hours(self) -> bool:
        """检查当前时间是否处于 cfg.quiet_hours 静默时段内。

        ``quiet_hours`` 格式：["HH:MM", "HH:MM"]（开始、结束，24h制）。
        支持跨午夜区间，如 ["22:00", "08:00"]。
        空列表表示不设静默时段，始终返回 False。
        """
        qh = self._cfg.quiet_hours
        if not qh or len(qh) < 2:
            return False
        try:
            start = _parse_hhmm(qh[0])
            end = _parse_hhmm(qh[1])
        except ValueError:
            logger.warning("主动陪伴：quiet_hours 格式错误 {}，忽略静默配置", qh)
            return False

        now_time = _current_time(self._timezone)
        return _time_in_range(start, end, now_time)


# ------------------------------------------------------------------
# 工具函数
# ------------------------------------------------------------------


def _parse_hhmm(s: str) -> time:
    """将 'HH:MM' 字符串解析为 datetime.time。"""
    h, m = s.split(":", 1)
    return time(int(h), int(m))


def _current_time(timezone: str | None) -> time:
    """返回当前本地时间（仅 time 部分）。"""
    try:
        if timezone:
            import zoneinfo
            tz = zoneinfo.ZoneInfo(timezone)
            return datetime.now(tz=tz).time().replace(tzinfo=None)
    except Exception:
        pass
    return datetime.now().time()


def _time_in_range(start: time, end: time, now: time) -> bool:
    """判断 now 是否在 [start, end) 区间内，支持跨午夜区间。"""
    if start <= end:
        # 不跨午夜：22:00 <= x < 22:00 时为"整天静默"（start == end → 始终静默）
        return start <= now < end if start != end else True
    # 跨午夜：start > end，如 22:00 – 08:00
    return now >= start or now < end
