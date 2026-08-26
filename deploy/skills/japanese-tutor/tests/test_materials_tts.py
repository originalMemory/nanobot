from __future__ import annotations

import importlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

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
    async def test_generate_uses_global_tts_and_private_voice(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            private = root / "private.json"
            private.write_text(json.dumps({"japaneseVoiceId": "jp-voice"}), encoding="utf-8")
            output_bytes = b"audio"

            async def synthesize(_text: str, voice: str, output: Path) -> bool:
                self.assertEqual(voice, "jp-voice")
                output.parent.mkdir(parents=True)
                output.write_bytes(output_bytes)
                return True

            provider = unittest.mock.MagicMock()
            provider.synthesize = AsyncMock(side_effect=synthesize)
            config = unittest.mock.MagicMock()
            config.tools.tts.response_format = "wav"
            config.tools.tts.provider = "shared"
            config.tools.tts.model = "shared-model"
            with (
                patch.object(tts_media, "load_config", return_value=config),
                patch.object(tts_media, "build_tts_provider", return_value=provider) as build,
            ):
                result = await tts_media.generate("こんにちは", root, private, None)
            build.assert_called_once_with(config.tools.tts)
            self.assertEqual(result["voice"], "jp-voice")
            self.assertEqual(Path(result["path"]).read_bytes(), output_bytes)

    def test_cli_requires_confirmation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts" / "tts_media.py"),
                    "--text",
                    "こんにちは",
                    "--workspace",
                    temp_dir,
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("确认", result.stderr)

    def test_listening_question_does_not_require_card_confirmation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts" / "tts_media.py"),
                    "--text",
                    "こんにちは",
                    "--workspace",
                    temp_dir,
                    "--purpose",
                    "listening-question",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("确认", result.stderr)
            self.assertIn("japaneseVoiceId", result.stderr)
