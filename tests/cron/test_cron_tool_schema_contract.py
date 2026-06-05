"""Regression tests for the cron tool's JSON-schema / runtime contract (#3113).

The schema advertised ``required=["action"]`` while ``_add_job`` rejected empty
``message``; LLMs rationally omitted ``message`` and looped on the runtime
error. The fix keeps ``required=["action"]`` (so ``list``/``remove`` stay
callable) but states the per-action requirement in each field's description
and tightens the runtime error for ``add`` without ``message``.
"""

from __future__ import annotations

import pytest

from nanobot.agent.tools.context import RequestContext
from nanobot.agent.tools.cron import CronTool
from nanobot.agent.tools.registry import ToolRegistry


class _SvcStub:
    """Minimal CronService stand-in; we only exercise schema/dispatch paths."""

    def __init__(self) -> None:
        self.last_add_kwargs: dict | None = None

    def list_jobs(self):
        return []

    def get_job(self, _job_id):
        return None

    def remove_job(self, _job_id):
        return "not-found"

    def add_job(self, **kwargs):
        self.last_add_kwargs = dict(kwargs)

        class _J:
            pass

        j = _J()
        j.id = "id1"
        j.name = kwargs.get("name", "x")
        return j


@pytest.fixture
def registry() -> ToolRegistry:
    tool = CronTool(_SvcStub(), default_timezone="UTC")
    tool.set_context(RequestContext(channel="channel", chat_id="chat-id"))
    reg = ToolRegistry()
    reg.register(tool)
    return reg


class TestSchemaContract:
    def test_list_accepted_without_message(self, registry: ToolRegistry) -> None:
        # action='list' must pass schema validation with nothing but 'action'.
        _, _, err = registry.prepare_call("cron", {"action": "list"})
        assert err is None

    def test_remove_accepted_without_message(self, registry: ToolRegistry) -> None:
        # action='remove' must pass schema validation with just 'action' + 'job_id'.
        _, _, err = registry.prepare_call("cron", {"action": "remove", "job_id": "abc"})
        assert err is None

    def test_add_with_message_accepted(self, registry: ToolRegistry) -> None:
        _, _, err = registry.prepare_call(
            "cron", {"action": "add", "message": "ping", "at": "2030-01-01T00:00:00"}
        )
        assert err is None

    def test_add_without_message_surfaces_actionable_runtime_error(
        self, registry: ToolRegistry
    ) -> None:
        # Schema permits omitting message; the runtime must return a message
        # that tells the LLM exactly what's missing and how to retry, so it
        # doesn't loop like #3113 reports.
        import asyncio

        tool = registry._tools["cron"]  # type: ignore[attr-defined]
        out = asyncio.run(tool.execute(action="add", at="2030-01-01T00:00:00"))
        assert "message" in out
        assert "add" in out
        assert "Retry" in out or "retry" in out


class TestSchemaSelfDescribesRequirements:
    def test_message_description_flags_add_requirement(self) -> None:
        # LLMs rely on field descriptions to infer when something is actually
        # needed. Without this hint, #3113's loop returns.
        tool = CronTool(_SvcStub())
        desc = tool.parameters["properties"]["message"]["description"]
        assert "REQUIRED" in desc and "action='add'" in desc

    def test_job_id_description_flags_remove_requirement(self) -> None:
        tool = CronTool(_SvcStub())
        desc = tool.parameters["properties"]["job_id"]["description"]
        assert "REQUIRED" in desc and "action='remove'" in desc

    def test_top_level_required_stays_narrow(self) -> None:
        # If 'message' or 'job_id' ever creep back into top-level required,
        # list/remove start failing schema validation (the bug PR #3163 v1
        # accidentally introduced).
        tool = CronTool(_SvcStub())
        assert tool.parameters["required"] == ["action"]

    def test_context_messages_exposed_with_default_zero(self) -> None:
        tool = CronTool(_SvcStub())
        prop = tool.parameters["properties"]["context_messages"]
        assert prop["type"] == "integer"
        assert prop["minimum"] == 0
        assert "default 0" in prop["description"]

    def test_add_passes_context_messages_to_service(self, registry: ToolRegistry) -> None:
        import asyncio

        tool = registry._tools["cron"]  # type: ignore[attr-defined]
        asyncio.run(
            tool.execute(
                action="add",
                message="remind me",
                at="2030-01-01T00:00:00",
                context_messages=30,
            )
        )
        assert tool._cron.last_add_kwargs is not None
        assert tool._cron.last_add_kwargs["context_messages"] == 30

    def test_list_shows_context_messages_when_set(self, registry: ToolRegistry) -> None:
        import asyncio
        from nanobot.cron.types import CronJob, CronJobState, CronPayload, CronSchedule

        class _ListSvc(_SvcStub):
            def list_jobs(self):
                return [
                    CronJob(
                        id="j1",
                        name="with-ctx",
                        schedule=CronSchedule(kind="every", every_ms=60_000),
                        payload=CronPayload(message="hi", context_messages=12),
                        state=CronJobState(),
                    ),
                ]

        tool = CronTool(_ListSvc(), default_timezone="UTC")
        out = asyncio.run(tool.execute(action="list"))
        assert "Context: 12 recent unified messages" in out

    def test_invalid_context_messages_defaults_to_zero(self, registry: ToolRegistry) -> None:
        import asyncio

        tool = registry._tools["cron"]  # type: ignore[attr-defined]
        asyncio.run(
            tool.execute(
                action="add",
                message="remind me",
                at="2030-01-01T00:00:00",
                context_messages="not-a-number",  # type: ignore[arg-type]
            )
        )
        assert tool._cron.last_add_kwargs is not None
        assert tool._cron.last_add_kwargs["context_messages"] == 0
