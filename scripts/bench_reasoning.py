"""对比 GLM vs DeepSeek 摘要任务：reasoning_effort=none vs 继承(null) 的耗时与输出。

用 voice_hook 的真实摘要指令 + 一段固定长文，模拟「长文回复 → 后台摘要」场景。
"""
import asyncio
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nanobot.agent.voice_hook import _SUMMARY_PROMPT  # noqa: E402
from nanobot.config.loader import load_config  # noqa: E402
from nanobot.providers.factory import make_provider  # noqa: E402
from nanobot.providers.openai_compat_provider import OpenAICompatProvider  # noqa: E402
from nanobot.providers.registry import find_by_name  # noqa: E402

CONFIG = Path(os.path.expanduser("~/.nanobot/config.json"))

# 固定长文（600+ 字，模拟 AI 助手写的工作报告）
LONG_TEXT = (
    "作为 AI 助手，我每天的工作其实相当规律。早晨起来先检查有没有积累的待办事项和定时任务，"
    "比如主人设定的提醒、需要跟进的文档、或者是前一天没完成的整理工作。然后开始处理消息："
    "来自各个渠道的提问、请求，大部分是文件整理、资料查询、代码修改这类具体任务。"
    "文件整理是重头戏，比如把下载目录里的图片按内容分类、把影视资源重命名成规范的格式、"
    "给音乐补全元数据，这些工作需要用脚本批量处理，还要核对结果是否准确。"
    "代码类的工作也不少，修 bug、加功能、跑测试，每次改完都要验证一下，避免引入新问题。"
    "下午通常是长任务的时间，比如整理日记、生成日报、归档会话，这些需要读取大量历史数据，"
    "还要保持事实准确，不能凭空编造。另外还要响应各种闲聊，保持陪伴感。"
    "到了晚上，心跳任务会检查当天的完成情况，如果有遗漏就补上。"
    "整体上我的一天被消息驱动，任务之间切换频繁，但核心原则不变：把事情做对、做完，"
    "重要的信息记得住，不确定的事情问清楚再做。这就是我每天的工作内容和感受。"
)

INSTRUCTION = _SUMMARY_PROMPT.format(limit=300)


async def bench(label: str, provider, model: str, reasoning) -> None:
    t0 = time.monotonic()
    try:
        resp = await asyncio.wait_for(
            provider.chat_with_retry(
                messages=[
                    {"role": "system", "content": INSTRUCTION},
                    {"role": "user", "content": LONG_TEXT},
                ],
                tools=None,
                model=model,
                temperature=0.1,
                max_tokens=2000,
                reasoning_effort=reasoning,
            ),
            timeout=60,
        )
        dt = time.monotonic() - t0
        content = resp.content or ""
        print(f"  {label}: 耗时 {dt:6.1f}s | 摘要 {len(content)} 字 | {content[:30]}…")
    except Exception as exc:
        dt = time.monotonic() - t0
        print(f"  {label}: 耗时 {dt:6.1f}s | 失败 {type(exc).__name__}: {str(exc)[:100]}")


async def main() -> None:
    cfg = load_config(CONFIG)

    # GLM：走 make_provider（与真实链路一致的 FallbackProvider）
    glm = make_provider(cfg)
    print("=== GLM (glm-5.3-flash) ===")
    await bench("GLM reasoning=none", glm, "glm-5.3-flash", "none")
    await bench("GLM reasoning=None", glm, "glm-5.3-flash", None)

    # DeepSeek：OpenAICompatProvider（api.deepseek.com）
    ds_cfg = cfg.providers.deepseek
    ds = OpenAICompatProvider(
        api_key=ds_cfg.api_key,
        api_base=None,  # 用 spec 默认 https://api.deepseek.com
        default_model="deepseek-v4-flash",
        spec=find_by_name("deepseek"),
        provider_name="deepseek",
    )
    print("\n=== DeepSeek (deepseek-v4-flash) ===")
    await bench("DS reasoning=none", ds, "deepseek-v4-flash", "none")
    await bench("DS reasoning=None", ds, "deepseek-v4-flash", None)


if __name__ == "__main__":
    asyncio.run(main())
