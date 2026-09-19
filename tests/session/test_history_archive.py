"""原文归档必须先于物理裁剪，失败时仍保留可恢复的完整会话。"""

import json
from copy import deepcopy

import pytest

from nanobot.session.manager import SessionManager
from nanobot.session.summary import is_summary_checkpoint


def fixture(tmp_path):
    manager = SessionManager(tmp_path / "workspace", sessions_root=tmp_path / "sessions")
    session = manager.get_or_create("unified:default")
    for index in range(4):
        session.add_message("user", f"question-{index}", media=[f"/media/{index}.webp"])
        session.add_message("assistant", f"answer-{index}")
    manager.save(session)
    return manager, session


def test_archive_shrinks_live_history_and_preserves_original_in_lover_monthly_path(tmp_path):
    manager, session = fixture(tmp_path)
    original = deepcopy(session.messages)
    session.commit_summary_checkpoint("summary", insert_at=4)
    manager.save(session)
    assert len(session.messages) == 5 and session.last_archived == 0
    assert session.metadata["_archive_offset"] == 4
    manager.invalidate(session.key)
    assert len(manager.get_or_create(session.key).messages) == 5
    active = manager.read_session_file(session.key)["messages"]
    assert active == session.messages
    path = manager.sessions_dir / "archive" / (original[0]["timestamp"][:7] + ".jsonl")
    archived = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    for row in archived:
        assert row.pop("_archive_meta")["session_key"] == session.key
    assert archived + [message for message in active if not is_summary_checkpoint(message)] == original


def test_archive_write_failure_does_not_trim_memory_or_disk(tmp_path, monkeypatch):
    manager, session = fixture(tmp_path)
    store = manager._jsonl_store
    path = store.get_session_path(session.key)
    original_bytes = path.read_bytes()
    session.commit_summary_checkpoint("summary", insert_at=4)
    messages = deepcopy(session.messages)
    def fail(*args, **kwargs):
        raise OSError("disk full")
    monkeypatch.setattr("nanobot.session.history_store._write_text_atomic", fail)
    with pytest.raises(OSError, match="disk full"):
        manager.save(session)
    assert session.messages == messages and session.last_archived == 4
    assert path.read_bytes() == original_bytes


def test_retry_after_archive_success_and_live_save_failure_is_idempotent(tmp_path, monkeypatch):
    manager, session = fixture(tmp_path)
    original = deepcopy(session.messages)
    session.commit_summary_checkpoint("summary", insert_at=4)
    store = manager._jsonl_store
    save = store._save_unlocked
    def fail(*args, **kwargs):
        raise OSError("live save failed")
    monkeypatch.setattr(store, "_save_unlocked", fail)
    with pytest.raises(OSError):
        manager.save(session)
    assert len(session.messages) == 9
    assert manager.read_session_file(session.key)["messages"] == original
    monkeypatch.setattr(store, "_save_unlocked", save)
    manager.save(session)
    assert len(list((manager.sessions_dir / "archive").glob("*.jsonl"))) == 1
    assert len(manager.read_session_file(session.key)["messages"]) == 5


def test_corrupt_monthly_archive_blocks_further_trimming(tmp_path):
    manager, session = fixture(tmp_path)
    session.commit_summary_checkpoint("summary", insert_at=4)
    manager.save(session)
    segment = next((manager.sessions_dir / "archive").glob("*.jsonl"))
    segment.write_text("{broken", encoding="utf-8")
    session.commit_summary_checkpoint("next summary", insert_at=3)
    before = deepcopy(session.messages)
    with pytest.raises(ValueError):
        manager.save(session)
    assert session.messages == before


def test_reset_keeps_original_snapshots_and_checkpoint(tmp_path):
    manager, session = fixture(tmp_path)
    original = deepcopy(session.messages)
    session.metadata["runtime_checkpoint"] = {"unfinished": "reply"}
    manager.save_runtime_checkpoint(session)
    checkpoint = manager._jsonl_store.get_runtime_checkpoint_path(session.key).read_bytes()
    snapshot = manager.archive_session_snapshot(session, reason="reset")
    session.clear()
    manager.save(session)
    assert json.loads(snapshot.read_text(encoding="utf-8"))["messages"] == original
    assert any(path.read_bytes() == checkpoint for path in snapshot.parent.rglob("*.json"))
    assert manager.read_session_file(session.key)["messages"] == []


def test_fork_uses_only_visible_active_turns(tmp_path):
    manager, session = fixture(tmp_path)
    session.commit_summary_checkpoint("summary", insert_at=4)
    manager.save(session)
    fork = manager.fork_session_before_user_index(session.key, "websocket:fork", 1)
    assert fork is not None
    assert [message["content"] for message in manager.read_session_file(fork.key)["messages"] if not is_summary_checkpoint(message)] == ["question-2", "answer-2"]


def test_cross_month_failure_retries_without_duplicates_and_preserves_legacy_lines(tmp_path, monkeypatch):
    from nanobot.session import history_store

    store = history_store.SessionHistoryStore(tmp_path / "sessions")
    store.archive_dir.mkdir(parents=True)
    legacy = '{"role":"user","content":"legacy","timestamp":"2026-08-01"}\n'
    (store.archive_dir / "2026-08.jsonl").write_text(legacy, encoding="utf-8")
    messages = [{"role": "user", "content": "august", "timestamp": "2026-08-31"},
                {"role": "assistant", "content": "september", "timestamp": "2026-09-01"}]
    write = history_store._write_text_atomic
    def fail_second(path, text):
        if path.name == "2026-09.jsonl":
            raise OSError("second month failed")
        return write(path, text)
    monkeypatch.setattr(history_store, "_write_text_atomic", fail_second)
    with pytest.raises(OSError):
        store.insert_messages("unified:default", messages, "compaction")
    monkeypatch.setattr(history_store, "_write_text_atomic", write)
    store.insert_messages("unified:default", messages, "compaction")
    assert (store.archive_dir / "2026-08.jsonl").read_text(encoding="utf-8").startswith(legacy)
    rows = [json.loads(line) for path in sorted(store.archive_dir.glob("*.jsonl"))
            for line in path.read_text(encoding="utf-8").splitlines()]
    assert [row["content"] for row in rows] == ["legacy", "august", "september"]


def test_transient_reset_never_creates_archive(tmp_path):
    manager = SessionManager(tmp_path / "workspace", sessions_root=tmp_path / "sessions")
    session = manager.get_or_create_transient("websocket:private")
    session.add_message("user", "do not retain")
    assert manager.archive_session_snapshot(session, reason="reset") is None
    assert not (manager.sessions_dir / "archive").exists()
