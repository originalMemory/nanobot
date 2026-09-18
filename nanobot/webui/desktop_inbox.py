"""把统一会话的外部渠道更新通知给桌面，不重复投递消息正文。"""

from __future__ import annotations

from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

from nanobot.bus.outbound_events import SessionUpdatedEvent
from nanobot.bus.queue import MessageBus
from nanobot.bus.runtime_events import (
    RuntimeEventContext,
    SessionTurnPersisted,
    TurnRunStatusChanged,
)
from nanobot.session.keys import UNIFIED_SESSION_KEY
from nanobot.session.manager import SessionManager
from nanobot.webui.session_identity import DESKTOP_CHAT_ID


class DesktopInboxCoordinator:
    def __init__(self, bus: MessageBus, sessions: SessionManager) -> None:
        self.bus = bus
        self.sessions = sessions
        self._starts: dict[str, int] = {}

    @staticmethod
    def _external(context: RuntimeEventContext) -> bool:
        return (
            context.session_key == UNIFIED_SESSION_KEY
            and context.channel not in {"system", "cli"}
            and (context.channel, context.chat_id) != ("websocket", DESKTOP_CHAT_ID)
        )

    @staticmethod
    def _external_inputs(messages: list[dict[str, Any]]) -> bool:
        return any(
            message.get("role") == "user"
            and isinstance(message.get("source_channel"), str)
            and message["source_channel"] not in {"system", "cli"}
            and (message["source_channel"], message.get("source_chat_id")) != ("websocket", DESKTOP_CHAT_ID)
            for message in messages
        )

    @staticmethod
    def _unified(context: RuntimeEventContext) -> bool:
        return context.session_key == UNIFIED_SESSION_KEY and context.channel not in {"system", "cli"}

    async def _notify(self) -> None:
        await self.bus.publish_event(
            SessionUpdatedEvent(scope="thread"), channel="websocket", chat_id=DESKTOP_CHAT_ID,
        )

    async def _running(self, event: TurnRunStatusChanged) -> None:
        context = event.context
        if not self._unified(context):
            return
        if event.status == "running" and context.session_key not in self._starts:
            session = self.sessions.get_or_create(context.session_key)
            self._starts[context.session_key] = len(session.messages)
            if self._external(context):
                await self._notify()
        elif event.status == "idle":
            # 取消/失败可能没有 persisted 事件，仍通知客户端重读已保存的部分。
            start = self._starts.pop(context.session_key, None)
            if start is not None:
                session = self.sessions.get_or_create(context.session_key)
                if self._external(context) or self._external_inputs(session.messages[start:]):
                    await self._notify()

    async def _persisted(self, event: SessionTurnPersisted) -> None:
        context = event.context
        if not self._unified(context):
            return
        session = self.sessions.get_or_create(context.session_key)
        start = self._starts.pop(context.session_key, None)
        if start is None:
            # 即时命令不经过 running，但仍有用户输入和最终回复。
            start = next(
                (index + 1 for index in range(len(session.messages) - 1, -1, -1)
                 if session.messages[index].get("role") == "user"),
                len(session.messages),
            )
        new_messages = session.messages[start:]
        external = self._external(context)
        if external:
            for message in new_messages:
                if message.get("role") == "assistant":
                    message.setdefault("source_channel", context.channel)
                    message.setdefault("source_chat_id", context.chat_id)
            self.sessions.save(session)
        if external or self._external_inputs(new_messages):
            await self._notify()

    @contextmanager
    def connected(self) -> Generator[None, None, None]:
        unsubscribe = [
            self.bus.subscribe(self._running, TurnRunStatusChanged),
            self.bus.subscribe(self._persisted, SessionTurnPersisted),
        ]
        try:
            yield
        finally:
            for disconnect in reversed(unsubscribe):
                disconnect()
            self._starts.clear()
