"""长文路径运行期验证：长文 → 占位挂载 → 后台摘要 → submit → 合成 mp3。"""
import asyncio
import os
from pathlib import Path

import sys
sys.path.insert(0, "/Users/illusion/dev/self/nanobot")

from nanobot.agent.loop import AgentLoop  # noqa: E402
from nanobot.agent.tools.registry import ToolRegistry  # noqa: E402
from nanobot.agent.voice import VoiceService  # noqa: E402
from nanobot.agent.voice_hook import create_voice_hook_factory  # noqa: E402
from nanobot.bus.events import InboundMessage  # noqa: E402
from nanobot.config.loader import load_config  # noqa: E402
from nanobot.webui.settings_services import WebUISettingsConfig  # noqa: E402

CONFIG = Path(os.path.expanduser("~/.nanobot/config.json"))
SESSION_KEY = "it:test:voice-long"
VOICE_DIR = CONFIG.parent / "media" / "voice"


async def main() -> None:
    config = load_config(CONFIG)
    loop = AgentLoop.from_config(config, tool_registry=ToolRegistry())
    voice = VoiceService(WebUISettingsConfig(CONFIG))
    voice.sessions = loop.sessions
    voice.schedule = loop.schedule_background
    factory = create_voice_hook_factory(loop, config, voice)
    if factory is not None:
        loop.add_hook_factory(factory)
        print("voice hook registered")

    print("=== 长文测试 ===")
    resp = await loop._process_message(
        InboundMessage(
            channel="websocket", sender_id="user", chat_id="desktop",
            content="请写一篇 500 字左右的短文，介绍你作为一个 AI 助手每天的工作内容和工作感受。",
            metadata={"webui_turn_id": "it-voice-long2"},
        ),
        session_key=SESSION_KEY,
    )
    content = resp.content or ""
    print("回复长度:", len(content), "| 开头:", content[:40].replace("\n", " "))
    print("_process_message 已返回（正文先出，语音后台生成中）")

    # 等后台摘要 + 合成完成（无代理直连较慢，给足时间）
    for i in range(6):
        await asyncio.sleep(20)
        files = sorted(VOICE_DIR.glob("*.mp3"))
        print(f"  [{i*20}s] mp3 总数: {len(files)}")
        if len(files) >= 2:
            break
    loop.stop()
    print("=== 完成 ===")


if __name__ == "__main__":
    asyncio.run(main())
