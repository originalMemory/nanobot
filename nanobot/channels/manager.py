"""Channel manager for coordinating chat channels."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

from nanobot.bus.events import OutboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.channels.base import BaseChannel
from nanobot.config.schema import Config
from nanobot.utils.restart import consume_restart_notice_from_env, format_restart_completed_message

if TYPE_CHECKING:
    from nanobot.session.manager import SessionManager


def _default_webui_dist() -> Path | None:
    """Return the absolute path to the bundled webui dist directory if it exists."""
    try:
        import nanobot.web as web_pkg  # type: ignore[import-not-found]
    except ImportError:
        return None
    candidate = Path(web_pkg.__file__).resolve().parent / "dist"
    return candidate if candidate.is_dir() else None


# Retry delays for message sending (exponential backoff: 1s, 2s, 4s)
_SEND_RETRY_DELAYS = (1, 2, 4)

# shadow 到 inbox:unified 时需剥离的流式元数据，避免 _send_once 因 _streamed 跳过 send()
_UNIFIED_SHADOW_STRIP_KEYS = frozenset({
    "_streamed",
    "_stream_delta",
    "_stream_end",
    "_stream_id",
    "_resuming",
})

_BOOL_CAMEL_ALIASES: dict[str, str] = {
    "send_progress": "sendProgress",
    "send_tool_hints": "sendToolHints",
    "show_reasoning": "showReasoning",
}

class ChannelManager:
    """
    Manages chat channels and coordinates message routing.

    Responsibilities:
    - Initialize enabled channels (Telegram, WhatsApp, etc.)
    - Start/stop channels
    - Route outbound messages
    """

    def __init__(
        self,
        config: Config,
        bus: MessageBus,
        *,
        session_manager: "SessionManager | None" = None,
        webui_runtime_model_name: Callable[[], str | None] | None = None,
        webui_runtime_model_setter: Callable[[str | None], None] | None = None,
        webui_static_dist: bool = True,
        webui_runtime_surface: str = "browser",
        webui_runtime_capabilities: dict[str, Any] | None = None,
    ):
        self.config = config
        self.bus = bus
        self._session_manager = session_manager
        self._webui_runtime_model_name = webui_runtime_model_name
        self._webui_runtime_model_setter = webui_runtime_model_setter
        self._webui_static_dist = webui_static_dist
        self._webui_runtime_surface = webui_runtime_surface
        self._webui_runtime_capabilities = dict(webui_runtime_capabilities or {})
        self.channels: dict[str, BaseChannel] = {}
        self._dispatch_task: asyncio.Task | None = None
        self._origin_reply_fingerprints: dict[tuple[str, str, str], str] = {}
        # 跨通道流式 fan-out 到 inbox:unified 的文本累积器
        self._unified_inbox_stream_bufs: dict[tuple[str, str, str], list[str]] = {}
        self._unified_session: bool = bool(
            getattr(getattr(config, "agents", None), "defaults", None)
            and config.agents.defaults.unified_session
        )

        self._init_channels()

    def _init_channels(self) -> None:
        """Initialize channels discovered via pkgutil scan + entry_points plugins."""
        from nanobot.channels.registry import discover_channel_names, discover_enabled

        transcription_provider = self.config.channels.transcription_provider
        transcription_key = self._resolve_transcription_key(transcription_provider)
        transcription_base = self._resolve_transcription_base(transcription_provider)
        transcription_language = self.config.channels.transcription_language

        # Collect enabled module names first, then only import those.
        # Channel configs live in ChannelsConfig's extra fields (via
        # extra="allow"), so we enumerate candidates from pkgutil scan
        # (cheap, no imports) and any plugin keys in __pydantic_extra__.
        names = discover_channel_names()
        candidate_names = set(names)
        extra = getattr(self.config.channels, "__pydantic_extra__", None) or {}
        candidate_names.update(extra.keys())

        enabled_names: set[str] = set()
        for name in candidate_names:
            section = getattr(self.config.channels, name, None)
            if section is None:
                continue
            if (
                section.get("enabled", False)
                if isinstance(section, dict)
                else getattr(section, "enabled", False)
            ):
                enabled_names.add(name)

        for name, cls in discover_enabled(enabled_names, _names=names).items():
            section = getattr(self.config.channels, name, None)
            if section is None:
                continue
            try:
                kwargs: dict[str, Any] = {}
                if cls.name == "websocket":
                    if self._session_manager is not None:
                        kwargs["session_manager"] = self._session_manager
                        static_path = _default_webui_dist() if self._webui_static_dist else None
                        if static_path is not None:
                            kwargs["static_dist_path"] = static_path
                    kwargs["workspace_path"] = self.config.workspace_path
                    if self._webui_runtime_model_name is not None:
                        kwargs["runtime_model_name"] = self._webui_runtime_model_name
                    if self._webui_runtime_model_setter is not None:
                        kwargs["runtime_model_setter"] = self._webui_runtime_model_setter
                    kwargs["unified_session"] = self._unified_session
                channel = cls(section, self.bus, **kwargs)
                channel.transcription_provider = transcription_provider
                channel.transcription_api_key = transcription_key
                channel.transcription_api_base = transcription_base
                channel.transcription_language = transcription_language
                channel.send_progress = self._resolve_bool_override(
                    section, "send_progress", self.config.channels.send_progress,
                )
                channel.send_tool_hints = self._resolve_bool_override(
                    section, "send_tool_hints", self.config.channels.send_tool_hints,
                )
                channel.show_reasoning = self._resolve_bool_override(
                    section, "show_reasoning", self.config.channels.show_reasoning,
                )
                self.channels[name] = channel
                logger.info("{} channel enabled", cls.display_name)
            except Exception as e:
                logger.warning("{} channel not available: {}", name, e)

        self._validate_allow_from()

    def _resolve_transcription_key(self, provider: str) -> str:
        """Pick the API key for the configured transcription provider."""
        try:
            if provider == "openai":
                return self.config.providers.openai.api_key
            return self.config.providers.groq.api_key
        except AttributeError:
            return ""

    def _resolve_transcription_base(self, provider: str) -> str:
        """Pick the API base URL for the configured transcription provider."""
        try:
            if provider == "openai":
                return self.config.providers.openai.api_base or ""
            return self.config.providers.groq.api_base or ""
        except AttributeError:
            return ""

    def _validate_allow_from(self) -> None:
        for name, ch in self.channels.items():
            cfg = ch.config
            if isinstance(cfg, dict):
                if "allow_from" in cfg:
                    allow = cfg.get("allow_from")
                else:
                    allow = cfg.get("allowFrom")
            else:
                allow = getattr(cfg, "allow_from", None)
            if allow is None:
                # allowFrom omitted → pairing-only mode.  Unapproved senders
                # receive a pairing code instead of being silently ignored.
                logger.info(
                    '"{}" has no allowFrom; unapproved users will receive a pairing code',
                    name,
                )

    def _should_send_progress(self, channel_name: str, *, tool_hint: bool = False) -> bool:
        """Return whether progress (or tool-hints) may be sent to *channel_name*."""
        ch = self.channels.get(channel_name)
        if ch is None:
            logger.warning("Progress check for unknown channel: {}", channel_name)
            return False
        return ch.send_tool_hints if tool_hint else ch.send_progress

    def _resolve_bool_override(self, section: Any, key: str, default: bool) -> bool:
        """Return *key* from *section* if it is a bool, otherwise *default*.

        For dict configs also checks the camelCase alias (e.g. ``sendProgress``
        for ``send_progress``) so raw JSON/TOML configs work alongside
        Pydantic models.
        """
        if isinstance(section, dict):
            value = section.get(key)
            if value is None:
                camel = _BOOL_CAMEL_ALIASES.get(key)
                if camel:
                    value = section.get(camel)
            return value if isinstance(value, bool) else default
        value = getattr(section, key, None)
        return value if isinstance(value, bool) else default

    async def _start_channel(self, name: str, channel: BaseChannel) -> None:
        """Start a channel and log any exceptions."""
        try:
            await channel.start()
        except Exception:
            logger.exception("Failed to start channel {}", name)

    async def start_all(self) -> None:
        """Start all channels and the outbound dispatcher."""
        if not self.channels:
            logger.warning("No channels enabled")
            return

        # Start outbound dispatcher
        self._dispatch_task = asyncio.create_task(self._dispatch_outbound())

        # Start channels
        tasks = []
        for name, channel in self.channels.items():
            logger.info("Starting {} channel...", name)
            tasks.append(asyncio.create_task(self._start_channel(name, channel)))

        self._notify_restart_done_if_needed()

        # Wait for all to complete (they should run forever)
        await asyncio.gather(*tasks, return_exceptions=True)

    def _notify_restart_done_if_needed(self) -> None:
        """Send restart completion message when runtime env markers are present."""
        notice = consume_restart_notice_from_env()
        if not notice:
            return
        target = self.channels.get(notice.channel)
        if not target:
            return
        msg = OutboundMessage(
            channel=notice.channel,
            chat_id=notice.chat_id,
            content=format_restart_completed_message(notice.started_at_raw),
            metadata=dict(notice.metadata or {}),
        )
        # WebSocket 频道在重启后客户端尚未重连，直接发送会因无订阅者而静默丢失。
        # 使用队列机制，等客户端重连并订阅后再投递。
        if hasattr(target, "queue_pending_reconnect_message"):
            target.queue_pending_reconnect_message(msg)
        else:
            asyncio.create_task(self._send_with_retry(target, msg))

    async def stop_all(self) -> None:
        """Stop all channels and the dispatcher."""
        logger.info("Stopping all channels...")

        # Stop dispatcher
        if self._dispatch_task:
            self._dispatch_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._dispatch_task

        # Stop all channels
        for name, channel in self.channels.items():
            try:
                await channel.stop()
                logger.info("Stopped {} channel", name)
            except Exception:
                logger.exception("Error stopping {}", name)

    @staticmethod
    def _fingerprint_content(content: str) -> str:
        normalized = " ".join(content.split())
        return hashlib.sha1(normalized.encode("utf-8")).hexdigest() if normalized else ""

    def _should_suppress_outbound(self, msg: OutboundMessage) -> bool:
        metadata = msg.metadata or {}
        if metadata.get("_progress"):
            return False
        fingerprint = self._fingerprint_content(msg.content)
        if not fingerprint:
            return False

        origin_message_id = metadata.get("origin_message_id")
        if isinstance(origin_message_id, str) and origin_message_id:
            key = (msg.channel, msg.chat_id, origin_message_id)
            if self._origin_reply_fingerprints.get(key) == fingerprint:
                return True
            self._origin_reply_fingerprints[key] = fingerprint

        message_id = metadata.get("message_id")
        if isinstance(message_id, str) and message_id:
            key = (msg.channel, msg.chat_id, message_id)
            self._origin_reply_fingerprints[key] = fingerprint

        return False

    @staticmethod
    def _unified_stream_key(msg: OutboundMessage) -> tuple[str, str, str]:
        meta = msg.metadata or {}
        stream_id = str(meta.get("_stream_id") or "")
        return (msg.channel, msg.chat_id, stream_id)

    def _clear_unified_inbox_stream_bufs(self, channel: str, chat_id: str) -> None:
        """清除指定会话残留的流式累积，避免异常中断后泄漏。"""
        stale = [
            k for k in self._unified_inbox_stream_bufs
            if k[0] == channel and k[1] == chat_id
        ]
        for key in stale:
            self._unified_inbox_stream_bufs.pop(key, None)

    @staticmethod
    def _is_unified_inbox_system_meta(msg: OutboundMessage) -> bool:
        meta = msg.metadata or {}
        return bool(
            meta.get("_progress")
            or meta.get("_session_updated")
            or meta.get("_goal_status")
            or meta.get("_goal_state_sync")
        )

    def _build_unified_inbox_shadow(
        self,
        msg: OutboundMessage,
        *,
        content: str,
    ) -> OutboundMessage:
        """构造写入 inbox:unified 的 shadow 消息，剥离会干扰路由的流式标记。"""
        clean_meta = {
            k: v
            for k, v in (msg.metadata or {}).items()
            if k not in _UNIFIED_SHADOW_STRIP_KEYS
        }
        return OutboundMessage(
            channel="websocket",
            chat_id="inbox:unified",
            content=content,
            media=msg.media,
            metadata={
                **clean_meta,
                "_unified_inbox_write": True,
                "source_channel": msg.channel,
                "source_chat_id": msg.chat_id,
            },
        )

    async def _fan_out_unified_inbox_message(
        self,
        ws_channel: BaseChannel,
        msg: OutboundMessage,
        *,
        content: str,
    ) -> None:
        shadow = self._build_unified_inbox_shadow(msg, content=content)
        try:
            await self._send_once(ws_channel, shadow)
        except Exception:
            logger.warning(
                "unified inbox shadow send failed for {}:{}",
                msg.channel,
                msg.chat_id,
            )

    async def _fan_out_unified_inbox_stream(
        self,
        ws_channel: BaseChannel,
        msg: OutboundMessage,
        *,
        event: str,
        text: str = "",
    ) -> None:
        """将流式 wire 事件实时推送到 inbox:unified 订阅者。"""
        fan_out = getattr(ws_channel, "fan_out_unified_inbox_event", None)
        if fan_out is None:
            # WebSocketChannel 未实现 fan_out_unified_inbox_event，delta 静默丢弃。
            # 若未来重构导致此方法消失，debug 日志可帮助定位 inbox delta 丢失问题。
            logger.debug(
                "ws_channel has no fan_out_unified_inbox_event, skipping delta fan-out for {}:{}",
                msg.channel,
                msg.chat_id,
            )
            return
        meta = msg.metadata or {}
        payload: dict[str, Any] = {
            "event": event,
            "chat_id": "inbox:unified",
        }
        if text:
            payload["text"] = text
        stream_id = meta.get("_stream_id")
        if stream_id is not None:
            payload["stream_id"] = stream_id
        image_index = meta.get("image_index")
        if isinstance(image_index, int):
            payload["image_index"] = image_index
        error = meta.get("_vision_caption_error")
        if isinstance(error, str) and error:
            payload["error"] = error
        try:
            await fan_out(payload, msg.channel, msg.chat_id)
        except Exception:
            logger.warning(
                "unified inbox stream fan-out failed for {}:{}",
                msg.channel,
                msg.chat_id,
            )

    async def _fan_out_unified_inbox_turn_end(
        self,
        ws_channel: BaseChannel,
        msg: OutboundMessage,
    ) -> None:
        """将 turn_end 推送给 inbox:unified 订阅者，结束 Electron 侧 loading 态。"""
        fan_out = getattr(ws_channel, "fan_out_unified_inbox_event", None)
        if fan_out is None:
            return
        meta = msg.metadata or {}
        payload: dict[str, Any] = {
            "event": "turn_end",
            "chat_id": "inbox:unified",
        }
        lat = meta.get("latency_ms")
        if isinstance(lat, (int, float)):
            payload["latency_ms"] = int(lat)
        gs = meta.get("goal_state")
        if isinstance(gs, dict):
            payload["goal_state"] = gs
        usg = meta.get("usage")
        if isinstance(usg, dict) and usg:
            payload["usage"] = usg
        self._clear_unified_inbox_stream_bufs(msg.channel, msg.chat_id)
        try:
            await fan_out(payload, msg.channel, msg.chat_id)
        except Exception:
            logger.warning(
                "unified inbox turn_end fan-out failed for {}:{}",
                msg.channel,
                msg.chat_id,
            )

    async def _maybe_fan_out_unified_inbox(
        self,
        msg: OutboundMessage,
    ) -> None:
        """统一会话模式下，将非 WebSocket 通道出站消息 fan-out 到 inbox:unified。"""
        if not self._unified_session or msg.channel == "websocket":
            return
        if msg.metadata.get("_unified_inbox_write"):
            return

        ws_channel = self.channels.get("websocket")
        if ws_channel is None:
            return

        meta = msg.metadata or {}

        if meta.get("_turn_end"):
            await self._fan_out_unified_inbox_turn_end(ws_channel, msg)
            return

        if self._is_unified_inbox_system_meta(msg):
            return

        if meta.get("_vision_caption_delta"):
            if msg.content:
                await self._fan_out_unified_inbox_stream(
                    ws_channel, msg, event="vision_caption_delta", text=msg.content,
                )
            return

        if meta.get("_vision_caption_end"):
            await self._fan_out_unified_inbox_stream(
                ws_channel, msg, event="vision_caption_end", text=msg.content or "",
            )
            return

        # 仅有 _stream_delta 而无 _stream_end：中间分片，实时推 delta 并积累到 buf。
        # 当 _stream_delta=True 且 _stream_end=True（队列积压后被 _coalesce_stream_deltas
        # 合并成单包）时，此分支不命中，直接落到下方 _stream_end 分支处理整包。
        if meta.get("_stream_delta") and not meta.get("_stream_end"):
            key = self._unified_stream_key(msg)
            if msg.content:
                buf = self._unified_inbox_stream_bufs.setdefault(key, [])
                buf.append(msg.content)
                await self._fan_out_unified_inbox_stream(
                    ws_channel, msg, event="delta", text=msg.content,
                )
            return

        if meta.get("_stream_end"):
            # 收集 buf + 本包末尾内容，拼成完整文本后推 message。
            # 不推 stream_end 事件——否则 Electron 会先关 buffer，后续 message 会叠一条。
            # 合并包（_stream_delta+_stream_end）同样走这里，buf 为空则 full_text = msg.content。
            key = self._unified_stream_key(msg)
            buf = self._unified_inbox_stream_bufs.pop(key, [])
            if msg.content:
                buf.append(msg.content)
            full_text = "".join(buf)
            if full_text.strip():
                await self._fan_out_unified_inbox_message(
                    ws_channel, msg, content=full_text,
                )
            else:
                # 空流（如纯工具调用无文本输出），清理可能残留的同会话其他 stream buf。
                self._clear_unified_inbox_stream_bufs(msg.channel, msg.chat_id)
            return

        # _stream_end 已推过完整文本，_streamed 占位消息不再重复推送。
        # 同时清掉该会话所有残留 buf，防止异常中断后跨 turn 泄漏。
        if meta.get("_streamed"):
            self._clear_unified_inbox_stream_bufs(msg.channel, msg.chat_id)
            return

        if not msg.content and not msg.media:
            # 无有效内容（如纯元数据更新），清理残留 buf 后跳过。
            self._clear_unified_inbox_stream_bufs(msg.channel, msg.chat_id)
            return

        # 非流式普通消息，清残留 buf（如 error 路径未收到 _stream_end）后直接 fan-out。
        self._clear_unified_inbox_stream_bufs(msg.channel, msg.chat_id)
        await self._fan_out_unified_inbox_message(
            ws_channel, msg, content=msg.content or "",
        )

    async def _dispatch_outbound(self) -> None:
        """Dispatch outbound messages to the appropriate channel."""
        logger.info("Outbound dispatcher started")

        # Buffer for messages that couldn't be processed during delta coalescing
        # (since asyncio.Queue doesn't support push_front)
        pending: list[OutboundMessage] = []

        while True:
            try:
                # First check pending buffer before waiting on queue
                if pending:
                    msg = pending.pop(0)
                else:
                    msg = await asyncio.wait_for(
                        self.bus.consume_outbound(),
                        timeout=1.0
                    )

                if (
                    msg.metadata.get("_reasoning_delta")
                    or msg.metadata.get("_reasoning_end")
                    or msg.metadata.get("_reasoning")
                ):
                    # Reasoning rides its own plugin channel: only delivered
                    # when the destination channel opts in via ``show_reasoning``
                    # and overrides the streaming primitives. Channels without
                    # a low-emphasis UI affordance keep the base no-op and the
                    # content silently drops here. ``_reasoning`` (one-shot)
                    # is accepted for backward compatibility with hooks that
                    # haven't migrated to delta/end yet.
                    channel = self.channels.get(msg.channel)
                    if channel is not None and channel.show_reasoning:
                        await self._send_with_retry(channel, msg)
                    continue

                if msg.metadata.get("_progress"):
                    if msg.metadata.get("_tool_hint") and not self._should_send_progress(
                        msg.channel, tool_hint=True,
                    ):
                        continue
                    if not msg.metadata.get("_tool_hint") and not self._should_send_progress(
                        msg.channel, tool_hint=False,
                    ):
                        continue

                if msg.metadata.get("_retry_wait"):
                    continue

                if (
                    msg.metadata.get("_runtime_model_updated")
                    and msg.channel == "websocket"
                    and "websocket" not in self.channels
                ):
                    continue

                # Coalesce consecutive _stream_delta messages for the same (channel, chat_id)
                # to reduce API calls and improve streaming latency
                if msg.metadata.get("_stream_delta") and not msg.metadata.get("_stream_end"):
                    msg, extra_pending = self._coalesce_stream_deltas(msg)
                    pending.extend(extra_pending)

                channel = self.channels.get(msg.channel)
                if channel:
                    # Duplicate suppression is scoped to a known source message
                    # so repeated content from separate turns is still delivered.
                    if (
                        not msg.metadata.get("_stream_delta")
                        and not msg.metadata.get("_stream_end")
                        and not msg.metadata.get("_streamed")
                    ):
                        if self._should_suppress_outbound(msg):
                            logger.info("Suppressing duplicate outbound message to {}:{}", msg.channel, msg.chat_id)
                            continue
                    await self._send_with_retry(channel, msg)
                    await self._maybe_fan_out_unified_inbox(msg)
                else:
                    logger.warning("Unknown channel: {}", msg.channel)

            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

    @staticmethod
    async def _send_once(channel: BaseChannel, msg: OutboundMessage) -> None:
        """Send one outbound message without retry policy."""
        if msg.metadata.get("_reasoning_end"):
            await channel.send_reasoning_end(msg.chat_id, msg.metadata)
        elif msg.metadata.get("_reasoning_delta"):
            await channel.send_reasoning_delta(msg.chat_id, msg.content, msg.metadata)
        elif msg.metadata.get("_vision_caption_end"):
            await channel.send_vision_caption_end(msg.chat_id, msg.metadata, msg.content or "")
        elif msg.metadata.get("_vision_caption_delta"):
            await channel.send_vision_caption_delta(msg.chat_id, msg.content, msg.metadata)
        elif msg.metadata.get("_reasoning"):
            # Back-compat: one-shot reasoning. BaseChannel translates this
            # to a single delta + end pair so plugins only implement the
            # streaming primitives.
            await channel.send_reasoning(msg)
        elif msg.metadata.get("_file_edit_events"):
            edits = msg.metadata.get("_file_edit_events")
            await channel.send_file_edit_events(
                msg.chat_id,
                edits if isinstance(edits, list) else [],
                msg.metadata,
            )
        elif msg.metadata.get("_stream_delta") or msg.metadata.get("_stream_end"):
            await channel.send_delta(msg.chat_id, msg.content, msg.metadata)
        elif not msg.metadata.get("_streamed") or msg.metadata.get("_unified_inbox_write"):
            await channel.send(msg)

    def _coalesce_stream_deltas(
        self, first_msg: OutboundMessage
    ) -> tuple[OutboundMessage, list[OutboundMessage]]:
        """Merge consecutive _stream_delta messages for the same (channel, chat_id).

        This reduces the number of API calls when the queue has accumulated multiple
        deltas, which happens when LLM generates faster than the channel can process.

        Returns:
            tuple of (merged_message, list_of_non_matching_messages)
        """
        target_key = (first_msg.channel, first_msg.chat_id)
        combined_content = first_msg.content
        final_metadata = dict(first_msg.metadata or {})
        non_matching: list[OutboundMessage] = []

        # Only merge consecutive deltas. As soon as we hit any other message,
        # stop and hand that boundary back to the dispatcher via `pending`.
        while True:
            try:
                next_msg = self.bus.outbound.get_nowait()
            except asyncio.QueueEmpty:
                break

            # Check if this message belongs to the same stream
            same_target = (next_msg.channel, next_msg.chat_id) == target_key
            is_delta = next_msg.metadata and next_msg.metadata.get("_stream_delta")
            is_end = next_msg.metadata and next_msg.metadata.get("_stream_end")

            if same_target and is_delta and not final_metadata.get("_stream_end"):
                # Accumulate content
                combined_content += next_msg.content
                # If we see _stream_end, remember it and stop coalescing this stream
                if is_end:
                    final_metadata["_stream_end"] = True
                    # Stream ended - stop coalescing this stream
                    break
            else:
                # First non-matching message defines the coalescing boundary.
                non_matching.append(next_msg)
                break

        merged = OutboundMessage(
            channel=first_msg.channel,
            chat_id=first_msg.chat_id,
            content=combined_content,
            metadata=final_metadata,
        )
        return merged, non_matching

    async def _send_with_retry(self, channel: BaseChannel, msg: OutboundMessage) -> None:
        """Send a message with retry on failure using exponential backoff.

        Note: CancelledError is re-raised to allow graceful shutdown.
        """
        max_attempts = max(self.config.channels.send_max_retries, 1)

        for attempt in range(max_attempts):
            try:
                await self._send_once(channel, msg)
                return  # Send succeeded
            except asyncio.CancelledError:
                raise  # Propagate cancellation for graceful shutdown
            except Exception as e:
                if attempt == max_attempts - 1:
                    logger.exception(
                        "Failed to send to {} after {} attempts",
                        msg.channel, max_attempts
                    )
                    return
                delay = _SEND_RETRY_DELAYS[min(attempt, len(_SEND_RETRY_DELAYS) - 1)]
                logger.warning(
                    "Send to {} failed (attempt {}/{}): {}, retrying in {}s",
                    msg.channel, attempt + 1, max_attempts, type(e).__name__, delay
                )
                try:
                    await asyncio.sleep(delay)
                except asyncio.CancelledError:
                    raise  # Propagate cancellation during sleep

    def get_channel(self, name: str) -> BaseChannel | None:
        """Get a channel by name."""
        return self.channels.get(name)

    def get_status(self) -> dict[str, Any]:
        """Get status of all channels."""
        return {
            name: {
                "enabled": True,
                "running": channel.is_running
            }
            for name, channel in self.channels.items()
        }

    @property
    def enabled_channels(self) -> list[str]:
        """Get list of enabled channel names."""
        return list(self.channels.keys())
