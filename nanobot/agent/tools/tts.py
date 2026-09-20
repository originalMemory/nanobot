"""按需触发 MiniMax，后台合成不阻塞模型回复。"""
from __future__ import annotations

from typing import Any

from nanobot.agent.tools.base import Tool, tool_parameters
from nanobot.agent.tools.context import current_request_context
from nanobot.agent.tools.schema import StringSchema, tool_parameters_schema
from nanobot.agent.voice import DEFERRED_VOICE, VoiceService
from nanobot.session.keys import UNIFIED_SESSION_KEY
from nanobot.webui.metadata import WEBUI_TURN_METADATA_KEY
from nanobot.webui.session_identity import DESKTOP_CHAT_ID


@tool_parameters(tool_parameters_schema(
    text=StringSchema("AI 要说的话。中日混合时用 [zh]...[/zh] 和 [ja]...[/ja] 分段；标签不写入回复正文。", min_length=1, max_length=10000),
    required=["text"],
))
class TtsTool(Tool):
    _plugin_discoverable = False

    def __init__(self, voice: VoiceService):
        self.voice = voice

    @property
    def name(self) -> str:
        return "tts"

    @property
    def description(self) -> str:
        return "需要语音回复时调用，每轮最多一次。使用已配置的 MiniMax 音色后台合成并发送到当前渠道，桌面端流式播放。不要再用 message 重复发送音频。"

    async def execute(self, text: str = "", **_: Any) -> str:
        request = current_request_context()
        if not request:
            return "Error: 缺少当前会话信息"
        if request.session_key == "heartbeat":
            deferred = DEFERRED_VOICE.get()
            if deferred is None or deferred:
                return "Error: 心跳语音不可用或已请求"
            deferred.append(text)
            return "语音请求已记录，将附着到本轮通过 message 发送的问候。"
        turn_id = request.metadata.get(WEBUI_TURN_METADATA_KEY) or request.turn_id
        if not isinstance(turn_id, str) or not turn_id:
            return "Error: 缺少语音轮次标识"
        try:
            audio = self.voice.submit(request.chat_id, turn_id, text, channel=request.channel,
                               metadata=request.metadata, session_key=request.session_key,
                               playback_chat_id=(
                                   DESKTOP_CHAT_ID
                                   if request.session_key == UNIFIED_SESSION_KEY
                                   and request.channel != "websocket"
                                   else None
                               ))
        except ValueError as exc:
            return f"Error: {exc}"
        request.attributes["voice"] = audio
        return "语音生成已触发，完成后发送到当前渠道；桌面端会流式播放。"
