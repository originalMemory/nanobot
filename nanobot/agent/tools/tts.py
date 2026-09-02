"""TTS（文本转语音）agent 工具。"""

from __future__ import annotations

import re
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any, Literal

from pydantic import ConfigDict, Field

from nanobot.agent.psb_tags import strip_psb_tags
from nanobot.agent.tools.base import Tool, tool_parameters
from nanobot.agent.tools.schema import StringSchema, tool_parameters_schema
from nanobot.config.schema import Base, ResolvedTtsConfig

if TYPE_CHECKING:
    from nanobot.agent.speech import SpeechRuntime
    from nanobot.agent.tools.context import RequestContext, ToolContext

_THA_TAG_RE = re.compile(r"<[^>]+>")


def strip_tha_tags(text: str) -> str:
    """去掉 THA 表情/动作标签，避免 TTS 把标签读出来。"""
    return _THA_TAG_RE.sub("", text).strip()


def strip_spoken_tags(text: str) -> str:
    """去掉 PSB / THA 桌宠标签，仅用于 TTS 合成文本。"""
    return strip_tha_tags(strip_psb_tags(text))


class TtsToolConfig(Base):
    """tools.tts 配置：运行模式和活动 preset / 音色。"""

    model_config = ConfigDict(extra="forbid")

    mode: Literal["off", "agent", "always"] = Field(
        default="off",
        description="TTS 模式：关闭、由 AI 决定、每轮完整回复自动朗读。",
    )
    preset: str | None = None
    voice: str | None = None

    @property
    def effective_mode(self) -> Literal["off", "agent", "always"]:
        return self.mode


@tool_parameters(
    tool_parameters_schema(
        text=StringSchema(
            "要合成为语音的文本。音色由系统配置固定决定。中日混合时，中文使用 "
            "[zh]...[/zh]，日语使用 [ja]...[/ja]；标签仅写在本参数中，不写入回复正文。",
            min_length=1,
            max_length=1024,
        ),
        required=["text"],
    )
)
class TtsTool(Tool):
    """将文本合成为语音，并绑定到当前 assistant turn。"""

    config_key = "tts"

    @classmethod
    def config_cls(cls) -> type[TtsToolConfig]:
        return TtsToolConfig

    @classmethod
    def enabled(cls, ctx: ToolContext) -> bool:
        return ctx.config.tts.effective_mode == "agent"

    @classmethod
    def create(cls, ctx: ToolContext) -> TtsTool:
        return cls(
            tts_config=getattr(ctx, "tts_runtime_config", None),
            speech_runtime=getattr(ctx, "speech_runtime", None),
        )

    def __init__(
        self,
        *,
        tts_config: ResolvedTtsConfig | None,
        speech_runtime: SpeechRuntime | None = None,
    ) -> None:
        self._tts_config = tts_config
        self._speech_runtime = speech_runtime
        self._request_context: ContextVar[RequestContext | None] = ContextVar(
            "tts_request_context",
            default=None,
        )

    def set_context(self, ctx: RequestContext) -> None:
        self._request_context.set(ctx)

    @property
    def name(self) -> str:
        return "tts"

    @property
    def description(self) -> str:
        return (
            "将本轮要说的话合成为语音并直接播放。每轮最多调用一次。"
            "语音会自动附着到当前 assistant 回复；不要再调用 message 工具发送音频。"
            "中文和日语音色由系统配置，内部会并发生成并按原文顺序连续播放。"
            'PSB 标签（如 <psb:timeline name="待机" />）与 THA 表情/动作标签（如 <happy><nod>）'
            "会在合成前自动剥离；标签应保留在 message 的 content 里以驱动桌宠。"
            "中日混合语音须在 text 中标注 [zh]...[/zh] 与 [ja]...[/ja]。"
        )

    async def execute(self, text: str, **_: Any) -> str:
        """使用活动 TTS preset 的固定音色合成语音。"""
        if self._tts_config is None:
            return "Error: 未解析活动 TTS preset"

        spoken_text = strip_spoken_tags(text)
        if not spoken_text:
            return "Error: TTS 文本在剥离桌宠标签后为空"

        context = self._request_context.get()
        if self._speech_runtime is None or context is None:
            return "Error: TTS runtime 未配置"
        error = self._speech_runtime.submit(
            config=self._tts_config,
            context=context,
            text=text,
        )
        if error:
            return f"Error: {error}"
        return "语音生成已触发，将流式播放并在完成后附着到本轮回复。"
