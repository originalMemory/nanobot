from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "curriculum_state.py"


class CurriculumStateTest(unittest.TestCase):
    def run_script(self, workspace: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args, "--workspace", str(workspace)],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_init_and_status(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            init = self.run_script(workspace, "init")
            self.assertEqual(init.returncode, 0, init.stderr)
            status = self.run_script(workspace, "status")
            self.assertEqual(status.returncode, 0, status.stderr)
            payload = json.loads(status.stdout)
            self.assertEqual(payload["known_lexical_units"], 0)
            self.assertEqual(len(payload["tracks"]), 6)

    def test_recover_requires_explicit_flag(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            path = workspace / "memory" / "japanese-learning-state.json"
            path.parent.mkdir()
            path.write_text("not json", encoding="utf-8")
            blocked = self.run_script(workspace, "init")
            self.assertNotEqual(blocked.returncode, 0)
            recovered = self.run_script(workspace, "init", "--recover")
            self.assertEqual(recovered.returncode, 0, recovered.stderr)
            self.assertEqual(len(list(path.parent.glob("japanese-learning-state.corrupt.*.json"))), 1)

    def test_import_legacy_ignores_mastered_claims(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            legacy = workspace / "legacy.md"
            legacy.write_text(
                "# 日语学习档案\n\n"
                "## 目标与节奏\n"
                "- 目标：JLPT N1\n"
                "- 学习节奏：每天 20 分钟\n"
                "- 偏好与素材：会话练习\n\n"
                "## 已掌握\n"
                "- [助词]：已掌握\n\n"
                "## 易错与待加强\n"
                "- [助词]：に 和 で 混淆\n",
                encoding="utf-8",
            )
            imported = self.run_script(workspace, "import-legacy", "--legacy-path", str(legacy))
            self.assertEqual(imported.returncode, 0, imported.stderr)
            state = json.loads(
                (workspace / "memory" / "japanese-learning-state.json").read_text(encoding="utf-8")
            )
            self.assertEqual(state["profile"]["goal"], "JLPT N1")
            self.assertEqual(state["nodes"], {})
            self.assertIn("[助词]：に 和 で 混淆", state["legacy_observations"])

    def test_diagnostic_tracks_are_independent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            plan = self.run_script(workspace, "diagnostic-plan")
            self.assertEqual(plan.returncode, 0, plan.stderr)
            self.assertEqual(len(json.loads(plan.stdout)["tasks"]), 5)
            recorded = self.run_script(
                workspace,
                "record-diagnostic",
                "--session-id",
                "session-1",
                "--placement",
                "reading=N3",
                "--placement",
                "listening=N5",
            )
            self.assertEqual(recorded.returncode, 0, recorded.stderr)
            tracks = json.loads(recorded.stdout)["tracks"]
            self.assertEqual(tracks["reading"]["level"], "N3")
            self.assertEqual(tracks["listening"]["level"], "N5")
