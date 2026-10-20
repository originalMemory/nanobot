"""真实链路集成测试：驱动 AgentLoop + 真实 zhipu provider + 真实 VoiceService + voice hook。

验证 spec 运行期项：
1. 短文（≤300 无假名）轮 request_count=1（语音不引入额外请求）
2. 语音真实合成（MiniMax key 有效，生成 mp3）
3. 历史挂载：assistant 消息带 voice 字段，durationMs 回写
4. 长文轮不阻塞（占位先挂，后台摘要后提交）
"""
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, "/Users/illusion/dev/self/nanobot")

from nanobot.agent.loop import AgentLoop  # noqa: E402
from nanobot.agent.tools.registry import ToolRegistry  # noqa: E402
from nanobot.agent.voice import VoiceService  # noqa: E402
from nanobot.agent.voice_hook import create_voice_hook_factory  # noqa: E402
from nanobot.bus.events import InboundMessage  # noqa: E402
from nanobot.config.loader import load_config  # noqa: E402
from nanobot.webui.settings_services import WebUISettingsConfig  # noqa: E402

CONFIG = Path(os.path.expanduser("~/.nanobot/config.json"))
WORKSPACE = Path(os.path.expanduser("~/.nanobot/workspace"))
SESSION_KEY = "it:test:voice"
VOICE_DIR = CONFIG.parent / "media" / "voice"


async def main() -> None:
    config = load_config(CONFIG)
    loop = AgentLoop.from_config(
        config, tool_registry=ToolRegistry(),
    )
    voice = VoiceService(WebUISettingsConfig(CONFIG))
    voice.sessions = loop.sessions
    voice.schedule = loop.schedule_background
    factory = create_voice_hook_factory(loop, config, voice)
    if factory is not None:
        loop.add_hook_factory(factory)
        print("voice hook registered")

    # 1) 短文消息（预期模型回复较短 → 同步语音路径，0 额外 LLM 请求）
    print("\n=== 测试 1：短文 ===")
    resp = await loop._process_message(
        InboundMessage(
            channel="websocket", sender_id="user", chat_id="desktop",
            content="用一句话说说今天天气适合做什么？",
            metadata={"webui_turn_id": "it-voice-short"},
        ),
        session_key=SESSION_KEY,
    )
    print("回复:", (resp.content if resp else None)[:60] if resp else None)
    print("outbound voice:", json.dumps((resp.metadata.get("voice") if resp else {}) or {}, ensure_ascii=False)[:120])
    # 等待合成完成（后台 task）
    await asyncio.sleep(8)
    files = sorted(VOICE_DIR.glob("*.mp3"))
    print("voice files:", [f.name for f in files])

    # 2) 历史挂载检查
    try:
        saved = loop.sessions.read_session_file(SESSION_KEY)
        last = saved[-1]
        print("session last msg voice:", json.dumps(last.get("voice") or {}, ensure_ascii=False)[:200])
        print("session last msg usage:", json.dumps(last.get("usage") or {}, ensure_ascii=False)[:200])
        print("round_usages count:", len(last.get("round_usages") or []))
        print("request_count:", (last.get("usage") or {}).get("request_count"))
    except Exception as exc:
        print("session read failed:", exc)

    # 3) 长文消息（预期模型回复较长 → 后台摘要路径）
    print("\n=== 测试 2：长文（后台摘要） ===")
    resp2 = await loop._process_message(
        InboundMessage(
            channel="websocket", sender_id="user", chat_id="desktop",
            content="请详细介绍一下 2026 年值得关注的科技趋势，包括 AI、芯片、新能源、机器人等至少五个方向，每个方向展开说三点，总共写一千字左右。",
            metadata={"webui_turn_id": "it-voice-long"},
        ),
        session_key=SESSION_KEY,
    )
    print("回复长度:", len(resp2.content or "") if resp2 else 0)
    await asyncio.sleep(15)  # 等摘要 + 合成
    files2 = sorted(VOICE_DIR.glob("*.mp3"))
    print("voice files after long:", [f.name for f in files2])
    try:
        saved2 = loop.sessions.read_session_file(SESSION_KEY)
        last2 = saved2[-1]
        print("long session last voice:", json.dumps(last2.get("voice") or {}, ensure_ascii=False)[:160])
        print("long round_usages:", len(last2.get("round_usages") or []))
    except Exception as exc:
        print("long session read failed:", exc)

    loop.stop()


if __name__ == "__main__":
    asyncio.run(main())
