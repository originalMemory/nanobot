from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ValidateDataTest(unittest.TestCase):
    def test_initial_static_data_is_valid(self) -> None:
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "validate_data.py")],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("静态数据校验通过", result.stdout)
