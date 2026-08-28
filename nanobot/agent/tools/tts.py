"""TTS（文本转语音）agent 工具。"""

from __future__ import annotations

import re
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any, Literal

from pydantic import Field

from nanobot.agent.psb_tags import strip_psb_tags
from nanobot.agent.tools.base import Tool, tool_parameters
from nanobot.agent.tools.schema import StringSchema, tool_parameters_schema
from nanobot.config.schema import TtsConfig, TtsFallbackConfig

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


class TtsToolConfig(TtsConfig):
    """tools.tts 配置：TTS provider 参数 + 工具开关 + 固定音色。

    继承 TtsConfig（provider/api_base/api_key/model/response_format/speed/extra_body），
    新增 enabled 和 default_voice。音色仅由系统配置决定，不向 agent 暴露。
    与 imageGeneration 遵循相同模式，挂载在 ToolsConfig.tts 下。
    """

    enabled: bool = False
    message_playback_enabled: bool = Field(
        default=False,
        description="自动为 assistant 回复按句合成并播放 TTS。",
    )
    default_voice: str = Field(
        default="tongtong",
        description="内置 TTS 固定使用的音色名称或 voice_id。"
        "GLM 系统音色示例：tongtong / chuichui；"
        "自定义克隆音色填写 UUID。",
    )
    fallback: TtsFallbackConfig | None = Field(
        default=None,
        description="主 TTS 在首个音频块前失败时使用的备用配置。",
    )
    health_check_url: str | None = Field(
        default=None,
        description="主 TTS 的快速健康检查地址；失败时直接使用 fallback。",
    )
    health_check_timeout_s: float = Field(default=0.5, gt=0, le=10)
    mode: Literal["off", "agent", "always"] | None = Field(
        default=None,
        description="TTS 模式：关闭、由 AI 决定、每轮完整回复自动朗读。",
    )

    @property
    def effective_mode(self) -> Literal["off", "agent", "always"]:
        """读取新 mode；旧配置按原开关无损映射。"""
        if self.mode is not None:
            return self.mode
        if self.message_playback_enabled:
            return "always"
        return "agent" if self.enabled else "off"


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
        cfg = ctx.config.tts
        return cls(
            tts_config=cfg,
            default_voice=cfg.default_voice,
            speech_runtime=getattr(ctx, "speech_runtime", None),
        )

    def __init__(
        self,
        *,
        tts_config: Any,
        default_voice: str = "tongtong",
        speech_runtime: SpeechRuntime | None = None,
    ) -> None:
        self._tts_config = tts_config
        self._default_voice = default_voice
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
            'PSB 标签（如 <psb:timeline name="待机" />）与 THA 表情/动作标签（如 <happy><nod>）'
            "会在合成前自动剥离；标签应保留在 message 的 content 里以驱动桌宠。"
            "中日混合语音须在 text 中标注 [zh]...[/zh] 与 [ja]...[/ja]。"
        )

    async def execute(self, text: str, **_: Any) -> str:
        """使用系统配置的固定音色合成语音。

        ``**_`` 仅用于兼容旧会话可能残留的 ``voice`` 参数；任何遗留参数都会被忽略，
        不得覆盖 ``tools.tts.defaultVoice``。
        """
        resolved_voice = self._default_voice
        if not resolved_voice:
            return "Error: 未配置 TTS 音色，请在 config.json 中设置 tools.tts.defaultVoice"

        spoken_text = strip_spoken_tags(text)
        if not spoken_text:
            return "Error: TTS 文本在剥离桌宠标签后为空"

        context = self._request_context.get()
        if self._speech_runtime is None or context is None:
            return "Error: TTS runtime 未配置"
        result, error = await self._speech_runtime.synthesize(
            config=self._tts_config,
            context=context,
            text=text,
            voice=resolved_voice,
        )
        if result is None:
            return f"Error: {error or 'TTS 合成失败'}"
        return "语音已生成并附着到本轮回复。"
