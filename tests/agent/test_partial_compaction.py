"""压力压缩保留合法近期后缀，并将原始消息边界正确落到会话归档。"""

import json
from copy import deepcopy
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.agent.context import TranscriptInput
from nanobot.agent.context_governance import (
    ContextCompactionState,
    ContextGovernanceConfig,
    ContextGovernor,
    ModelRequestState,
)
from nanobot.agent.loop import AgentLoop
from nanobot.providers.base import LLMProvider
from nanobot.providers.conversation_state import ProviderConversationStateController
from nanobot.session.manager import SessionManager
from nanobot.session.summary import is_summary_checkpoint


@pytest.mark.parametrize("with_tools", [False, True])
async def test_partial_compaction_retains_recent_turns_and_archives_exact_prefix(tmp_path, with_tools):
    sessions = SessionManager(tmp_path / "workspace", sessions_root=tmp_path / "sessions")
    session = sessions.get_or_create("unified:default")
    for title in ("old", "middle", "recent"):
        session.add_message("user", title)
        if with_tools and title == "middle":
            session.add_message("assistant", "", tool_calls=[{"id": "call-1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}])
            session.add_message("tool", "original tool output", tool_call_id="call-1", name="read_file")
        session.add_message("assistant", title + " answer")
    sessions.save(session)
    original = deepcopy(session.messages)
    transcript = TranscriptInput(history=session.get_history(include_indices=True), current_message="current")
    def build(value):
        return [{"role": "system", "content": value.session_summary["text"] if value.session_summary else "system"},
                *value.history, *([{"role": "user", "content": value.current_message}] if value.current_message else [])]
    summarize = AsyncMock(return_value="old summary")
    messages, compaction = ContextCompactionState.from_transcript(transcript, build, summarize, None)
    assert compaction is not None
    provider = MagicMock(spec=LLMProvider)

    config = ContextGovernanceConfig(provider=provider, model="test", tools=MagicMock(), workspace=tmp_path,
                                     session_key=session.key, max_tool_result_chars=16000,
                                     context_window_tokens=10000, max_tokens=1000)
    state = ModelRequestState(config=config, compaction=compaction,
                              conversation=ProviderConversationStateController(provider=provider, model="test", messages=messages))
    prepared = await ContextGovernor()._compact_request_history(state, compaction, messages, (10000, "test"), tool_definitions=[])
    archived = summarize.call_args.args[0]
    assert [message["content"] for message in archived if message["role"] != "system"] == ["old", "old answer"]
    assert {"middle", "recent", "current"} <= {message["content"] for message in prepared}
    checkpoint = compaction.summary_checkpoint
    assert checkpoint is not None and checkpoint.session_message_index == 2
    session.add_message("user", "current")
    sessions.save(session)
    messages.append({"role": "assistant", "content": "current answer"})
    loop = object.__new__(AgentLoop)
    loop._save_turn(session, messages, transcript.message_count, summary_checkpoint=checkpoint, input_persisted_early=True)
    sessions.save(session)
    assert session.messages[1]["content"] == "middle"
    complete = sessions.read_session_file(session.key)["messages"]
    visible = [message for message in complete if not is_summary_checkpoint(message)]
    assert visible[:-2] == original[2:]
    archived = [json.loads(line) for path in (sessions.workspace / "sessions" / "archive").glob("*.jsonl") for line in path.read_text(encoding="utf-8").splitlines()]
    for row in archived:
        row.pop("_archive_meta")
    assert archived == original[:2]
    assert [message["content"] for message in visible[-2:]] == ["current", "current answer"]
    assert session.provider_state is None
