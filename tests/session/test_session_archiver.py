"""Unit tests for SessionArchiver."""

from pathlib import Path

import json
import pytest

from nanobot.session.archiver import SessionArchiver
from nanobot.session.manager import Session, FILE_MAX_MESSAGES


def _make_msg(role: str = "user", content: str = "hello") -> dict:
    return {"role": role, "content": content}


def _make_messages(n: int) -> list[dict]:
    msgs = []
    for i in range(n):
        role = "user" if i % 2 == 0 else "assistant"
        msgs.append(_make_msg(role, f"message {i}"))
    return msgs


# ---------------------------------------------------------------------------
# SessionArchiver 基础功能
# ---------------------------------------------------------------------------

class TestSessionArchiverAppend:
    def test_append_creates_file(self, tmp_path: Path) -> None:
        archiver = SessionArchiver(tmp_path)
        archiver.append("cli:test", [_make_msg()], "file_cap")
        archive_file = tmp_path / "archive" / "cli_test.jsonl"
        assert archive_file.exists()

    def test_record_structure(self, tmp_path: Path) -> None:
        archiver = SessionArchiver(tmp_path)
        msgs = [_make_msg("user", "hello"), _make_msg("assistant", "hi")]
        archiver.append("cli:test", msgs, "file_cap")
        archive_file = tmp_path / "archive" / "cli_test.jsonl"
        record = json.loads(archive_file.read_text())
        assert record["_type"] == "trim_archive"
        assert record["session_key"] == "cli:test"
        assert record["reason"] == "file_cap"
        assert record["messages"] == msgs
        assert "trimmed_at" in record

    def test_idle_compact_reason(self, tmp_path: Path) -> None:
        archiver = SessionArchiver(tmp_path)
        archiver.append("cli:test", [_make_msg()], "idle_compact")
        record = json.loads((tmp_path / "archive" / "cli_test.jsonl").read_text())
        assert record["reason"] == "idle_compact"

    def test_empty_messages_skipped(self, tmp_path: Path) -> None:
        archiver = SessionArchiver(tmp_path)
        archiver.append("cli:test", [], "file_cap")
        assert not (tmp_path / "archive" / "cli_test.jsonl").exists()

    def test_multiple_appends_accumulate(self, tmp_path: Path) -> None:
        archiver = SessionArchiver(tmp_path)
        archiver.append("cli:test", [_make_msg()], "file_cap")
        archiver.append("cli:test", [_make_msg("assistant", "reply")], "file_cap")
        lines = (tmp_path / "archive" / "cli_test.jsonl").read_text().splitlines()
        assert len(lines) == 2

    def test_session_key_colon_to_underscore(self, tmp_path: Path) -> None:
        archiver = SessionArchiver(tmp_path)
        archiver.append("telegram:99999", [_make_msg()], "file_cap")
        assert (tmp_path / "archive" / "telegram_99999.jsonl").exists()

    def test_tool_use_messages_preserved(self, tmp_path: Path) -> None:
        """完整 JSON 结构（含 tool_use）应原样保留。"""
        tool_msg = {
            "role": "assistant",
            "content": None,
            "tool_use": [{"id": "t1", "name": "bash", "input": {"cmd": "ls"}}],
        }
        archiver = SessionArchiver(tmp_path)
        archiver.append("cli:test", [tool_msg], "file_cap")
        record = json.loads((tmp_path / "archive" / "cli_test.jsonl").read_text())
        assert record["messages"][0]["tool_use"][0]["name"] == "bash"


# ---------------------------------------------------------------------------
# Rotate 逻辑
# ---------------------------------------------------------------------------

class TestSessionArchiverRotate:
    def test_no_rotate_under_threshold(self, tmp_path: Path) -> None:
        archiver = SessionArchiver(tmp_path)
        archiver.append("cli:test", [_make_msg()], "file_cap")
        archive_dir = tmp_path / "archive"
        files = list(archive_dir.iterdir())
        assert len(files) == 1
        assert files[0].name == "cli_test.jsonl"

    def test_rotate_when_over_threshold(self, tmp_path: Path) -> None:
        archiver = SessionArchiver(tmp_path)
        archiver.MAX_FILE_BYTES = 10  # 极小阈值方便测试

        archiver.append("cli:test", [_make_msg("user", "x" * 20)], "file_cap")
        # 第一次写完后文件已超阈值，第二次写时应 rotate
        archiver.append("cli:test", [_make_msg("assistant", "y")], "file_cap")

        archive_dir = tmp_path / "archive"
        names = {f.name for f in archive_dir.iterdir()}
        assert "cli_test.jsonl" in names
        assert "cli_test.1.jsonl" in names

    def test_rotate_increments_number(self, tmp_path: Path) -> None:
        archiver = SessionArchiver(tmp_path)
        archiver.MAX_FILE_BYTES = 10

        # 写三轮，产生 .1 和 .2
        for i in range(3):
            archiver.append("cli:test", [_make_msg("user", "x" * 20)], "file_cap")

        archive_dir = tmp_path / "archive"
        names = {f.name for f in archive_dir.iterdir()}
        assert "cli_test.jsonl" in names
        assert "cli_test.1.jsonl" in names
        assert "cli_test.2.jsonl" in names


