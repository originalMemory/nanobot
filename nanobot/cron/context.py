"""统一会话上下文注入，供 cron / heartbeat 执行前使用。"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from nanobot.session import UNIFIED_SESSION_KEY, sanitize_assistant_replay_text

if TYPE_CHECKING:
    from nanobot.session.manager import Session, SessionManager


def _format_time_label(timestamp: str) -> str:
    if not timestamp or "T" not in timestamp:
        return ""
    return timestamp.split("T", 1)[1][:5]


def _history_content_matches(raw: dict[str, Any], role: str, content: str) -> bool:
    raw_content = raw.get("content", "")
    if role == "assistant" and isinstance(raw_content, str):
        raw_content = sanitize_assistant_replay_text(raw_content)
    if not isinstance(raw_content, str):
        return False
    entry = content.strip()
    raw_s = raw_content.strip()
    if entry == raw_s:
        return True
    # get_history 可能为用户消息追加图片/附件 breadcrumb
    return role == "user" and bool(raw_s) and entry.startswith(raw_s)


def _align_raw_metas(session: Session, history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按 get_history 输出顺序，从原始消息尾部对齐 source_channel / timestamp。"""
    pool = session.messages[session.last_consolidated:]
    used: set[int] = set()
    metas: list[dict[str, Any]] = []
    for entry in history:
        role = entry.get("role")
        content = entry.get("content", "")
        matched: dict[str, Any] = {}
        if role not in ("user", "assistant") or not isinstance(content, str):
            metas.append(matched)
            continue
        for idx in range(len(pool) - 1, -1, -1):
            if idx in used:
                continue
            raw = pool[idx]
            if raw.get("_command") or raw.get("role") != role:
                continue
            if _history_content_matches(raw, role, content):
                matched = raw
                used.add(idx)
                break
        metas.append(matched)
    return metas


def _format_history_entry(entry: dict[str, Any], raw: dict[str, Any]) -> str | None:
    role = entry.get("role")
    content = entry.get("content", "")
    if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
        return None

    time_label = _format_time_label(str(raw.get("timestamp") or ""))
    channel = raw.get("source_channel")
    if isinstance(channel, str) and channel.strip() and time_label:
        prefix = f"[{channel}, {time_label}]"
    elif time_label:
        prefix = f"[{time_label}]"
    else:
        prefix = ""

    return f"{prefix} {role}: {content}".strip() or None


def build_unified_context_prefix(
    session_manager: SessionManager,
    *,
    unified_session: bool,
    max_messages: int,
) -> str:
    """从 unified:default 读取最近消息，格式化为 cron 上下文前缀。

    使用 Session.get_history()：先对未 consolidate 消息取尾部 ``[-max_messages:]``，
    再做过 legal 边界裁剪，因此是「最近 N 条」而非全量会话。
    """
    if not unified_session or max_messages <= 0:
        return ""

    session = session_manager.get_or_create(UNIFIED_SESSION_KEY)
    history = session.get_history(max_messages=max_messages, include_timestamps=False)
    if not history:
        return ""

    metas = _align_raw_metas(session, history)
    formatted = [
        line
        for entry, raw in zip(history, metas, strict=False)
        if (line := _format_history_entry(entry, raw))
    ]
    if not formatted:
        return ""

    body = "\n".join(formatted)
    return f"## Recent Conversation\n\n{body}"


def prepend_unified_context(
    prompt: str,
    session_manager: SessionManager,
    *,
    unified_session: bool,
    context_messages: int,
) -> str:
    """在 cron/heartbeat prompt 前拼接统一会话上下文。"""
    prefix = build_unified_context_prefix(
        session_manager,
        unified_session=unified_session,
        max_messages=context_messages,
    )
    if not prefix:
        return prompt
    return f"{prefix}\n\n---\n\n{prompt}"
