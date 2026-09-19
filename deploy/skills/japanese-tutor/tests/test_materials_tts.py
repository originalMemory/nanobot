from __future__ import annotations

import importlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from nanobot.config.schema import Config

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

materials = importlib.import_module("materials")
tts_media = importlib.import_module("tts_media")
candidate_fields = importlib.import_module("anki_adapter").candidate_fields


class MaterialsTest(unittest.TestCase):
    def test_preview_candidate_matches_adapter_contract(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "materials.py"),
                "preview",
                "--node-id",
                "textbook-beginner-01",
                "--text",
                "私は学生です。",
                "--reading",
                "わたしはがくせいです。",
                "--meaning",
                "我是学生。",
                "--source-ref",
                "standard-japanese-publisher",
                "--known",
                '["私","は","学生","です"]',
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        candidate = json.loads(result.stdout)["candidates"][0]
        candidate_id, _ = candidate_fields(candidate)
        self.assertEqual(candidate["CandidateId"], candidate_id)
        self.assertTrue(
            all(
                "known_reason" in item
                for item in candidate["Generator"]["coverage"]["lexical_units"]
            )
        )

    def test_known_requires_json_array(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "materials.py"),
                "analyze",
                "--node-id",
                "n",
                "--text",
                "日本語",
                "--known",
                '"日本語"',
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 1)


class TtsMediaTest(unittest.IsolatedAsyncioTestCase):
    async def test_global_voice_and_language_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = Config(tools={"tts": {"preset": "minimax", "voice": "selected"}}, ttsPresets={"minimax": {
                "label": "MiniMax", "config": {"apiKey": "test", "model": "shared-model"},
                "voices": [{"id": "selected", "label": "Selected", "languageVoices": {"default": "cn-voice", "ja": "jp-voice"}}]}})
            async def synthesize(text, voice, on_chunk):
                self.assertEqual(voice, "cn-voice")
                await on_chunk(SimpleNamespace(pcm=b"\x00\x00"))
                return SimpleNamespace(sample_rate=24000)
            async def encode(source, target):
                self.assertTrue(source.is_file())
                target.write_bytes(b"audio")
            provider = unittest.mock.MagicMock()
            provider.synthesize_stream = AsyncMock(side_effect=synthesize)
            cases = [("こんにちは", "ja", "[ja]こんにちは[/ja]", "jp-voice"),
                     ("你好", "zh", "[zh]你好[/zh]", "cn-voice"),
                     ("[zh]你好[/zh][ja]こんにちは[/ja]", "ja", "[zh]你好[/zh][ja]こんにちは[/ja]", "jp-voice")]
            with (
                patch.object(tts_media, "load_config", return_value=config),
                patch.object(tts_media.shutil, "which", return_value="ffmpeg"),
                patch.object(tts_media, "MiniMaxTTSProvider", return_value=provider) as build,
                patch.object(tts_media, "encode_mp3", side_effect=encode),
            ):
                for text, language, expected, voice in cases:
                    with self.subTest(language=language, text=text):
                        result = await tts_media.generate(text, root, None, language)
                        self.assertEqual(provider.synthesize_stream.call_args.args[0], expected)
                        self.assertEqual(build.call_args.kwargs["japanese_voice"], "jp-voice")
                        self.assertEqual(result["voice"], voice)
                        self.assertEqual(result["mime"], "audio/mpeg")
                        self.assertEqual(Path(result["path"]).read_bytes(), b"audio")
                config.tts_presets["minimax"].voices[0].language_voices["ja"] = "new-jp-voice"
                result = await tts_media.generate("こんにちは", root, None)
                self.assertEqual(result["voice"], "new-jp-voice")
                self.assertEqual(build.call_args.kwargs["japanese_voice"], "new-jp-voice")

    def test_cli_preserves_language_and_confirmation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "config.json"
            config.write_text("{}", encoding="utf-8")
            command = [sys.executable, str(ROOT / "scripts" / "tts_media.py"), "--text", "こんにちは",
                       "--workspace", temp_dir, "--nanobot-config", str(config), "--language", "ja"]
            denied = subprocess.run(command, text=True, encoding="utf-8", capture_output=True)
            self.assertEqual(denied.returncode, 1)
            self.assertIn("确认", denied.stderr)
            for extra in (["--confirmed"], ["--purpose", "listening-question"]):
                result = subprocess.run(command + extra, text=True, encoding="utf-8", capture_output=True)
                self.assertEqual(result.returncode, 1)  # 空配置拒绝合成，测试不调用真实服务。
                self.assertNotIn("unrecognized arguments", result.stderr)
                self.assertNotIn("确认", result.stderr)
                self.assertNotIn("japaneseVoiceId", result.stderr)
