"""统一收件箱未读水位（``unified:default`` Session metadata）。"""

from __future__ import annotations

from typing import Any

from nanobot.session import UNIFIED_SESSION_KEY
from nanobot.session.manager import Session, SessionManager

INBOX_LAST_DELIVERED_UI_COUNT_KEY = "inbox_last_delivered_ui_count"
# 旧版递增计数；读取 thread 时迁移到水位线。
INBOX_UNREAD_COUNT_KEY = "inbox_unread_count"
# 已实时投递但 fan-out 当下尚未落入 Session 的 UI 消息签名。
INBOX_PENDING_DELIVERED_EVENTS_KEY = "inbox_pending_delivered_ui_events"

# fan-out 成功/失败边界上参与投递水位更新的事件。
_DELIVERY_FANOUT_EVENTS = frozenset({"user", "message"})


def should_track_unread_fanout(payload: dict[str, Any]) -> bool:
    """判断 fan-out 事件是否参与未读/已读水位计算。"""
    event = payload.get("event")
    if event not in _DELIVERY_FANOUT_EVENTS:
        return False
    # tool_hint / progress 在 replay 中为 trace 行，不改变 UI 消息条数边界。
    if event == "message" and payload.get("kind") in ("tool_hint", "progress"):
        return False
    return True


def inbox_ui_message_count(session: Session) -> int:
    """当前 Session 经 inbox 转换后的 UI 消息条数。"""
    from nanobot.webui.transcript import build_inbox_thread_from_session

    data = build_inbox_thread_from_session(session)
    return len(data.get("messages") or [])


def get_last_delivered_ui_count(session: Session, message_count: int) -> int:
    """读取已实时投递对应的 UI 消息条数水位。"""
    if message_count <= 0:
        return 0
    raw = session.metadata.get(INBOX_LAST_DELIVERED_UI_COUNT_KEY)
    if raw is None:
        return message_count
    try:
        return max(0, min(int(raw), message_count))
    except (TypeError, ValueError):
        return message_count


def compute_inbox_unread_count(session: Session, message_count: int) -> int:
    """根据 UI 消息条数与水位计算未读数。"""
    if message_count <= 0:
        return 0
    return max(0, message_count - get_last_delivered_ui_count(session, message_count))


def cap_inbox_unread_count(unread: int, message_count: int) -> int:
    """未读数不超过 thread 消息条数。"""
    if message_count <= 0:
        return 0
    return max(0, min(unread, message_count))


def get_inbox_unread_count(session: Session, message_count: int) -> int:
    """兼容旧调用方：基于水位计算未读数。"""
    return compute_inbox_unread_count(session, message_count)


def mark_inbox_delivered(session_manager: SessionManager, message_count: int) -> None:
    """将投递水位推进到 ``message_count``（attach 或 fan-out 成功）。"""
    if message_count < 0:
        return
    session = session_manager.get_or_create(UNIFIED_SESSION_KEY)
    current = get_last_delivered_ui_count(session, message_count)
    if (
        current >= message_count
        and INBOX_UNREAD_COUNT_KEY not in session.metadata
        and INBOX_PENDING_DELIVERED_EVENTS_KEY not in session.metadata
    ):
        return
    session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] = message_count
    session.metadata.pop(INBOX_UNREAD_COUNT_KEY, None)
    session.metadata.pop(INBOX_PENDING_DELIVERED_EVENTS_KEY, None)
    session_manager.save(session)


def mark_inbox_delivered_from_session(session_manager: SessionManager) -> None:
    """按当前 Session 快照更新投递水位。"""
    session = session_manager.get_or_create(UNIFIED_SESSION_KEY)
    mark_inbox_delivered(session_manager, inbox_ui_message_count(session))


def _fanout_payload_signature(
    payload: dict[str, Any],
    source_channel: str,
    source_chat_id: str,
) -> dict[str, str] | None:
    event = payload.get("event")
    if event == "user":
        role = "user"
    elif event == "message":
        role = "assistant"
    else:
        return None
    text = payload.get("text")
    return {
        "role": role,
        "content": text if isinstance(text, str) else "",
        "source_channel": source_channel,
        "source_chat_id": source_chat_id,
    }


def _message_matches_signature(message: dict[str, Any], signature: dict[str, str]) -> bool:
    if message.get("role") != signature.get("role"):
        return False
    source_channel = signature.get("source_channel")
    if source_channel and message.get("sourceChannel") != source_channel:
        return False
    source_chat_id = signature.get("source_chat_id")
    if source_chat_id and message.get("sourceChatId") not in (None, source_chat_id):
        return False
    content = signature.get("content")
    if content and message.get("content") != content:
        return False
    return True


