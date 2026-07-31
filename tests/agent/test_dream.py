"""Tests for Dream memory consolidation — build_dream_prompt and cursor management."""

import pytest

from nanobot.agent.memory import DreamRunProgress, MemoryStore
from nanobot.providers.base import LLMResponse
from nanobot.utils.prompt_templates import render_template


@pytest.fixture
def store(tmp_path):
    s = MemoryStore(tmp_path)
    s.write_soul("# Soul\n- Helpful")
    s.write_memory("# Memory\n- Project X active")
    return s


class TestBuildDreamPrompt:
    def test_returns_none_when_no_history(self, store):
        assert store.build_dream_prompt() is None

    def test_returns_prompt_with_history(self, store):
        store.append_history("hello")
        result = store.build_dream_prompt()
        assert result is not None
        prompt, cursor = result
        assert cursor > 0
        assert "## Conversation History" in prompt
        assert "hello" in prompt

    def test_cursor_advances_only_new_entries(self, store):
        store.append_history("first")
        r1 = store.build_dream_prompt()
        assert r1 is not None
        _, c1 = r1

        # Cursor not yet advanced — same entries are still available
        assert store.build_dream_prompt() is not None

        # Advance cursor
        store.set_last_dream_cursor(c1)
        # Now no new entries
        assert store.build_dream_prompt() is None

        # Add new entry
        store.append_history("second")
        r2 = store.build_dream_prompt()
        assert r2 is not None
        _, c2 = r2
        assert c2 > c1

    def test_prompt_includes_skill_creator_path(self, store):
        store.append_history("test")
        result = store.build_dream_prompt()
        assert result is not None
        prompt, _ = result
        assert "skill-creator" in prompt

    def test_prompt_embeds_current_memory_files(self, store):
        store.append_history("hello")

        prompt, _ = store.build_dream_prompt()

        assert "## Current Memory Files" in prompt
        assert "### SOUL.md" in prompt
        assert "- Helpful" in prompt
        assert "### USER.md\n(empty)" in prompt
        assert "### memory/MEMORY.md" in prompt
        assert "- Project X active" in prompt

    def test_prompt_caps_oversized_memory_file(self, store):
        store.write_memory("x" * (store._DREAM_FILE_EMBED_CAP + 100))
        store.append_history("hello")

        prompt, _ = store.build_dream_prompt()

        assert "...[truncated]" in prompt
        assert "x" * (store._DREAM_FILE_EMBED_CAP + 1) not in prompt

    def test_preserves_long_entries(self, store):
        long_content = "x" * 2000
        store.append_history(long_content)
        result = store.build_dream_prompt()
        assert result is not None
        prompt, _ = result
        assert long_content in prompt

    def test_includes_all_unprocessed_entries(self, store):
        for i in range(25):
            store.append_history(f"entry-{i + 1:02d}")

        result = store.build_dream_prompt()
        assert result is not None
        prompt, cursor = result

        assert cursor == 25
        assert "entry-01" in prompt
        assert "entry-20" in prompt
        assert "entry-21" in prompt
        assert "entry-25" in prompt

        store.set_last_dream_cursor(cursor)
        assert store.build_dream_prompt() is None

    def test_dream_prompt_consumes_consolidator_attribute_tags(self):
        prompt = render_template(
            "agent/dream.md",
            strip=True,
            skill_creator_path="skills/skill-creator/SKILL.md",
        )

        assert "History attribute tags" in prompt
        assert "[skip]: audit-only" in prompt
        assert "[correction]: replace the older conflicting fact" in prompt
        assert "Always strip these bracketed tags from saved memory content" in prompt


class TestDreamTools:
    def test_dream_tools_are_restricted_to_file_edits(self, store):
        tools = store.build_dream_tools()

        assert set(tools.tool_names) == {
            "apply_patch",
            "edit_file",
            "read_file",
            "write_file",
        }


