"""Tests for unified inbox unread counter."""

from __future__ import annotations

from nanobot.session import UNIFIED_SESSION_KEY
from nanobot.session.inbox_unread import (
    INBOX_LAST_DELIVERED_UI_COUNT_KEY,
    INBOX_PENDING_DELIVERED_EVENTS_KEY,
    INBOX_UNREAD_COUNT_KEY,
    cap_inbox_unread_count,
    clear_inbox_unread,
    compute_inbox_unread_count,
    ensure_inbox_delivery_baseline,
    mark_inbox_delivered,
    mark_inbox_delivered_after_fanout,
    migrate_inbox_delivery_watermark,
    should_track_unread_fanout,
)
from nanobot.session.manager import Session, SessionManager
from nanobot.webui.transcript import build_inbox_thread_from_session


def test_should_track_unread_fanout() -> None:
    assert should_track_unread_fanout({"event": "user"}) is True
    assert should_track_unread_fanout({"event": "message", "text": "hi"}) is True
    assert should_track_unread_fanout({"event": "message", "kind": "progress"}) is False
    assert should_track_unread_fanout({"event": "turn_end"}) is False


def test_watermark_unread_count() -> None:
    session = Session(key=UNIFIED_SESSION_KEY)
    session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] = 2
    assert compute_inbox_unread_count(session, 5) == 3
    assert compute_inbox_unread_count(session, 0) == 0


def test_migrate_legacy_unread_count(tmp_path) -> None:
    sm = SessionManager(workspace=tmp_path)
    session = sm.get_or_create(UNIFIED_SESSION_KEY)
    session.metadata[INBOX_UNREAD_COUNT_KEY] = 2
    migrate_inbox_delivery_watermark(sm, session, 5)
    session = sm.get_or_create(UNIFIED_SESSION_KEY)
    assert session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] == 3
    assert INBOX_UNREAD_COUNT_KEY not in session.metadata


def test_mark_delivered_and_clear(tmp_path) -> None:
    sm = SessionManager(workspace=tmp_path)
    session = sm.get_or_create(UNIFIED_SESSION_KEY)
    session.add_message("user", "hi")
    session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] = 0
    sm.save(session)
    mark_inbox_delivered(sm, 1)
    session = sm.get_or_create(UNIFIED_SESSION_KEY)
    assert compute_inbox_unread_count(session, 1) == 0
    clear_inbox_unread(sm)
    session = sm.get_or_create(UNIFIED_SESSION_KEY)
    assert session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] == 1


def test_ensure_baseline_only_once(tmp_path) -> None:
    sm = SessionManager(workspace=tmp_path)
    ensure_inbox_delivery_baseline(sm)
    session = sm.get_or_create(UNIFIED_SESSION_KEY)
    assert session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] == 0
    ensure_inbox_delivery_baseline(sm)
    session = sm.get_or_create(UNIFIED_SESSION_KEY)
    assert session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] == 0


def test_cap_inbox_unread_count() -> None:
    assert cap_inbox_unread_count(5, 3) == 3
    assert cap_inbox_unread_count(5, 0) == 0


def test_fanout_before_persist_reconciles_after_thread_build(tmp_path) -> None:
    """实时投递早于 Session 落盘时，thread 构建后应对账为已读。"""
    sm = SessionManager(workspace=tmp_path)
    mark_inbox_delivered_after_fanout(
        sm,
        {"event": "user", "text": "hi"},
        "telegram",
        "tg-1",
    )
    session = sm.get_or_create(UNIFIED_SESSION_KEY)
    assert session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] == 0
    assert session.metadata[INBOX_PENDING_DELIVERED_EVENTS_KEY]

    session.add_message(
        "user",
        "hi",
        source_channel="telegram",
        source_chat_id="tg-1",
    )
    sm.save(session)

    data = build_inbox_thread_from_session(
        sm.get_or_create(UNIFIED_SESSION_KEY),
        session_manager=sm,
    )
    session = sm.get_or_create(UNIFIED_SESSION_KEY)
    assert data["unreadCount"] == 0
    assert session.metadata[INBOX_LAST_DELIVERED_UI_COUNT_KEY] == 1
    assert INBOX_PENDING_DELIVERED_EVENTS_KEY not in session.metadata