def reconcile_pending_delivered_events(
    session_manager: SessionManager,
    session: Session,
    messages: list[dict[str, Any]],
) -> None:
    """把 fan-out 先于持久化的投递记录对账到当前 UI 消息水位。"""
    raw_pending = session.metadata.get(INBOX_PENDING_DELIVERED_EVENTS_KEY)
    if not isinstance(raw_pending, list) or not raw_pending:
        return

    message_count = len(messages)
    delivered = get_last_delivered_ui_count(session, message_count)
    remaining: list[dict[str, str]] = []
    cursor = delivered

    for raw_signature in raw_pending:
        if not isinstance(raw_signature, dict):
            continue
        signature = {str(k): str(v) for k, v in raw_signature.items() if v is not None}
        match_index: int | None = None
        for index in range(cursor, message_count):
            if _message_matches_signature(messages[index], signature):
                match_index = index
                break
        if match_index is None:
            remaining.append(signature)
            continue
        cursor = max(cursor, match_index + 1)

    if cursor == delivered and len(remaining) == len(raw_pending):
        return
    session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] = cursor
    if remaining:
        session.metadata[INBOX_PENDING_DELIVERED_EVENTS_KEY] = remaining
    else:
        session.metadata.pop(INBOX_PENDING_DELIVERED_EVENTS_KEY, None)
    session.metadata.pop(INBOX_UNREAD_COUNT_KEY, None)
    session_manager.save(session)


def mark_inbox_delivered_after_fanout(
    session_manager: SessionManager,
    payload: dict[str, Any],
    source_channel: str,
    source_chat_id: str,
) -> None:
    """记录一次成功实时投递，必要时等待 Session 落盘后再推进水位。"""
    session = session_manager.get_or_create(UNIFIED_SESSION_KEY)
    from nanobot.webui.transcript import build_inbox_thread_from_session

    data = build_inbox_thread_from_session(session)
    messages = data.get("messages") or []
    message_count = len(messages)
    signature = _fanout_payload_signature(payload, source_channel, source_chat_id)
    if signature is None:
        mark_inbox_delivered(session_manager, message_count)
        return

    session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] = get_last_delivered_ui_count(
        session,
        message_count,
    )
    pending = session.metadata.get(INBOX_PENDING_DELIVERED_EVENTS_KEY)
    if not isinstance(pending, list):
        pending = []
    session.metadata[INBOX_PENDING_DELIVERED_EVENTS_KEY] = [*pending, signature]
    session.metadata.pop(INBOX_UNREAD_COUNT_KEY, None)
    session_manager.save(session)
    session = session_manager.get_or_create(UNIFIED_SESSION_KEY)
    reconcile_pending_delivered_events(session_manager, session, messages)


def ensure_inbox_delivery_baseline(session_manager: SessionManager) -> None:
    """无水位且无 inbox 订阅者收到新事件时，初始化 baseline=0。"""
    session = session_manager.get_or_create(UNIFIED_SESSION_KEY)
    if INBOX_LAST_DELIVERED_UI_COUNT_KEY in session.metadata:
        return
    session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] = 0
    session.metadata.pop(INBOX_UNREAD_COUNT_KEY, None)
    session_manager.save(session)


def migrate_inbox_delivery_watermark(
    session_manager: SessionManager,
    session: Session,
    message_count: int,
) -> None:
    """首次读取 thread 时迁移旧 metadata：历史视为已读，或从旧 unread 计数反推水位。"""
    if INBOX_LAST_DELIVERED_UI_COUNT_KEY in session.metadata:
        return
    legacy_raw = session.metadata.get(INBOX_UNREAD_COUNT_KEY)
    if legacy_raw is not None:
        try:
            legacy_unread = max(0, int(legacy_raw))
        except (TypeError, ValueError):
            legacy_unread = 0
        delivered = max(0, message_count - legacy_unread)
    else:
        delivered = message_count
    session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] = delivered
    session.metadata.pop(INBOX_UNREAD_COUNT_KEY, None)
    session_manager.save(session)


def clear_inbox_unread(session_manager: SessionManager) -> None:
    """attach inbox:unified：将当前 UI 消息全部视为已投递。"""
    mark_inbox_delivered_from_session(session_manager)