class TestEphemeralDirect:
    """Tests for the ephemeral flag that skips history.jsonl writes for Dream."""

    @pytest.fixture
    def _make_loop(self, tmp_path):
        """Factory fixture that builds a minimal AgentLoop with mocked deps."""
        from unittest.mock import AsyncMock, MagicMock, patch

        from nanobot.agent.loop import AgentLoop
        from nanobot.agent.memory import MemoryStore
        from nanobot.bus.queue import MessageBus

        store = MemoryStore(tmp_path)
        store.write_soul("# Soul")
        store.write_memory("# Memory")

        bus = MessageBus()
        provider = MagicMock()
        provider.get_default_model.return_value = "test-model"
        provider.supports_tools = True
        provider.generation = MagicMock(max_tokens=4096)
        provider.chat_with_retry = AsyncMock(
            return_value=LLMResponse(content="done", tool_calls=[], finish_reason="stop", usage={})
        )

        with (
            patch("nanobot.agent.loop.SessionManager"),
            patch("nanobot.agent.loop.SubagentManager") as mock_sub,
            patch("nanobot.agent.loop.Consolidator") as mock_consolidator_cls,
        ):
            mock_sub.return_value.cancel_by_session = AsyncMock(return_value=0)
            mock_consolidator_cls.return_value.maybe_consolidate_by_tokens = AsyncMock()
            loop = AgentLoop(
                bus=bus,
                provider=provider,
                workspace=tmp_path,
                context_window_tokens=8000,
            )

        return loop, store

    async def test_ephemeral_skips_raw_archive(self, tmp_path, _make_loop):
        """When ephemeral=True, raw_archive must not be called."""
        from unittest.mock import patch

        loop, store = _make_loop

        with patch.object(loop.context.memory, "raw_archive") as mock_archive:
            await loop.process_direct(
                "test", session_key="dream:test", ephemeral=True,
            )
            mock_archive.assert_not_called()

    async def test_non_ephemeral_runs_normally(self, tmp_path, _make_loop):
        """Without ephemeral, the normal path returns the model response."""
        loop, store = _make_loop
        response = await loop.process_direct("test", session_key="cli:normal")

        assert response is not None
        assert response.content == "done"
        loop.provider.chat_with_retry.assert_awaited()

    async def test_ephemeral_sets_ctx_flag(self, tmp_path, _make_loop):
        """Verify that ephemeral=True is forwarded to TurnContext."""
        from unittest.mock import patch

        loop, store = _make_loop

        captured = {}

        original_save = loop._state_save

        async def patched_save(ctx):
            captured["ephemeral"] = ctx.ephemeral
            return await original_save(ctx)

        with patch.object(loop, "_state_save", side_effect=patched_save):
            await loop.process_direct(
                "test", session_key="dream:check", ephemeral=True,
            )

        assert captured.get("ephemeral") is True

    async def test_default_ephemeral_is_false(self, tmp_path, _make_loop):
        """By default ephemeral is False in TurnContext."""
        from unittest.mock import patch

        loop, store = _make_loop

        captured = {}

        original_save = loop._state_save

        async def patched_save(ctx):
            captured["ephemeral"] = ctx.ephemeral
            return await original_save(ctx)

        with patch.object(loop, "_state_save", side_effect=patched_save):
            await loop.process_direct("test", session_key="cli:normal")

        assert captured.get("ephemeral") is False

    async def test_ephemeral_skips_consolidator(self, tmp_path, _make_loop):
        """When ephemeral=True, consolidator.maybe_consolidate_by_tokens is not called."""
        from unittest.mock import patch

        loop, store = _make_loop

        with patch.object(
            loop.consolidator, "maybe_consolidate_by_tokens",
        ) as mock_consolidate:
            await loop.process_direct(
                "test", session_key="dream:consolidate-test", ephemeral=True,
            )
            mock_consolidate.assert_not_called()

    async def test_ephemeral_response_reports_stop_reason(self, tmp_path, _make_loop):
        loop, store = _make_loop
        loop.provider.chat_with_retry.return_value = LLMResponse(
            content="provider error",
            finish_reason="error",
        )

        resp = await loop.process_direct(
            "test", session_key="dream:error", ephemeral=True,
        )

        assert resp is not None
        assert resp.metadata["_stop_reason"] == "error"
        assert MemoryStore.dream_run_completed(resp) is False

    async def test_dream_turn_receives_all_unprocessed_history(self, tmp_path):
        """Dream turn 接收全部待处理 history，且不重复注入 Recent History。"""
        from unittest.mock import MagicMock

        from nanobot.agent.loop import AgentLoop
        from nanobot.bus.queue import MessageBus

        store = MemoryStore(tmp_path)
        for i in range(60):
            store.append_history(f"entry-{i + 1:02d}")

        result = store.build_dream_prompt()
        assert result is not None
        prompt, cursor = result
        assert cursor == 60

        captured: dict[str, list[dict]] = {}
        provider = MagicMock()
        provider.get_default_model.return_value = "test-model"
        provider.supports_tools = True
        provider.generation = MagicMock(max_tokens=4096)

        async def chat_with_retry(**kwargs):
            captured["messages"] = kwargs["messages"]
            return LLMResponse(content="done", finish_reason="stop")

        provider.chat_with_retry = chat_with_retry
        loop = AgentLoop(
            bus=MessageBus(),
            provider=provider,
            workspace=tmp_path,
            context_window_tokens=8000,
        )

        await loop.process_direct(
            prompt,
            session_key="dream:test",
            ephemeral=True,
            tools=store.build_dream_tools(),
        )

        messages = captured["messages"]
        system_prompt = messages[0]["content"]
        request_text = "\n".join(str(message.get("content", "")) for message in messages)
        assert "# Recent History" not in system_prompt
        assert "entry-01" in request_text
        assert "entry-20" in request_text
        assert "entry-21" in request_text
        assert "entry-60" in request_text


