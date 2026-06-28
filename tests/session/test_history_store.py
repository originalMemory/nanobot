"""Unit tests for SessionHistoryStore."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

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
    def test_writes_jsonl_archive_on_first_write(self, tmp_path: Path):
        store = SessionHistoryStore(tmp_path)
        store.insert_messages(
            "cli:test",
            [{"role": "user", "content": "hello", "timestamp": "2026-06-01T00:00:00"}],
            "consolidation",
        )

        out_file = tmp_path / "archive" / "2026-06.jsonl"
        assert out_file.exists()
        record = json.loads(out_file.read_text(encoding="utf-8").strip())
        assert record == {"role": "user", "content": "hello", "timestamp": "2026-06-01T00:00:00"}

    def test_insert_failure_does_not_raise(self, tmp_path: Path):
        store = SessionHistoryStore(tmp_path)
        store._archive_dir = tmp_path / "missing" / "file.txt" / "archive"
        (tmp_path / "missing").write_text("", encoding="utf-8")
        store.insert_messages("cli:test", [{"role": "user", "content": "x"}], "consolidation")

    def test_invalid_sessions_dir_is_noop(self):
        store = SessionHistoryStore(MagicMock())  # type: ignore[arg-type]
        store.insert_messages("cli:test", [{"role": "user", "content": "x"}], "consolidation")
