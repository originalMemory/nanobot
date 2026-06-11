"""Unit tests for SessionHistoryStore."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from nanobot.session.history_store import SessionHistoryStore, extract_content_text


class TestExtractContentText:
    def test_plain_string(self):
        assert extract_content_text({"role": "user", "content": "hello"}) == "hello"

    def test_tool_role_string(self):
        assert extract_content_text({"role": "tool", "content": "grep output"}) == "grep output"

    def test_text_blocks(self):
        msg = {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "part one"},
                {"type": "text", "text": "part two"},
            ],
        }
        assert extract_content_text(msg) == "part one part two"

    def test_tool_use_block(self):
        msg = {
            "role": "assistant",
            "content": [
                {"type": "tool_use", "name": "grep", "input": {"pattern": "foo"}},
            ],
        }
        text = extract_content_text(msg)
        assert "grep" in text
        assert "foo" in text

    def test_tool_result_block(self):
        msg = {
            "role": "user",
            "content": [{"type": "tool_result", "content": "done"}],
        }
        assert extract_content_text(msg) == "done"


class TestSessionHistoryStore:
    def test_lazy_init_no_db_until_first_write(self, tmp_path: Path):
        store = SessionHistoryStore(tmp_path)
        assert not (tmp_path / "history.db").exists()
        store.insert_messages(
            "cli:test",
            [{"role": "user", "content": "hello"}],
            "consolidation",
        )
        assert (tmp_path / "history.db").exists()

    def test_creates_schema_on_init(self, tmp_path: Path):
        store = SessionHistoryStore(tmp_path)
        assert store._ensure_conn() is not None
        db_path = tmp_path / "history.db"
        assert db_path.exists()
        with sqlite3.connect(db_path) as conn:
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'",
                )
            }
        assert "session_messages" in tables

    def test_insert_and_search(self, tmp_path: Path):
        store = SessionHistoryStore(tmp_path)
        store.insert_messages(
            "cli:test",
            [
                {"role": "user", "content": "deploy to production"},
                {"role": "assistant", "content": "deployment complete"},
            ],
            "consolidation",
        )
        hits = store.search("production")
        assert len(hits) == 1
        assert hits[0]["session_key"] == "cli:test"
        assert hits[0]["role"] == "user"
        assert "deploy" in hits[0]["snippet"].lower()

    def test_fallback_content_text_from_raw_json(self, tmp_path: Path):
        store = SessionHistoryStore(tmp_path)
        store.insert_messages(
            "cli:test",
            [{"role": "assistant", "content": []}],
            "consolidation",
        )
        with sqlite3.connect(tmp_path / "history.db") as conn:
            row = conn.execute(
                "SELECT content_text FROM session_messages LIMIT 1",
            ).fetchone()
        assert row is not None
        assert row[0]

    def test_session_key_filter(self, tmp_path: Path):
        store = SessionHistoryStore(tmp_path)
        store.insert_messages("cli:a", [{"role": "user", "content": "alpha"}], "consolidation")
        store.insert_messages("cli:b", [{"role": "user", "content": "alpha beta"}], "consolidation")
        hits = store.search("alpha", session_key="cli:a")
        assert len(hits) == 1
        assert hits[0]["session_key"] == "cli:a"

    def test_time_filter(self, tmp_path: Path):
        store = SessionHistoryStore(tmp_path)
        store.insert_messages("cli:test", [{"role": "user", "content": "timed"}], "consolidation")
        with sqlite3.connect(tmp_path / "history.db") as conn:
            conn.execute(
                "UPDATE session_messages SET trimmed_at = ?",
                ("2026-01-01T00:00:00+00:00",),
            )
        assert store.search("timed", since="2026-06-01") == []
        assert len(store.search("timed", since="2025-01-01")) == 1
        assert len(store.search("timed", until="2026-06-01")) == 1

    def test_search_and_or_match_type(self, tmp_path: Path):
        store = SessionHistoryStore(tmp_path)
        store.insert_messages(
            "cli:test",
            [
                {"role": "user", "content": "deploy alpha release"},
                {"role": "user", "content": "alpha only"},
                {"role": "user", "content": "beta only"},
            ],
            "consolidation",
        )
        hits = store.search("alpha beta", limit=10)
        and_hits = [h for h in hits if h["match_type"] == "and"]
        or_hits = [h for h in hits if h["match_type"] == "or"]
        assert len(and_hits) == 0
        assert len(or_hits) >= 2
        assert all(h["match_type"] in ("and", "or") for h in hits)

    def test_limit(self, tmp_path: Path):
        store = SessionHistoryStore(tmp_path)
        msgs = [{"role": "user", "content": f"match {i}"} for i in range(5)]
        store.insert_messages("cli:test", msgs, "consolidation")
        assert len(store.search("match", limit=2)) == 2

    def test_insert_failure_does_not_raise(self, tmp_path: Path):
        store = SessionHistoryStore(tmp_path)
        mock_conn = MagicMock()
        mock_conn.executemany.side_effect = sqlite3.Error("boom")
        mock_conn.__enter__.return_value = mock_conn
        mock_conn.__exit__.return_value = False
        store._conn = mock_conn
        store.insert_messages("cli:test", [{"role": "user", "content": "x"}], "consolidation")

    def test_invalid_sessions_dir_is_noop(self):
        store = SessionHistoryStore(MagicMock())  # type: ignore[arg-type]
        store.insert_messages("cli:test", [{"role": "user", "content": "x"}], "consolidation")
        assert store.search("x") == []

    def test_repo_root_cleanup_removes_magic_mock_artifacts(self):
        from tests.conftest import _cleanup_magic_mock_sqlite_artifacts

        repo_root = Path(__file__).resolve().parents[2]
        junk = repo_root / "<MagicMock name='test.db' id='999999'>"
        junk.write_text("", encoding="utf-8")
        try:
            assert junk.exists()
            _cleanup_magic_mock_sqlite_artifacts()
            assert not junk.exists()
        finally:
            junk.unlink(missing_ok=True)
