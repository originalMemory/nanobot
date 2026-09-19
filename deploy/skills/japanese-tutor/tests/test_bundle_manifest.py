from __future__ import annotations

import importlib
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
bundle = importlib.import_module("bundle_manifest")


class BundleManifestTest(unittest.TestCase):
    def test_create_verify_and_detect_change(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tracked = root / "SKILL.md"
            tracked.write_text("skill", encoding="utf-8")
            manifest = root / bundle.MANIFEST
            data = bundle.create(root, manifest)
            self.assertEqual(bundle.verify(root, manifest), data)
            tracked.write_text("changed", encoding="utf-8")
            with self.assertRaises(ValueError):
                bundle.verify(root, manifest)

    def test_rejects_anki_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "private.apkg").write_bytes(b"payload")
            with self.assertRaises(ValueError):
                bundle.create(root, root / bundle.MANIFEST)
