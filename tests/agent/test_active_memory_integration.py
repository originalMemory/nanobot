"""新上游接入验证：只用模拟模型与临时日记，不读取个人数据。"""

import asyncio
import json
from copy import deepcopy
from unittest.mock import AsyncMock

import httpx
import pytest

from nanobot.agent.active_memory import ActiveMemoryHook, create_active_memory_hook_factory
from nanobot.agent.diary_search import search_diary_files
from nanobot.agent.hook import AgentHookContext, AgentRunHookContext, AgentTurnHookContext
from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.context import RequestContext, request_context
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.config.schema import Config
from nanobot.providers.base import LLMProvider, LLMResponse
from nanobot.utils.llm_runtime import LLMRuntime


class Provider(LLMProvider):
    def __init__(self):
        super().__init__(provider_name="test")
        self.calls = []
        self.options = []

    def get_default_model(self):
        return "test-model"

    async def chat(self, messages, **kwargs):
        self.calls.append(deepcopy(messages))
        self.options.append(kwargs)
        return LLMResponse(content="记得，星海的故事。")


def configuration(tmp_path):
    diary = tmp_path / "diary"
    diary.mkdir()
    (diary / "2026-09-18 周五.md").write_text("星海的角色月白登场。", encoding="utf-8")
    return Config(diaryRoot=str(diary), agents={"defaults": {
        "workspace": str(tmp_path), "model": "test-model",
        "idleCompactAfterMinutes": 0,
    }})


async def test_from_config_recall_reaches_provider_but_not_saved_user_text(tmp_path, monkeypatch):
    config = configuration(tmp_path)
    extract = AsyncMock(return_value="星海")
    monkeypatch.setattr(ActiveMemoryHook, "_extract_keywords", extract)
    provider = Provider()
    loop = AgentLoop.from_config(config, provider=provider, tool_registry=ToolRegistry())
    await loop.process_direct("继续说说星海的故事")
    assert extract.await_count == 1
    assert any("Active Memory" in str(row.get("content")) for row in provider.calls[0])
    assert "月白登场" in json.dumps(provider.calls[0], ensure_ascii=False)
    session = loop.sessions.get_or_create("cli:direct")
    assert session.messages[0]["content"] == "继续说说星海的故事"
    assert "Active Memory" not in json.dumps(session.messages, ensure_ascii=False)
    assert "diary_search" not in loop.tools.tool_names


async def test_turn_local_pending_and_shared_topic_single_flight(tmp_path, monkeypatch):
    config = configuration(tmp_path)
    loop = AgentLoop.from_config(config, provider=Provider(), tool_registry=ToolRegistry())
    factory = create_active_memory_hook_factory(loop, config)
    assert factory
    turn = AgentTurnHookContext(workspace=tmp_path, channel="websocket", session_key="unified:default")
    with request_context(RequestContext(channel="websocket", chat_id="desktop", original_user_text="星海很好玩")):
        first, second = factory(turn), factory(turn)
        assert isinstance(first, ActiveMemoryHook) and isinstance(second, ActiveMemoryHook)
        assert first._pending_topic_cards is not second._pending_topic_cards
        assert first._topic_lock is second._topic_lock
        assert first._topic_tasks is second._topic_tasks
        assert factory(AgentTurnHookContext(workspace=tmp_path, ephemeral=True)) is None
        assert factory(AgentTurnHookContext(workspace=tmp_path / "other")) is None
        assert factory(AgentTurnHookContext(workspace=tmp_path, metadata={"_cron_trigger": {"job_id": "x"}})) is None
        for key in ("heartbeat", "dream:run", "cron:job", "system:check", "subagent:task"):
            assert factory(AgentTurnHookContext(workspace=tmp_path, channel="websocket", session_key=key)) is None
    scheduled = []
    for hook in (first, second):
        hook.configure_topic_summary(AsyncMock(), scheduled.append)
        hook._pending_topic_cards["test"] = ("星海", [], "fingerprint", "request")
    await first.on_finally(AgentRunHookContext(messages=[]))
    await second.on_finally(AgentRunHookContext(messages=[]))
    assert len(scheduled) == 1
    scheduled[0].close()


