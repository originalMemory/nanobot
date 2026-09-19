from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


class ValidateDataTest(unittest.TestCase):
    def run_validator(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "validate_data.py"), *args],
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )

    def test_incomplete_curriculum_requires_explicit_flag(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            curriculum = yaml.safe_load((ROOT / "data" / "curriculum-n1.yaml").read_text(encoding="utf-8"))
            curriculum["nodes"] = []
            (data_dir / "curriculum-n1.yaml").write_text(
                yaml.safe_dump(curriculum, allow_unicode=True, sort_keys=False), encoding="utf-8"
            )
            (data_dir / "source-registry.yaml").write_text(
                (ROOT / "data" / "source-registry.yaml").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            result = self.run_validator("--data-dir", str(data_dir))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("curriculum nodes 必须恰好 104 个，当前 0 个", result.stderr)

            scaffold = self.run_validator("--data-dir", str(data_dir), "--allow-incomplete")
            self.assertEqual(scaffold.returncode, 0, scaffold.stderr)
            self.assertIn("静态数据结构校验通过（课程节点未完成）", scaffold.stdout)

    def test_generated_curriculum_is_valid(self) -> None:
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("静态数据校验通过", result.stdout)

    def test_bridge_requires_known_source(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            curriculum = yaml.safe_load((ROOT / "data" / "curriculum-n1.yaml").read_text(encoding="utf-8"))
            curriculum["bridge_nodes"][0]["sources"] = [{"id": "missing"}]
            (data_dir / "curriculum-n1.yaml").write_text(
                yaml.safe_dump(curriculum, allow_unicode=True, sort_keys=False), encoding="utf-8"
            )
            (data_dir / "source-registry.yaml").write_text(
                (ROOT / "data" / "source-registry.yaml").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            result = self.run_validator("--data-dir", str(data_dir))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("bridge source 引用无效", result.stderr)

    def test_bridge_rejects_unknown_skill(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            curriculum = yaml.safe_load((ROOT / "data" / "curriculum-n1.yaml").read_text(encoding="utf-8"))
            curriculum["bridge_nodes"][-1]["skills"][-1] = "exam_strategy"
            (data_dir / "curriculum-n1.yaml").write_text(
                yaml.safe_dump(curriculum, allow_unicode=True, sort_keys=False), encoding="utf-8"
            )
            (data_dir / "source-registry.yaml").write_text(
                (ROOT / "data" / "source-registry.yaml").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            result = self.run_validator("--data-dir", str(data_dir))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("bridge skills 无效", result.stderr)

    def test_jlpt_coverage_requires_four_tracks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            curriculum = yaml.safe_load((ROOT / "data" / "curriculum-n1.yaml").read_text(encoding="utf-8"))
            curriculum["jlpt_coverage"]["item_types"] = {}
            (data_dir / "curriculum-n1.yaml").write_text(
                yaml.safe_dump(curriculum, allow_unicode=True, sort_keys=False), encoding="utf-8"
            )
            (data_dir / "source-registry.yaml").write_text(
                (ROOT / "data" / "source-registry.yaml").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            result = self.run_validator("--data-dir", str(data_dir))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("jlpt_coverage item_types 无效", result.stderr)

    def test_skill_routes_structured_state(self) -> None:
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("scripts/curriculum_state.py", skill)
        self.assertIn("japanese-learning-state.json", skill)
        self.assertIn("import-legacy", skill)
        self.assertIn("references/proactive-learning.md", skill)
        self.assertIn("references/deployment.md", skill)
