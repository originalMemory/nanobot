"""统一语音后处理 hook 测试：短文直读、长文后台、打标校验、失败不朗读。"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.agent.hook import AgentRunHookContext
from nanobot.agent.tools.context import RequestContext, bind_request_context, reset_request_context
from nanobot.agent.voice_hook import VoiceHook
from nanobot.config.schema import Config


def _voice(ja: bool = False, enabled: bool = True, threshold: int = 300) -> SimpleNamespace:
    language_voices = {"default": "v"}
    if ja:
        language_voices["ja"] = "ja-voice"
    tools = {"tts": {"apiKey": "k", "defaultVoice": "candice", "enabled": enabled,
                     "thresholdChars": threshold,
                     "voices": [{"id": "candice", "label": "V", "languageVoices": language_voices}]}}
    config = Config(tools=tools)
    voice = SimpleNamespace()
    voice.config = SimpleNamespace(load=lambda: config)
    voice.submit = MagicMock(return_value={"audioId": "a1", "durationMs": 0})
    voice.placeholder = MagicMock(return_value={"audioId": "p1", "durationMs": 0})
    voice.remove_voice_placeholder = MagicMock()
    return voice


def _voice_flat_legacy(ja: bool = False) -> SimpleNamespace:
    """旧扁平兼容：voices 为空，default_voice/japanese_voice 直接是音色 id。"""
    tools = {"tts": {"apiKey": "k", "defaultVoice": "v"}}
    if ja:
        tools["tts"]["japaneseVoice"] = "ja-voice"
    config = Config(tools=tools)
    voice = SimpleNamespace()
    voice.config = SimpleNamespace(load=lambda: config)
    voice.submit = MagicMock(return_value={"audioId": "a1", "durationMs": 0})
    voice.placeholder = MagicMock(return_value={"audioId": "p1", "durationMs": 0})
    voice.remove_voice_placeholder = MagicMock()
    return voice


def _request(workspace=None) -> RequestContext:
    return RequestContext(
        channel="websocket", chat_id="desktop",
        message_id="message-1", metadata={"webui_turn_id": "turn-1"}, turn_id="turn-1",
        session_key="unified:default",
        workspace=workspace,
    )


def _context(content: str = "", exception: BaseException | None = None) -> AgentRunHookContext:
    return AgentRunHookContext(messages=[], final_content=content or None, exception=exception)


def _hook(voice, summary_text: str = "摘要文本"):
    scheduled: list = []
    summarize = AsyncMock(return_value=summary_text)
    hook = VoiceHook(voice, summarize=summarize, schedule=scheduled.append)
    return hook, summarize, scheduled


async def test_short_text_no_kana_submits_immediately():
    voice = _voice()
    hook, _, scheduled = _hook(voice)
    request = _request()
    token = bind_request_context(request)
    try:
        await hook.on_finally(_context("好的喵，晚上见"))
    finally:
        reset_request_context(token)
    assert voice.submit.call_count == 1
    assert not scheduled  # 0 额外 LLM 调用
    assert request.attributes["voice"]["audioId"] == "a1"


async def test_voice_log_records_content_free_evaluation_fields(tmp_path):
    voice = _voice()
    hook, _, _ = _hook(voice)
    request = _request(workspace=tmp_path)
    token = bind_request_context(request)
    try:
        await hook.on_finally(_context("好的喵，晚上见"))
    finally:
        reset_request_context(token)
    record = json.loads((tmp_path / "memory" / "voice_tts.jsonl").read_text(encoding="utf-8"))
    assert record["turn_id"] == "turn-1"
    assert record["message_id"] == "message-1"
    assert record["mode"] == "sync"
    assert record["async_ms"] is None
    assert record["text_chars"] == len("好的喵，晚上见")
    assert record["status"] == "submitted"
    assert "好的喵" not in (tmp_path / "memory" / "voice_tts.jsonl").read_text(encoding="utf-8")


async def test_long_text_schedules_summary_then_submits():
    voice = _voice()
    hook, summarize, scheduled = _hook(voice)
    request = _request()
    token = bind_request_context(request)
    try:
        await hook.on_finally(_context("这段回复" * 80))  # > 300 字
    finally:
        reset_request_context(token)
    assert voice.submit.call_count == 0  # 不阻塞主流程
    assert len(scheduled) == 1
    assert request.attributes["voice"]["audioId"] == "p1"  # 占位先挂载
    await scheduled[0]
    assert voice.submit.call_count == 1
    assert summarize.await_args.args[0].startswith("你是语音播报摘要器")  # 指令在 system
    assert "这段回复" in summarize.await_args.args[1]  # 原文在 user 消息
    assert voice.submit.call_args.args[2] == "摘要文本"


async def test_empty_content_not_voiced():
    voice = _voice()
    hook, _, scheduled = _hook(voice)
    token = bind_request_context(_request())
    try:
        await hook.on_finally(_context(""))
    finally:
        reset_request_context(token)
    assert voice.submit.call_count == 0 and not scheduled


@pytest.mark.parametrize("marker", ["NO_REPLY", " no_reply\n", "NO_REPLAY", "All clear."])
async def test_silent_reply_marker_not_voiced(marker):
    voice = _voice()
    hook, _, scheduled = _hook(voice)
    token = bind_request_context(_request())
    try:
        await hook.on_finally(_context(marker))
    finally:
        reset_request_context(token)
    assert voice.submit.call_count == 0 and not scheduled


async def test_error_turn_not_voiced():
    voice = _voice()
    hook, _, scheduled = _hook(voice)
    token = bind_request_context(_request())
    try:
        await hook.on_finally(_context("内容", exception=RuntimeError("boom")))
    finally:
        reset_request_context(token)
    assert voice.submit.call_count == 0 and not scheduled


async def test_no_request_context_skips():
    voice = _voice()
    hook, _, scheduled = _hook(voice)
    await hook.on_finally(_context("内容"))
    assert voice.submit.call_count == 0 and not scheduled


async def test_kana_with_japanese_voice_runs_tagging():
    voice = _voice(ja=True)
    tagged = "[zh]前面中文[/zh][ja]すずめ[/ja][zh]后面中文[/zh]"
    hook, summarize, scheduled = _hook(voice, summary_text=tagged)
    request = _request()
    token = bind_request_context(request)
    try:
        await hook.on_finally(_context("这首すずめ真好听"))
    finally:
        reset_request_context(token)
    assert len(scheduled) == 1
    await scheduled[0]
    assert voice.submit.call_count == 1
    assert summarize.await_args.args[0].startswith("用户消息中的文本是中日混合")  # 打标指令在 system
    assert "すずめ" in summarize.await_args.args[1]  # 原文在 user 消息


async def test_kana_without_japanese_voice_skips_tagging():
    voice = _voice(ja=False)  # 未配置日语音色 → 整段按中文读
    hook, _, scheduled = _hook(voice)
    request = _request()
    token = bind_request_context(request)
    try:
        await hook.on_finally(_context("这首すずめ真好听"))
    finally:
        reset_request_context(token)
    assert voice.submit.call_count == 1  # 短文同步提交，不打标
    assert not scheduled


async def test_flat_legacy_japanese_voice_also_triggers_tagging():
    # 旧扁平兼容：voices 为空，japaneseVoice 直接字段
    voice = _voice_flat_legacy(ja=True)
    tagged = "[zh]中文[/zh][ja]すずめ[/ja]"
    hook, _, scheduled = _hook(voice, summary_text=tagged)
    request = _request()
    token = bind_request_context(request)
    try:
        await hook.on_finally(_context("すずめ真好听"))
    finally:
        reset_request_context(token)
    await scheduled[0]
    assert voice.submit.call_count == 1  # 兼容路径也能触发打标后朗读


async def test_tagging_missing_ja_segment_not_submitted():
    voice = _voice(ja=True)
    hook, _, scheduled = _hook(voice, summary_text="纯中文摘要")  # AI 漏打 [ja]
    token = bind_request_context(_request())
    try:
        await hook.on_finally(_context("すずめ真好听"))
    finally:
        reset_request_context(token)
    await scheduled[0]
    assert voice.submit.call_count == 0  # 打标失败 → 不朗读
    voice.remove_voice_placeholder.assert_called_once_with("unified:default", "turn-1")  # 占位回滚


async def test_tagging_uncovered_text_not_submitted():
    voice = _voice(ja=True)
    hook, _, scheduled = _hook(voice, summary_text="未标注[ja]すずめ[/ja]残留")
    token = bind_request_context(_request())
    try:
        await hook.on_finally(_context("すずめ真好听"))
    finally:
        reset_request_context(token)
    await scheduled[0]
    assert voice.submit.call_count == 0
    voice.remove_voice_placeholder.assert_called_once_with("unified:default", "turn-1")


async def test_summary_exception_rolls_back_placeholder():
    voice = _voice()
    summarize = AsyncMock(side_effect=RuntimeError("boom"))
    scheduled: list = []
    hook = VoiceHook(voice, summarize=summarize, schedule=scheduled.append)
    token = bind_request_context(_request())
    try:
        await hook.on_finally(_context("这段回复" * 80))  # 长文 → 后台摘要
    finally:
        reset_request_context(token)
    await scheduled[0]
    assert voice.submit.call_count == 0
    voice.remove_voice_placeholder.assert_called_once_with("unified:default", "turn-1")


async def test_disabled_skips_voice_entirely():
    voice = _voice(enabled=False)
    hook, _, scheduled = _hook(voice)
    token = bind_request_context(_request())
    try:
        await hook.on_finally(_context("好的喵"))
    finally:
        reset_request_context(token)
    assert voice.submit.call_count == 0 and not scheduled
    assert "voice" not in _request().attributes


async def test_threshold_read_per_turn_from_config():
    voice = _voice(threshold=5)  # 配置里的阈值，非构造参数
    hook, summarize, scheduled = _hook(voice)
    request = _request()
    token = bind_request_context(request)
    try:
        await hook.on_finally(_context("这是一段超过五个字的回复"))  # > 5 字 → 长文路径
    finally:
        reset_request_context(token)
    assert len(scheduled) == 1
    assert summarize.await_args is None  # 后台尚未执行
    await scheduled[0]
    assert voice.submit.call_count == 1
    assert summarize.await_args.args[0].startswith("你是语音播报摘要器")