class TestEphemeralHooks:
    """When ephemeral=True, extra hooks must not fire."""

    @pytest.fixture
    def _make_loop_with_spy(self, tmp_path):
        """Build an AgentLoop with a spy hook to verify hook firing behavior."""
        from unittest.mock import AsyncMock, MagicMock, patch

        from nanobot.agent.hook import AgentHook
        from nanobot.agent.loop import AgentLoop
        from nanobot.bus.queue import MessageBus

        bus = MessageBus()
        provider = MagicMock()
        provider.get_default_model.return_value = "test-model"
        provider.supports_tools = True
        provider.generation = MagicMock(max_tokens=4096)
        provider.chat_with_retry = AsyncMock(
            return_value=MagicMock(
                content="done", finish_reason="stop", tool_calls=[], usage={},
            )
        )

        spy = MagicMock(spec=AgentHook)
        spy.wants_streaming.return_value = False
        spy.before_iteration = AsyncMock()
        spy.after_iteration = AsyncMock()

        with (
            patch("nanobot.agent.loop.SessionManager"),
            patch("nanobot.agent.loop.SubagentManager") as mock_sub,
            patch("nanobot.agent.loop.Consolidator") as mock_consolidator_cls,
        ):
            mock_sub.return_value.cancel_by_session = AsyncMock(return_value=0)
            mock_consolidator_cls.return_value.maybe_consolidate_by_tokens = AsyncMock()
            loop = AgentLoop(
                bus=bus,
                provider=provider,
                workspace=tmp_path,
                context_window_tokens=8000,
                hooks=[spy],
            )

        return loop, spy

    async def test_extra_hooks_skipped_when_ephemeral(self, tmp_path, _make_loop_with_spy):
        """When ephemeral=True, extra hooks must not fire."""
        loop, spy = _make_loop_with_spy

        await loop.process_direct(
            "test", session_key="dream:hook-test", ephemeral=True,
        )
        spy.before_iteration.assert_not_called()
        spy.after_iteration.assert_not_called()

    async def test_extra_hooks_fire_for_normal_sessions(self, tmp_path, _make_loop_with_spy):
        """Without ephemeral, extra hooks should fire normally."""
        loop, spy = _make_loop_with_spy

        await loop.process_direct("test", session_key="cli:normal")
        spy.before_iteration.assert_called()


class TestDreamCommitMessage:
    def test_commit_uses_real_diff_instead_of_model_summary(self, tmp_path):
        import subprocess

        store = MemoryStore(tmp_path)
        store.write_soul("# Soul")
        store.write_memory("# Memory")
        store.git.init()
        store.git.auto_commit("initial state")

        store.write_memory("# Memory\n- Updated by Dream")
        diff_body = store.dream_content_diff()
        msg = MemoryStore.build_dream_commit_message(
            "dream: periodic memory consolidation", diff_body,
        )

        sha = store.git.auto_commit(msg)
        assert sha is not None

        log = subprocess.check_output(
            ["git", "log", "-1", "--format=%B"],
            cwd=str(tmp_path), text=True,
        ).strip()
        assert "dream: periodic memory consolidation" in log
        assert "Updated by Dream" in log
        assert "Identified 2 new facts" not in log

    def test_commit_message_is_bare_prefix_without_diff(self):
        assert MemoryStore.build_dream_commit_message("dream: manual run", "") == (
            "dream: manual run"
        )


class TestDreamCursor:
    def test_invalid_cursor_falls_back_to_zero(self, store):
        store._dream_cursor_file.write_text("-5", encoding="utf-8")
        assert store.get_last_dream_cursor() == 0

        store._dream_cursor_file.write_text("broken", encoding="utf-8")
        assert store.get_last_dream_cursor() == 0

    def test_cursor_does_not_move_backwards(self, store):
        store.set_last_dream_cursor(10)
        store.set_last_dream_cursor(3)
        assert store.get_last_dream_cursor() == 10

    def test_rejects_invalid_cursor_write(self, store):
        with pytest.raises(ValueError):
            store.set_last_dream_cursor(-1)


class TestDreamRunProgress:
    async def test_tool_error_prevents_completed_run(self):
        progress = DreamRunProgress()
        await progress("", tool_events=[{"phase": "error", "name": "edit_file"}])
        response = type("Response", (), {
            "metadata": {"_stop_reason": "completed"},
        })()

        assert progress.had_tool_errors is True
        assert MemoryStore.dream_run_completed(
            response,
            had_tool_errors=progress.had_tool_errors,
        ) is False


class TestDreamContentDiff:
    def test_empty_without_git_or_changes(self, store):
        assert store.dream_content_diff() == ""
        store.git.init()
        assert store.dream_content_diff() == ""

    def test_reflects_content_change_but_ignores_cursor(self, store):
        store.git.init()
        store.set_last_dream_cursor(9)
        assert store.dream_content_diff() == ""

        store.write_memory("# Memory\n- changed")
        diff = store.dream_content_diff()
        assert "memory/MEMORY.md: +1 -1" in diff
        assert "- changed" in diff
        assert ".dream_cursor" not in diff
