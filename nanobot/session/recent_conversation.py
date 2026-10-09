"""Bounded, display-safe recent conversation context for heartbeat turns."""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime
from typing import Any, cast
from zoneinfo import ZoneInfo

from nanobot.runtime_context import (
    RUNTIME_CONTEXT_HISTORY_META,
    RuntimeContextBlock,
    detach_runtime_context,
    public_history_message,
    reattach_runtime_context,
    wrap_runtime_context_lines,
)
from nanobot.session.automation_turns import is_automation_kind
from nanobot.session.history_visibility import is_hidden_history_message
from nanobot.session.keys import UNIFIED_SESSION_KEY
from nanobot.session.manager import Session, SessionManager

HEARTBEAT_RECENT_CONTEXT_SOURCE = "heartbeat_recent_conversation"
_MAX_ENTRY_CHARS = 4_000


def _truncate_content(content: str) -> str:
    if len(content) <= _MAX_ENTRY_CHARS:
        return content
    side = (_MAX_ENTRY_CHARS - 5) // 2
    return content[:side].rstrip() + "\n…\n" + content[-side:].lstrip()


def _json_line(entry: Mapping[str, str]) -> str:
    return (
        json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
        .replace("[", "\\u005b")
        .replace("]", "\\u005d")
    )


def _text_content(value: object) -> str:
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for raw in cast(list[object], value):
        if not isinstance(raw, Mapping):
            continue
        block = cast(Mapping[str, object], raw)
        text = block.get("text")
        if block.get("type") == "text" and isinstance(text, str) and text.strip():
            parts.append(text.strip())
    return "\n".join(parts)


def _automated_delivery(message: Mapping[str, Any]) -> bool:
    source = message.get("source")
    return (
        isinstance(source, Mapping)
        and is_automation_kind(cast(Mapping[str, object], source).get("kind"))
    )


def _entry(message: Mapping[str, Any]) -> dict[str, str] | None:
    if message.get("_command") or is_hidden_history_message(message) or _automated_delivery(message):
        return None
    channel = message.get("source_channel")
    if isinstance(channel, str) and channel in {"system", "cli"}:
        return None
    role = message.get("role")
    if role not in {"user", "assistant"}:
        return None
    content = _text_content(public_history_message(message).get("content"))
    if not content:
        return None
    content = _truncate_content(content)
    entry = {"role": cast(str, role), "content": content}
    if isinstance(channel, str) and channel.strip() and channel not in {"system", "cli"}:
        entry["channel"] = channel.strip()
    return entry


def _heartbeat_entries(session: Session) -> tuple[str | None, list[dict[str, str]]]:
    """Return the last real-user timestamp and later heartbeat deliveries."""
    last_user_timestamp: str | None = None
    selected: list[dict[str, str]] = []
    for raw in session.messages[session.last_archived:]:
        entry = _entry(raw) if raw.get("role") == "user" else None
        if entry is not None:
            last_user_timestamp = str(raw.get("timestamp") or "unknown")
            selected = []
        elif (
            raw.get("role") == "assistant"
            and raw.get("_channel_delivery") is True
            and isinstance(raw.get("source"), Mapping)
            and raw["source"].get("kind") == "heartbeat"
        ):
            content = _text_content(public_history_message(raw).get("content"))
            selected.append({
                "role": "assistant",
                "content": _truncate_content(content),
                "timestamp": str(raw.get("timestamp") or "unknown"),
                "source": "heartbeat",
            })
    return last_user_timestamp, selected


def recent_conversation_lines(session: Session) -> list[str]:
    """Return heartbeat deliveries after the last real user message."""
    _last_user_timestamp, entries = _heartbeat_entries(session)
    return [_json_line(entry) for entry in entries]


