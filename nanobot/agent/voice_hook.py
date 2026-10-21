"""统一语音后处理 hook：AI 回复结束后自动生成语音文本并提交合成。

- 不做轮次类型区分：正文非空且无异常即播报（user / cron / heartbeat / system / subagent 一视同仁）。
- 短文（≤ threshold_chars）且无假名：程序清洗后同步 ``voice.submit``，不引入额外 LLM 请求。
- 长文或含假名：占位 audioId 先挂载（落库即见），后台打标/摘要完成后提交合成，不阻塞主流程。
- enabled / threshold_chars 每轮实时读取配置，settings 面板修改后立即生效。
- 摘要/打标/提交失败：摘除占位 voice、不朗读，行为对齐 tts 生成错误（记 warning，不带语音文本）。
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable, Coroutine
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

from nanobot.agent.hook import (
    AgentHook,
    AgentRunHookContext,
    AgentTurnHookContext,
    AgentTurnHookFactory,
)
from nanobot.agent.tools.context import RequestContext, current_request_context, request_context
from nanobot.agent.voice import VoiceService
from nanobot.agent.voice_text import clean_for_tts, contains_kana, validate_language_tags
from nanobot.llm_usage.context import llm_usage_source
from nanobot.session.keys import UNIFIED_SESSION_KEY, session_key_for_channel
from nanobot.session.reply_visibility import is_silent_reply
from nanobot.webui.metadata import WEBUI_TURN_METADATA_KEY
from nanobot.webui.session_identity import DESKTOP_CHAT_ID

if TYPE_CHECKING:
    from nanobot.agent.loop import AgentLoop

_SUMMARY_PROMPT = (
    "你是语音播报摘要器。把用户消息中的回复压缩成不超过 {limit} 字的口语化播报文本，"
    "保留关键数字、结论、变更和需要介入的事项，保持原文语气与口吻"
    "（如鲸鱼娘风格），不要输出 Markdown 符号或任何解释，直接输出播报正文。"
)

_SUMMARY_TAG_PROMPT = (
    "你是语音播报摘要器。把用户消息中的回复压缩成不超过 {limit} 字的口语化播报文本，"
    "保留关键数字、结论、变更和需要介入的事项，保持原文语气与口吻"
    "（如鲸鱼娘风格）。文本中日混合：日文片段用 [ja]...[/ja] 包裹、"
    "中文片段用 [zh]...[/zh] 包裹，标签必须覆盖全部输出文本（不得有未标注残留）。"
    "不要输出 Markdown 符号或任何解释，直接输出带标签的播报正文。"
)

_TAG_PROMPT = (
    "用户消息中的文本是中日混合语音播报文本。请把日文片段用 [ja]...[/ja] 包裹、"
    "中文片段用 [zh]...[/zh] 包裹，标签必须覆盖全部文本（不得有未标注残留），"
    "保持原文内容与顺序，只输出带标签的文本，不要解释。"
)

_VOICE_LOG_MAX_BYTES = 5 * 1024 * 1024
_SHANGHAI = timezone(timedelta(hours=8))

# 心跳 message 工具投递内容写入目标 session 时的轮次标记，
# 与 gateway_runtime._HEARTBEAT_DELIVERY_TURN_KEY 取值对齐。
_HEARTBEAT_DELIVERY_TURN_KEY = "_heartbeat_delivery_turn_id"


def _log_voice(
    request: RequestContext,
    turn_id: str,
    mode: str,
    *,
    async_ms: int | None,
    text_chars: int,
    status: str,
) -> None:
    """Append bounded, content-free TTS evaluation metadata to the workspace log."""
    if request.workspace is None:
        return
    path = Path(request.workspace) / "memory" / "voice_tts.jsonl"
    entry = {
        "timestamp": datetime.now(_SHANGHAI).isoformat(),
        "turn_id": turn_id,
        "message_id": request.message_id,
        "mode": mode,
        "async_ms": async_ms,
        "text_chars": text_chars,
        "status": status,
    }
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with suppress(Exception):
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size + len(line.encode("utf-8")) > _VOICE_LOG_MAX_BYTES:
            archive = path.parent / "archive"
            archive.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(_SHANGHAI).strftime("%Y%m%d-%H%M%S-%f")
            path.replace(archive / f"voice_tts-{stamp}.jsonl")
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)


def _japanese_voice_configured(options: Any) -> bool:
    """当前选中音色是否配了日语。voices 数组非空时看 default_voice 条目的 languageVoices.ja；
    空时兼容旧扁平 japanese_voice 字段。未配置日语音色时不打 [ja] 段。"""
    if options.provider != "minimax":
        return False
    if options.voices:
        selected = next((v for v in options.voices if v.id == options.default_voice), None)
        return bool(selected and selected.language_voices.get("ja"))
    return bool(options.japanese_voice)


class VoiceHook(AgentHook):
    """回复结束后统一生成语音的后处理 hook。"""

    def __init__(
        self,
        voice: VoiceService,
        *,
        summarize: Callable[[str, str], Awaitable[str]],
        schedule: Callable[[Coroutine[Any, Any, None]], None],
    ) -> None:
        super().__init__()
        self._voice = voice
        self._summarize = summarize
        self._schedule = schedule

    async def on_finally(self, context: AgentRunHookContext) -> None:
        if context.exception is not None or context.error:
            return  # 异常轮不播报
        request = current_request_context()
        if request is None:
            return
        turn_id = request.metadata.get(WEBUI_TURN_METADATA_KEY) or request.turn_id
        if not isinstance(turn_id, str) or not turn_id:
            return
        options = self._voice.config.load().tools.tts
        if not options.enabled:
            return  # 实时读取：settings 面板关闭后本轮即停
        threshold_chars = options.threshold_chars
        if request.session_key == "heartbeat":
            # 心跳是 internal run：final_content 是内部叙述（不会投递给用户），
            # 优先取 message 工具投递的内容播报；本次无需通知则跳过。
            delivered = self._heartbeat_delivered_content(request, turn_id)
            if delivered is None:
                return  # 心跳无投递 → 不播内部叙述
            content = delivered
        else:
            content = (context.final_content or "").strip()
        if not content or is_silent_reply(content):
            return  # 空正文/静默回复不播报
        cleaned = clean_for_tts(content)
        if not cleaned:
            return
        # 含假名且已配置日语音色时才需要打标；未配置日语音色时整段按中文读。
        tag_needed = contains_kana(cleaned) and _japanese_voice_configured(options)
        if len(cleaned) <= threshold_chars and not tag_needed:
            # 无假名短文：同步提交，语音与文字几乎同时送达（0 额外 LLM 请求）。
            self._submit(request, turn_id, cleaned, mode="sync")
            return
        # 长文或含假名：占位挂载 + 后台（打标/摘要 → 提交），不阻塞 _save_turn。
        try:
            placeholder = self._voice.placeholder(turn_id)
        except ValueError as exc:
            logger.warning("VoiceHook: 语音不可用（turn={}，{}）", turn_id, exc)
            return
        request.attributes["voice"] = placeholder
        mode = "async_summary_tag" if len(cleaned) > threshold_chars and tag_needed else (
            "async_summary" if len(cleaned) > threshold_chars else "async_tag"
        )
        self._schedule(self._build(request, turn_id, cleaned, tag_needed, threshold_chars, mode))

    def _playback_chat_id(self, request: RequestContext) -> str | None:
        return (
            DESKTOP_CHAT_ID
            if request.session_key == UNIFIED_SESSION_KEY and request.channel != "websocket"
            else None
        )

    def _heartbeat_delivered_content(self, request: RequestContext, turn_id: str) -> str | None:
        """心跳轮 message 工具投递的内容：落目标渠道 session 并带轮次标记。

        无投递记录（本次心跳无需通知）返回 None——不播内部叙述。
        """
        sessions = self._voice.sessions
        if sessions is None:
            return None
        config = self._voice.config.load()
        key = session_key_for_channel(
            request.channel, request.chat_id,
            unified_session=config.agents.defaults.unified_session,
        )
        try:
            session = sessions.get_or_create(key)
        except Exception:
            return None
        for message in reversed(session.messages):
            if message.get(_HEARTBEAT_DELIVERY_TURN_KEY) == turn_id:
                content = message.get("content")
                return str(content).strip() if isinstance(content, str) and content.strip() else None
        return None

    def _submit(self, request: RequestContext, turn_id: str, text: str, *, mode: str) -> None:
        try:
            audio = self._voice.submit(
                request.chat_id, turn_id, text,
                channel=request.channel,
                metadata=request.metadata,
                session_key=request.session_key,
                playback_chat_id=self._playback_chat_id(request),
            )
        except ValueError as exc:
            logger.warning("VoiceHook: 语音提交被拒（turn={}，{}）", turn_id, exc)
            _log_voice(request, turn_id, mode, async_ms=None, text_chars=len(text), status="rejected")
            return  # 配置/文本问题：不朗读（对齐现状）
        request.attributes["voice"] = audio
        _log_voice(request, turn_id, mode, async_ms=None, text_chars=len(text), status="submitted")

    def _build(
        self, request: RequestContext, turn_id: str, cleaned: str, tag_needed: bool,
        threshold_chars: int, mode: str,
    ) -> Coroutine[Any, Any, None]:
        async def run() -> None:
            started = time.monotonic()
            text = ""
            try:
                if len(cleaned) > threshold_chars:
                    instruction = (
                        _SUMMARY_TAG_PROMPT if tag_needed else _SUMMARY_PROMPT
                    ).format(limit=threshold_chars)
                else:
                    instruction = _TAG_PROMPT
                # 指令放 system、原文放 user，语义分离。
                text = (await self._summarize(instruction, cleaned)).strip()
                if not text:
                    _log_voice(request, turn_id, mode, async_ms=int((time.monotonic() - started) * 1000), text_chars=0, status="empty")
                    self._voice.remove_voice_placeholder(request.session_key, turn_id)
                    return  # 空输出 → 不朗读
                if tag_needed and ("[ja]" not in text or not validate_language_tags(text)):
                    _log_voice(request, turn_id, mode, async_ms=int((time.monotonic() - started) * 1000), text_chars=len(text), status="invalid_tags")
                    self._voice.remove_voice_placeholder(request.session_key, turn_id)
                    return  # 打标失败（漏 ja 段或未标注残留）→ 不朗读
                try:
                    self._voice.submit(
                        request.chat_id, turn_id, text,
                        channel=request.channel,
                        metadata=request.metadata,
                        session_key=request.session_key,
                        playback_chat_id=self._playback_chat_id(request),
                    )
                except ValueError:
                    raise
                _log_voice(request, turn_id, mode, async_ms=int((time.monotonic() - started) * 1000), text_chars=len(text), status="submitted")
            except Exception as exc:
                # 摘要/打标/提交失败 → 摘除占位、不朗读；不记录语音正文。
                logger.warning(
                    "VoiceHook: 语音后台任务失败（turn={}，{}: {}）",
                    turn_id, type(exc).__name__, exc,
                )
                _log_voice(
                    request, turn_id, mode,
                    async_ms=int((time.monotonic() - started) * 1000),
                    text_chars=len(text), status="failed",
                )
                self._voice.remove_voice_placeholder(request.session_key, turn_id)

        return run()


def create_voice_hook_factory(
    agent: AgentLoop, config: Any, voice: VoiceService,
) -> AgentTurnHookFactory:
    """从配置统一接入：网关启动时创建 VoiceService 后注册。

    enabled / threshold_chars 不在启动时快照——hook 每轮实时读取，
    settings 面板修改后无需重启即生效（config 参数仅保留接线兼容）。
    """
    del config  # 每轮实时读取 voice.config，不再使用启动时快照

    async def summarize(instruction: str, text: str) -> str:
        # 后台请求不继承用户轮次的路由上下文，也不注册工具；指令在 system、原文在 user。
        # 摘要/打标是轻量任务：固定关闭思考（reasoning_effort="none"），避免继承主模型
        # 的高思考配置导致后台任务慢、语音迟迟不到。
        runtime = agent.llm_runtime()
        with request_context(RequestContext(channel="system", chat_id="voice-tts")), llm_usage_source("system"):
            response = await asyncio.wait_for(runtime.provider.chat_with_retry(
                messages=[
                    {"role": "system", "content": instruction},
                    {"role": "user", "content": text},
                ],
                tools=None,
                model=runtime.model, temperature=0.1,
                max_tokens=runtime.generation.max_tokens,
                reasoning_effort="none",
            ), timeout=120)
        if response.finish_reason == "error":
            raise RuntimeError("voice_summary_failed")
        return response.content or ""

    def factory(turn: AgentTurnHookContext) -> AgentHook | None:
        # 统一播报：不做轮次类型区分，直接挂语音 hook。
        return VoiceHook(
            voice,
            summarize=summarize,
            schedule=agent.schedule_background,
        )

    return factory
