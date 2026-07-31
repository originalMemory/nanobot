from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from nanobot.bus.events import InboundMessage
from nanobot.command.builtin import cmd_dream, cmd_dream_log, cmd_dream_restore
from nanobot.command.router import CommandContext
from nanobot.utils.gitstore import CommitInfo


class _FakeStore:
    def __init__(
        self,
        git,
        last_dream_cursor: int = 1,
        dream_prompt_result=None,
        content_diff: str = "",
    ):
        self.git = git
        self._last_dream_cursor = last_dream_cursor
        self._dream_prompt_result = dream_prompt_result
        self._content_diff = content_diff
        self.compact_history_called = False

    def get_last_dream_cursor(self) -> int:
        return self._last_dream_cursor

    def set_last_dream_cursor(self, value: int) -> None:
        self._last_dream_cursor = value

    def build_dream_prompt(self):
        return self._dream_prompt_result

    def build_dream_tools(self):
        return object()

    def dream_content_diff(self) -> str:
        return self._content_diff

    def compact_history(self) -> None:
        self.compact_history_called = True


class _FakeGit:
    def __init__(
        self,
        *,
        initialized: bool = True,
        commits: list[CommitInfo] | None = None,
        diff_map: dict[str, tuple[CommitInfo, str] | None] | None = None,
        revert_result: str | None = None,
    ):
        self._initialized = initialized
        self._commits = commits or []
        self._diff_map = diff_map or {}
        self._revert_result = revert_result
        self.commits: list[str] = []

    def is_initialized(self) -> bool:
        return self._initialized

    def log(self, max_entries: int = 20) -> list[CommitInfo]:
        return self._commits[:max_entries]

    def show_commit_diff(self, sha: str, max_entries: int = 20):
        return self._diff_map.get(sha)

    def revert(self, sha: str) -> str | None:
        return self._revert_result

    def auto_commit(self, message: str) -> str | None:
        self.commits.append(message)
        return "abcd1234"


class _FakeBus:
    def __init__(self):
        self.outbound = []

    async def publish_outbound(self, message) -> None:
        self.outbound.append(message)


def _make_ctx(raw: str, git: _FakeGit, *, args: str = "", last_dream_cursor: int = 1) -> CommandContext:
    msg = InboundMessage(channel="cli", sender_id="u1", chat_id="direct", content=raw)
    store = _FakeStore(git, last_dream_cursor=last_dream_cursor)
    loop = SimpleNamespace(consolidator=SimpleNamespace(store=store))
    return CommandContext(msg=msg, session=None, key=msg.session_key, raw=raw, args=args, loop=loop)


def _make_runnable_dream(
    tmp_path,
    *,
    content_diff: str,
    stop_reason: str = "completed",
    tool_error: bool = False,
) -> tuple[CommandContext, _FakeStore]:
    msg = InboundMessage(channel="cli", sender_id="u1", chat_id="direct", content="/dream")
    store = _FakeStore(
        _FakeGit(),
        last_dream_cursor=5,
        dream_prompt_result=("dream prompt", 42),
        content_diff=content_diff,
    )

    async def process_direct(*args, **kwargs):
        from nanobot.bus.events import OutboundMessage

        if tool_error:
            await kwargs["on_progress"](
                "",
                tool_events=[{"phase": "error", "name": "edit_file"}],
            )
        return OutboundMessage(
            channel="cli",
            chat_id="direct",
            content="done",
            metadata={"_stop_reason": stop_reason},
        )

    bus = _FakeBus()
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    loop = SimpleNamespace(
        bus=bus,
        context=SimpleNamespace(memory=store),
        sessions=SimpleNamespace(sessions_dir=sessions_dir),
        process_direct=process_direct,
    )
    ctx = CommandContext(
        msg=msg,
        session=None,
        key=msg.session_key,
        raw="/dream",
        args="",
        loop=loop,
    )
    return ctx, store


@pytest.mark.asyncio
async def test_dream_completed_with_diff_advances_and_commits(tmp_path) -> None:
    ctx, store = _make_runnable_dream(
        tmp_path,
        content_diff="SOUL.md: +1 -0\n\n```diff\n+new\n```",
    )

    await cmd_dream(ctx)
    await asyncio.sleep(0)

    assert store._last_dream_cursor == 42
    assert store.git.commits == [
        "dream: manual run\n\nSOUL.md: +1 -0\n\n```diff\n+new\n```"
    ]


@pytest.mark.asyncio
async def test_dream_completed_without_diff_advances_without_commit(tmp_path) -> None:
    ctx, store = _make_runnable_dream(tmp_path, content_diff="")

    await cmd_dream(ctx)
    await asyncio.sleep(0)

    assert store._last_dream_cursor == 42
    assert store.git.commits == []
    assert "no memory changes" in ctx.loop.bus.outbound[-1].content


