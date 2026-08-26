#!/usr/bin/env python3
"""为已确认的日语句子卡生成完整媒体文件。"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from pathlib import Path

from nanobot.config.loader import load_config
from nanobot.providers.tts import build_tts_provider

PLACEHOLDER_VOICE = "REPLACE_WITH_JAPANESE_VOICE_ID"


async def generate(
    text: str, workspace: Path, private_path: Path, nanobot_config: Path | None
) -> dict:
    private = json.loads(private_path.read_text(encoding="utf-8"))
    voice = private.get("japaneseVoiceId", PLACEHOLDER_VOICE)
    if voice == PLACEHOLDER_VOICE:
        raise ValueError("请在私密配置中设置 japaneseVoiceId")
    tts = load_config(nanobot_config).tools.tts
    digest = hashlib.sha256(text.encode()).hexdigest()
    output = workspace / "tmp" / "japanese-tutor" / f"{digest}.{tts.response_format}"
    if not await build_tts_provider(tts).synthesize(text, voice, output):
        raise RuntimeError("TTS 合成失败")
    return {
        "ok": True,
        "path": str(output),
        "mime": f"audio/{tts.response_format}",
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "voice": voice,
        "generator": {
            "name": "tts_media",
            "version": 1,
            "provider": tts.provider,
            "model": tts.model,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument(
        "--config",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "japanese-tutor.private.json",
    )
    parser.add_argument("--nanobot-config", type=Path)
    parser.add_argument("--purpose", choices=("card", "listening-question"), default="card")
    parser.add_argument("--confirmed", action="store_true")
    args = parser.parse_args()
    try:
        if args.purpose == "card" and not args.confirmed:
            raise ValueError("生成句子音频需要明确确认")
        print(
            json.dumps(
                asyncio.run(generate(args.text, args.workspace, args.config, args.nanobot_config)),
                ensure_ascii=False,
            )
        )
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(
            json.dumps(
                {"ok": False, "error": str(exc), "listening_card": False}, ensure_ascii=False
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
