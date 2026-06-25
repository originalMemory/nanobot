"""TTS（文本转语音）agent 工具。"""

from __future__ import annotations

import re
import time
from typing import TYPE_CHECKING, Any

from pydantic import Field

from nanobot.agent.psb_tags import strip_psb_tags
from nanobot.agent.tools.base import Tool, tool_parameters
from nanobot.agent.tools.schema import StringSchema, tool_parameters_schema
from nanobot.config.paths import get_media_dir
from nanobot.config.schema import TtsConfig

if TYPE_CHECKING:
    from nanobot.agent.tools.context import ToolContext

_THA_TAG_RE = re.compile(r"<[^>]+>")


def strip_tha_tags(text: str) -> str:
    """去掉 THA 表情/动作标签，避免 TTS 把标签读出来。"""
    return _THA_TAG_RE.sub("", text).strip()


def strip_spoken_tags(text: str) -> str:
    """去掉 PSB / THA 桌宠标签，仅用于 TTS 合成文本。"""
    return strip_tha_tags(strip_psb_tags(text))


class TtsToolConfig(TtsConfig):
    """tools.tts 配置：TTS provider 参数 + 工具开关 + 默认音色。

    继承 TtsConfig（provider/api_base/api_key/model/response_format/speed/extra_body），
    新增 enabled 和 default_voice。
    与 imageGeneration 遵循相同模式，挂载在 ToolsConfig.tts 下。
    """

    enabled: bool = False
    message_playback_enabled: bool = Field(
        default=False,
        description="自动为 assistant 回复按句合成并播放 TTS。",
    )
    default_voice: str = Field(
        default="tongtong",
        description="默认音色名称或 voice_id（省略时回退此值）。"
                    "GLM 系统音色示例：tongtong / chuichui；"
                    "自定义克隆音色填写 UUID。",
    )


@tool_parameters(
    tool_parameters_schema(
        text=StringSchema(
            "要合成为语音的文本。",
            min_length=1,
            max_length=1024,
        ),
        voice=StringSchema(
            "音色名称或 ID（如 'tongtong'、'chuichui'）。"
            "省略时回退到配置中的默认音色。",
        ),
        required=["text"],
    )
)
class TtsTool(Tool):
    """将文本合成为语音，返回本地音频文件路径。"""

    config_key = "tts"

    @classmethod
    def config_cls(cls) -> type[TtsToolConfig]:
        return TtsToolConfig

    @classmethod
    def enabled(cls, ctx: ToolContext) -> bool:
        return ctx.config.tts.enabled

    @classmethod
    def create(cls, ctx: ToolContext) -> TtsTool:
        cfg = ctx.config.tts
        return cls(tts_config=cfg, default_voice=cfg.default_voice)

    def __init__(
        self,
        *,
        tts_config: Any,
        default_voice: str = "tongtong",
    ) -> None:
        self._tts_config = tts_config
        self._default_voice = default_voice

    @property
    def name(self) -> str:
        return "tts"

    @property
    def description(self) -> str:
        return (
            "使用已配置的 TTS provider 将文本合成为语音。"
            "返回本地音频文件路径，可传入 message 工具的 media 字段发送给频道。"
            "PSB 标签（如 <psb:timeline name=\"待机\" />）与 THA 表情/动作标签（如 <happy><nod>）"
            "会在合成前自动剥离；标签应保留在 message 的 content 里以驱动桌宠。"
        )

    async def execute(self, text: str, voice: str | None = None, **_: Any) -> str:
        from nanobot.providers.tts import build_tts_provider

        provider = build_tts_provider(self._tts_config)
        resolved_voice = voice or self._default_voice
        spoken_text = strip_spoken_tags(text)
        if not spoken_text:
            return "Error: TTS 文本在剥离桌宠标签后为空"

        ts = int(time.time() * 1000)
        ext = self._tts_config.response_format
        out = get_media_dir() / "tts" / f"tts_{ts}.{ext}"

        ok = await provider.synthesize(spoken_text, voice=resolved_voice, output_path=out)
        if not ok:
            return f"Error: TTS 合成失败，provider='{self._tts_config.provider}'"
        return str(out)