async def test_keyword_failure_and_cancellation_leave_original_message(tmp_path, monkeypatch):
    config = configuration(tmp_path)
    monkeypatch.setattr("nanobot.agent.active_memory.OLLAMA_TIMEOUT", 0.01)
    hook = ActiveMemoryHook(config.diary_root, tmp_path)
    message = {"role": "user", "content": [{"type": "text", "text": "继续说说星海的故事"}]}
    original = deepcopy(message)
    monkeypatch.setattr(hook, "_extract_keywords", AsyncMock(side_effect=httpx.ConnectError("offline")))
    await hook.before_iteration(AgentHookContext(iteration=0, messages=[message]))
    assert message == original
    async def slow(_):
        await asyncio.sleep(1)
        return "星海"
    monkeypatch.setattr(hook, "_extract_keywords", slow)
    await hook.before_iteration(AgentHookContext(iteration=0, messages=[message]))
    assert message == original
    monkeypatch.setattr(hook, "_extract_keywords", AsyncMock(return_value="星海"))
    await hook.before_iteration(AgentHookContext(iteration=0, messages=[message]))
    assert len(message["content"]) == 2
    await hook.on_finally(AgentRunHookContext(messages=[], exception=asyncio.CancelledError()))
    assert message == original


async def test_summary_uses_admitted_model_without_tools_or_user_route(tmp_path):
    from nanobot.agent.tools.context import current_request_context
    from nanobot.llm_usage.context import current_llm_usage_source

    config = configuration(tmp_path)
    provider = Provider()
    loop = AgentLoop.from_config(config, provider=Provider(), tool_registry=ToolRegistry())
    runtime = LLMRuntime.capture(provider, "selected-model", context_window_tokens=100000)
    factory = create_active_memory_hook_factory(loop, config)
    with request_context(RequestContext(channel="websocket", chat_id="desktop", original_user_text="星海很好玩", runtime=runtime)):
        hook = factory(AgentTurnHookContext(workspace=tmp_path))
        async def check(messages, **kwargs):
            assert kwargs["model"] == "selected-model" and kwargs["tools"] is None
            assert current_request_context().channel == "system"
            assert current_llm_usage_source() == "system"
            return LLMResponse(content="summary")
        provider.chat = check
        assert await hook._summarize("evidence") == "summary"
        assert current_request_context().channel == "websocket"


async def test_keyword_http_contract_and_blocked_private_host(tmp_path, monkeypatch):
    hook = ActiveMemoryHook(str(tmp_path), tmp_path)
    client_type = httpx.AsyncClient
    def handler(request):
        data = json.loads(request.content)
        assert data["model"] == "active-memory:1.7b"
        assert data["stream"] is False and data["think"] is False
        return httpx.Response(200, json={"message": {"content": "星海"}})
    monkeypatch.setattr("nanobot.agent.active_memory.httpx.AsyncClient", lambda **kwargs:
                        client_type(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr("nanobot.agent.active_memory.validate_url_target", lambda _: (True, ""))
    assert await hook._extract_keywords("星海很好玩") == "星海"
    monkeypatch.setattr("nanobot.agent.active_memory.validate_url_target", lambda _: (False, "Blocked"))
    with pytest.raises(ValueError, match="Blocked"):
        await hook._extract_keywords("星海很好玩")


def test_diary_paths_are_utf8_literal_and_root_confined(tmp_path):
    config = configuration(tmp_path)
    diary = tmp_path / "diary"
    outside = tmp_path / "private.md"
    outside.write_text("星海不可读取", encoding="utf-8")
    (diary / "link.md").symlink_to(outside)
    paths = search_diary_files(config.diary_root, "星海")
    assert paths == {str((diary / "2026-09-18 周五.md").resolve())}