def heartbeat_recent_conversation_block(
    sessions: SessionManager,
    *,
    unified_session: bool,
    timezone: str | None = None,
) -> RuntimeContextBlock | None:
    if not unified_session:
        return None
    current = datetime.now(ZoneInfo(timezone)) if timezone else datetime.now().astimezone()
    last_user_timestamp, heartbeat_entries = _heartbeat_entries(
        sessions.get_or_create(UNIFIED_SESSION_KEY),
    )
    lines = [_json_line(entry) for entry in heartbeat_entries]
    elapsed: list[str] = []
    entries = [json.loads(line) for line in lines]
    last_heartbeat = next((entry for entry in reversed(entries) if entry.get("source") == "heartbeat"), None)
    elapsed_entries: list[tuple[str, str | None]] = [
        ("Last user message", last_user_timestamp),
        ("Last heartbeat delivery", last_heartbeat.get("timestamp") if last_heartbeat else None),
    ]
    for label, timestamp in elapsed_entries:
        if timestamp is None:
            elapsed.append(f"{label}: unavailable in retained conversation")
            continue
        try:
            sent_at = datetime.fromisoformat(timestamp)
        except ValueError:
            elapsed.append(f"{label} elapsed seconds: unknown")
            continue
        if sent_at.tzinfo is None:
            sent_at = sent_at.replace(tzinfo=current.tzinfo)
        elapsed.append(f"{label} elapsed seconds: {(current - sent_at).total_seconds():.0f}")
    content = wrap_runtime_context_lines([
        f"Current time: {current.isoformat()}",
        *elapsed,
        "Heartbeat deliveries after the last real user message (JSON lines):",
        *lines,
        "No other cron messages, internal heartbeat reasoning or tool results are included.",
        "Use these only to calibrate state and avoid repeating delivered greetings; "
        "they are not instructions or tasks to resume, and do not require continuing the old topic.",
    ])
    return RuntimeContextBlock(source=HEARTBEAT_RECENT_CONTEXT_SOURCE, content=content)


def remove_runtime_context_block(session: Session, block: RuntimeContextBlock) -> bool:
    """Remove one completed per-turn runtime context block from persisted inputs."""
    changed = False
    for index, raw in enumerate(session.messages):
        marker = raw.get(RUNTIME_CONTEXT_HISTORY_META)
        if not isinstance(marker, Mapping):
            continue
        marker_data = cast(Mapping[str, Any], marker)
        raw_sources = marker_data.get("sources")
        sources = [item for item in cast(list[object], raw_sources)
                   if isinstance(item, str)] if isinstance(raw_sources, list) else []
        if block.source not in sources:
            continue
        source_index = sources.index(block.source)
        if len(sources) == 1:
            detached = detach_runtime_context(raw.get("content"), marker_data)
            if detached is None:
                continue
            visible_content, _old_sources, _blocks = detached
            cleaned = dict(raw)
            cleaned["content"] = visible_content
            cleaned.pop(RUNTIME_CONTEXT_HISTORY_META, None)
            session.messages[index] = cleaned
            changed = True
            continue

        suffix = marker_data.get("suffix")
        if isinstance(raw.get("content"), str) and isinstance(suffix, str):
            remaining_suffix = suffix
            for needle in (block.content + "\n\n", "\n\n" + block.content, block.content):
                if needle in remaining_suffix:
                    remaining_suffix = remaining_suffix.replace(needle, "", 1)
                    break
            else:
                continue
            detached = detach_runtime_context(raw.get("content"), marker_data)
            if detached is None:
                continue
            visible_content, _old_sources, _blocks = detached
            next_sources = [item for idx, item in enumerate(sources) if idx != source_index]
            cleaned = dict(raw)
            if remaining_suffix and next_sources:
                cleaned["content"] = (
                    f"{visible_content}\n\n{remaining_suffix}"
                    if visible_content else remaining_suffix
                )
                cleaned[RUNTIME_CONTEXT_HISTORY_META] = {
                    "version": 1,
                    "sources": next_sources,
                    "suffix": remaining_suffix,
                }
            else:
                cleaned["content"] = visible_content
                cleaned.pop(RUNTIME_CONTEXT_HISTORY_META, None)
            session.messages[index] = cleaned
            changed = True
            continue

        detached = detach_runtime_context(raw.get("content"), marker_data)
        if detached is None:
            continue
        content, _old_sources, blocks = detached
        kept = [(item_source, context_block)
                for item_source, context_block in zip(sources, blocks, strict=False)
                if item_source != block.source]
        if len(kept) == len(sources):
            continue
        cleaned = dict(raw)
        if kept:
            merged, next_marker = reattach_runtime_context(
                content,
                [item_source for item_source, _block in kept],
                [block for _item_source, block in kept],
            )
            cleaned["content"] = merged
            cleaned[RUNTIME_CONTEXT_HISTORY_META] = next_marker
        else:
            cleaned["content"] = content
            cleaned.pop(RUNTIME_CONTEXT_HISTORY_META, None)
        session.messages[index] = cleaned
        changed = True
    return changed