@pytest.mark.asyncio
async def test_dream_incomplete_keeps_cursor_and_does_not_commit(tmp_path) -> None:
    ctx, store = _make_runnable_dream(
        tmp_path,
        content_diff="SOUL.md: +1 -0",
        stop_reason="length",
    )

    await cmd_dream(ctx)
    await asyncio.sleep(0)

    assert store._last_dream_cursor == 5
    assert store.git.commits == []


@pytest.mark.asyncio
async def test_dream_tool_error_keeps_cursor_and_does_not_commit(tmp_path) -> None:
    ctx, store = _make_runnable_dream(
        tmp_path,
        content_diff="SOUL.md: +1 -0",
        tool_error=True,
    )

    await cmd_dream(ctx)
    await asyncio.sleep(0)

    assert store._last_dream_cursor == 5
    assert store.git.commits == []
    assert "did not complete" in ctx.loop.bus.outbound[-1].content


@pytest.mark.asyncio
async def test_dream_diff_failure_keeps_cursor_and_does_not_commit(tmp_path) -> None:
    ctx, store = _make_runnable_dream(tmp_path, content_diff="")

    def fail_diff():
        raise RuntimeError("git diff failed")

    store.dream_content_diff = fail_diff

    await cmd_dream(ctx)
    await asyncio.sleep(0)

    assert store._last_dream_cursor == 5
    assert store.git.commits == []
    assert "Dream failed" in ctx.loop.bus.outbound[-1].content


@pytest.mark.asyncio
async def test_dream_log_latest_is_more_user_friendly() -> None:
    commit = CommitInfo(sha="abcd1234", message="dream: 2026-04-04, 2 change(s)", timestamp="2026-04-04 12:00")
    diff = (
        "diff --git a/SOUL.md b/SOUL.md\n"
        "--- a/SOUL.md\n"
        "+++ b/SOUL.md\n"
        "@@ -1 +1 @@\n"
        "-old\n"
        "+new\n"
    )
    git = _FakeGit(commits=[commit], diff_map={commit.sha: (commit, diff)})

    out = await cmd_dream_log(_make_ctx("/dream-log", git))

    assert "## Dream Update" in out.content
    assert "Here is the latest Dream memory change." in out.content
    assert "- Commit: `abcd1234`" in out.content
    assert "- Changed files: `SOUL.md`" in out.content
    assert "Use `/dream-restore abcd1234` to undo this change." in out.content
    assert "```diff" in out.content


@pytest.mark.asyncio
async def test_dream_log_missing_commit_guides_user() -> None:
    git = _FakeGit(diff_map={})

    out = await cmd_dream_log(_make_ctx("/dream-log deadbeef", git, args="deadbeef"))

    assert "Couldn't find Dream change `deadbeef`." in out.content
    assert "Use `/dream-restore` to list recent versions" in out.content


@pytest.mark.asyncio
async def test_dream_log_before_first_run_is_clear() -> None:
    git = _FakeGit(initialized=False)

    out = await cmd_dream_log(_make_ctx("/dream-log", git, last_dream_cursor=0))

    assert "Dream has not run yet." in out.content
    assert "Run `/dream`" in out.content


@pytest.mark.asyncio
async def test_dream_restore_lists_versions_with_next_steps() -> None:
    commits = [
        CommitInfo(sha="abcd1234", message="dream: latest", timestamp="2026-04-04 12:00"),
        CommitInfo(sha="bbbb2222", message="dream: older", timestamp="2026-04-04 08:00"),
    ]
    git = _FakeGit(commits=commits)

    out = await cmd_dream_restore(_make_ctx("/dream-restore", git))

    assert "## Dream Restore" in out.content
    assert "Choose a Dream memory version to restore." in out.content
    assert "`abcd1234` 2026-04-04 12:00 - dream: latest" in out.content
    assert "Preview a version with `/dream-log <sha>`" in out.content
    assert "Restore a version with `/dream-restore <sha>`." in out.content


@pytest.mark.asyncio
async def test_dream_restore_success_mentions_files_and_followup() -> None:
    commit = CommitInfo(sha="abcd1234", message="dream: latest", timestamp="2026-04-04 12:00")
    diff = (
        "diff --git a/SOUL.md b/SOUL.md\n"
        "--- a/SOUL.md\n"
        "+++ b/SOUL.md\n"
        "@@ -1 +1 @@\n"
        "-old\n"
        "+new\n"
        "diff --git a/memory/MEMORY.md b/memory/MEMORY.md\n"
        "--- a/memory/MEMORY.md\n"
        "+++ b/memory/MEMORY.md\n"
        "@@ -1 +1 @@\n"
        "-old\n"
        "+new\n"
    )
    git = _FakeGit(
        diff_map={commit.sha: (commit, diff)},
        revert_result="eeee9999",
    )

    out = await cmd_dream_restore(_make_ctx("/dream-restore abcd1234", git, args="abcd1234"))

    assert "Restored Dream memory to the state before `abcd1234`." in out.content
    assert "- New safety commit: `eeee9999`" in out.content
    assert "- Restored files: `SOUL.md`, `memory/MEMORY.md`" in out.content
    assert "Use `/dream-log eeee9999` to inspect the restore diff." in out.content