# ---------------------------------------------------------------------------
# enforce_file_cap 集成：on_trim 接收所有 dropped
# ---------------------------------------------------------------------------

class TestEnforceFileCapOnTrim:
    def test_on_trim_receives_all_dropped(self) -> None:
        msgs = _make_messages(FILE_MAX_MESSAGES + 5)
        session = Session(key="cli:test", messages=msgs, last_consolidated=0)

        trimmed: list[list] = []
        session.enforce_file_cap(on_trim=lambda m: trimmed.append(list(m)))

        assert len(trimmed) == 1
        # 裁掉的条数 = 超出部分（至少 5 条，因 user-turn 对齐可能多几条）
        assert len(trimmed[0]) >= 5

    def test_on_trim_includes_consolidated_prefix(self) -> None:
        """已 consolidated 的消息也应出现在 on_trim 里。"""
        msgs = _make_messages(FILE_MAX_MESSAGES + 2)
        session = Session(
            key="cli:test",
            messages=msgs,
            last_consolidated=FILE_MAX_MESSAGES,
        )

        trimmed: list[list] = []
        raw_archived: list[list] = []
        session.enforce_file_cap(
            on_archive=lambda m: raw_archived.append(list(m)),
            on_trim=lambda m: trimmed.append(list(m)),
        )

        assert len(trimmed) == 1
        # on_archive 不应收到已 consolidated 的消息
        # （archive_chunk 为空因为 dropped 全在 last_consolidated 内）
        assert raw_archived == []

    def test_on_trim_not_called_under_limit(self) -> None:
        msgs = _make_messages(10)
        session = Session(key="cli:test", messages=msgs)

        called = []
        session.enforce_file_cap(on_trim=lambda m: called.append(m))
        assert called == []

    def test_prefix_trim_when_over_cap_with_last_consolidated(self) -> None:
        """超限时优先整段裁掉 consolidated 前缀，并重置 last_consolidated。"""
        msgs = _make_messages(FILE_MAX_MESSAGES + 1)
        session = Session(
            key="cli:test",
            messages=msgs,
            last_consolidated=FILE_MAX_MESSAGES - 300,
        )

        trimmed: list[list] = []
        raw_archived: list[list] = []
        session.enforce_file_cap(
            on_archive=lambda m: raw_archived.append(list(m)),
            on_trim=lambda m: trimmed.append(list(m)),
        )

        assert len(trimmed) == 1
        assert len(trimmed[0]) == FILE_MAX_MESSAGES - 300
        assert session.last_consolidated == 0
        assert len(session.messages) == 301
        assert raw_archived == []

    def test_prefix_trim_then_hard_cap_when_still_over_limit(self) -> None:
        """prefix trim 后仍超限时继续走 legal suffix hard cap。"""
        prefix_len = 500
        msgs = _make_messages(FILE_MAX_MESSAGES + 800)
        session = Session(
            key="cli:test",
            messages=msgs,
            last_consolidated=prefix_len,
        )

        trimmed: list[list] = []
        raw_archived: list[list] = []
        session.enforce_file_cap(
            on_archive=lambda m: raw_archived.append(list(m)),
            on_trim=lambda m: trimmed.append(list(m)),
        )

        assert len(trimmed) == 2
        assert len(trimmed[0]) == prefix_len
        assert len(trimmed[1]) >= 200
        assert session.last_consolidated == 0
        assert len(session.messages) <= FILE_MAX_MESSAGES
        if raw_archived:
            archived_contents = {m["content"] for m in raw_archived[0]}
            assert all(
                content.startswith("message ")
                and int(content.removeprefix("message ")) >= prefix_len
                for content in archived_contents
            )
