#!/usr/bin/env python3
"""为已确认的日语句子卡生成完整媒体文件。"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import shutil
import sys
import uuid
import wave
from pathlib import Path

from nanobot.config.loader import load_config
from nanobot.providers.tts import MiniMaxTTSProvider


async def encode_mp3(source: Path, target: Path) -> None:
    # 技能可先部署到旧版 gateway，不依赖 lover-next 的 SpeechService。
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", str(source), "-codec:a", "libmp3lame", "-b:a", "64k",
        "-ar", "24000", "-ac", "1", "-f", "mp3", str(target),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    try:
        await asyncio.wait_for(process.communicate(), timeout=60)
        if process.returncode != 0 or not target.is_file() or not target.stat().st_size:
            raise RuntimeError("MP3 编码失败")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def generate(
    text: str, workspace: Path, nanobot_config: Path | None, language: str = "ja"
) -> dict:
    if language not in {"ja", "zh"}:
        raise ValueError("language 只能是 ja 或 zh")
    if not text.strip() or len(text) >= 10000:
        raise ValueError("日语文本须为 1–9999 字符")
    if not shutil.which("ffmpeg"):
        raise ValueError("MP3 编码需要安装 ffmpeg")
    config = load_config(nanobot_config)
    preset = config.tts_presets.get(config.tools.tts.preset or "")
    if preset is None or preset.config.provider != "minimax":
        raise ValueError("请配置活动 MiniMax TTS preset")
    selected = next((item for item in preset.voices if item.id == config.tools.tts.voice), None)
    if selected is None or not selected.language_voices.get("default"):
        raise ValueError("活动 TTS preset 未配置有效音色")
    base_voice = selected.language_voices.get("zh") or selected.language_voices["default"]
    japanese_voice = selected.language_voices.get("ja") or selected.language_voices["default"]
    voice = japanese_voice if language == "ja" else base_voice
    synthesis_text = text if re.search(r"\[(?:ja|zh)\]", text, re.IGNORECASE) else f"[{language}]{text}[/{language}]"
    tts = preset.config
    provider = MiniMaxTTSProvider(api_key=tts.api_key, api_base=tts.api_base, model=tts.model,
        japanese_voice=japanese_voice, speed=tts.speed, extra_body=tts.extra_body, rpm=tts.rpm)
    workspace = workspace.expanduser().resolve()
    digest = hashlib.sha256(synthesis_text.encode()).hexdigest()
    output = workspace / "tmp" / "japanese-tutor" / f"{digest}.mp3"
    if not output.resolve().is_relative_to(workspace):
        raise ValueError("音频目录越出 workspace")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(f".{uuid.uuid4().hex}.tmp")
    wav_path = temporary.with_suffix(".wav")
    try:
        with wave.open(str(wav_path), "wb") as wav:
            wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
            size = 0
            async def on_chunk(chunk):
                nonlocal size
                size += len(chunk.pcm)
                if size > 24 * 1024 * 1024:
                    raise ValueError("语音过长")
                wav.writeframesraw(chunk.pcm)
            result = await provider.synthesize_stream(synthesis_text, base_voice, on_chunk)
            if result is None:
                raise RuntimeError("TTS 合成失败")
        await encode_mp3(wav_path, temporary)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
        wav_path.unlink(missing_ok=True)
    return {
        "ok": True, "path": str(output), "mime": "audio/mpeg",
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "voice": voice,
        "generator": {"name": "tts_media", "version": 2, "provider": "minimax", "model": tts.model},
    }



def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--nanobot-config", type=Path)
    parser.add_argument("--language", choices=("ja", "zh"), default="ja")
    parser.add_argument("--purpose", choices=("card", "listening-question"), default="card")
    parser.add_argument("--confirmed", action="store_true")
    args = parser.parse_args()
    try:
        if args.purpose == "card" and not args.confirmed:
            raise ValueError("生成句子音频需要明确确认")
        print(
            json.dumps(
                asyncio.run(generate(args.text, args.workspace, args.nanobot_config, args.language)),
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
