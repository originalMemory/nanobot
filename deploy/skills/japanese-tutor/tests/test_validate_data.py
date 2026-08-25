from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ValidateDataTest(unittest.TestCase):
    def run_validator(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "validate_data.py"), *args],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_incomplete_curriculum_requires_explicit_flag(self) -> None:
        result = self.run_validator()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("curriculum nodes 必须恰好 104 个，当前 0 个", result.stderr)

        scaffold = self.run_validator("--allow-incomplete")
        self.assertEqual(scaffold.returncode, 0, scaffold.stderr)
        self.assertIn("静态数据结构校验通过（课程节点未完成）", scaffold.stdout)

    def test_skill_routes_structured_state(self) -> None:
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("scripts/curriculum_state.py", skill)
        self.assertIn("japanese-learning-state.json", skill)
        self.assertIn("import-legacy", skill)
