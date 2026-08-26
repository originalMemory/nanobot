from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "curriculum_state.py"
CURRICULUM = ROOT / "data" / "curriculum-n1.yaml"


class CurriculumStateTest(unittest.TestCase):
    def run_script(self, workspace: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args, "--workspace", str(workspace)],
            text=True,
            capture_output=True,
            check=False,
        )

    def write_curriculum(self, workspace: Path, nodes: list[dict]) -> Path:
        path = workspace / "curriculum.yaml"
        path.write_text(json.dumps({"nodes": nodes, "bridge_nodes": []}), encoding="utf-8")
        return path

    def root_node(self, node_id: str, skill: str) -> dict:
        return {
            "id": node_id,
            "verification": "verified",
            "prerequisites": [],
            "skills": [skill],
            "target_level": "N3",
            "themes": [node_id],
        }

    def read_state(self, workspace: Path) -> tuple[Path, dict]:
        path = workspace / "memory" / "japanese-learning-state.json"
        return path, json.loads(path.read_text(encoding="utf-8"))

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
            self.assertEqual(
                len(list(path.parent.glob("japanese-learning-state.corrupt.*.json"))), 1
            )

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

    def test_update_summary_preserves_manual_content(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            summary = workspace / "memory" / "japanese-learning.md"
            summary.write_text("# 日语学习档案\n\n## 我的备注\n保留这段。\n", encoding="utf-8")
            first = self.run_script(workspace, "update-summary")
            second = self.run_script(workspace, "update-summary")
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            content = summary.read_text(encoding="utf-8")
            self.assertIn("保留这段", content)
            self.assertEqual(content.count("japanese-tutor:summary:start"), 1)

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

    def test_plan_degrades_when_anki_is_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            result = self.run_script(workspace, "plan", "--curriculum", str(CURRICULUM))
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual(plan["reason"], "anki_unavailable")
            self.assertEqual(plan["next_node"]["id"], "foundation-kana")

    def test_plan_uses_bridge_then_textbook_order(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            path = workspace / "memory" / "japanese-learning-state.json"
            state = json.loads(path.read_text(encoding="utf-8"))
            state["nodes"]["foundation-kana"] = {"status": "mastered"}
            path.write_text(json.dumps(state), encoding="utf-8")
            second = self.run_script(workspace, "plan", "--curriculum", str(CURRICULUM))
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(
                json.loads(second.stdout)["next_node"]["id"], "foundation-basic-sentence"
            )
            state["nodes"]["foundation-basic-sentence"] = {"status": "mastered"}
            path.write_text(json.dumps(state), encoding="utf-8")
            third = self.run_script(workspace, "plan", "--curriculum", str(CURRICULUM))
            self.assertEqual(third.returncode, 0, third.stderr)
            self.assertEqual(json.loads(third.stdout)["next_node"]["id"], "textbook-beginner-01")

            for lesson in range(1, 49):
                state["nodes"][f"textbook-beginner-{lesson:02d}"] = {"status": "mastered"}
            path.write_text(json.dumps(state), encoding="utf-8")
            bridge = self.run_script(workspace, "plan", "--curriculum", str(CURRICULUM))
            self.assertEqual(bridge.returncode, 0, bridge.stderr)
            next_node = json.loads(bridge.stdout)["next_node"]
            self.assertEqual(next_node["id"], "bridge-n4-n3")
            self.assertEqual(next_node["target_level"], "N3")

    def test_plan_surfaces_matching_anki_weakness(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            anki = workspace / "anki-status.json"
            anki.write_text(
                json.dumps(
                    {
                        "available": True,
                        "weaknesses": [{"node_id": "foundation-kana", "lapses": 3}],
                    }
                ),
                encoding="utf-8",
            )
            result = self.run_script(
                workspace,
                "plan",
                "--curriculum",
                str(CURRICULUM),
                "--anki-status",
                str(anki),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual(plan["reason"], "next_teachable_node")
            self.assertEqual(plan["anki_weaknesses"], [{"node_id": "foundation-kana", "lapses": 3}])

    def test_plan_ranks_anki_weakness_question_gap_and_learning_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            curriculum = self.write_curriculum(
                workspace,
                [
                    self.root_node("grammar-node", "grammar"),
                    self.root_node("reading-node", "reading"),
                ],
            )
            path, state = self.read_state(workspace)
            for track in state["tracks"].values():
                track["level"] = "N3"
            path.write_text(json.dumps(state), encoding="utf-8")

            by_gap = self.run_script(
                workspace,
                "plan",
                "--curriculum",
                str(curriculum),
                "--question-gap",
                "reading:long",
            )
            self.assertEqual(by_gap.returncode, 0, by_gap.stderr)
            self.assertEqual(json.loads(by_gap.stdout)["next_node"]["id"], "reading-node")

            anki = workspace / "anki.json"
            anki.write_text(
                json.dumps(
                    {
                        "available": True,
                        "weaknesses": [{"node_id": "reading-node", "lapses": 2}],
                    }
                ),
                encoding="utf-8",
            )
            by_anki = self.run_script(
                workspace,
                "plan",
                "--curriculum",
                str(curriculum),
                "--anki-status",
                str(anki),
            )
            self.assertEqual(by_anki.returncode, 0, by_anki.stderr)
            self.assertEqual(json.loads(by_anki.stdout)["next_node"]["id"], "reading-node")

            state["nodes"]["reading-node"] = {"status": "reviewing"}
            path.write_text(json.dumps(state), encoding="utf-8")
            by_state = self.run_script(workspace, "plan", "--curriculum", str(curriculum))
            self.assertEqual(by_state.returncode, 0, by_state.stderr)
            self.assertEqual(json.loads(by_state.stdout)["next_node"]["id"], "reading-node")

    def test_plan_uses_uneven_track_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            curriculum = self.write_curriculum(
                workspace,
                [
                    self.root_node("reading-node", "reading"),
                    self.root_node("listening-node", "listening"),
                ],
            )
            path, state = self.read_state(workspace)
            state["tracks"]["reading"]["level"] = "N3"
            state["tracks"]["listening"]["level"] = "N5"
            path.write_text(json.dumps(state), encoding="utf-8")
            result = self.run_script(workspace, "plan", "--curriculum", str(curriculum))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["next_node"]["id"], "listening-node")

    def test_standard_session_uses_only_actual_due_cards(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            anki = workspace / "anki-status.json"
            anki.write_text(
                json.dumps(
                    {
                        "available": True,
                        "weaknesses": [],
                        "due_cards": [{"card_id": 1}, {"card_id": 2}],
                    }
                ),
                encoding="utf-8",
            )
            result = self.run_script(
                workspace,
                "session-plan",
                "--curriculum",
                str(CURRICULUM),
                "--anki-status",
                str(anki),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual(plan["mode"], "standard")
            self.assertEqual(plan["budget_minutes"], 20)
            self.assertEqual(plan["review_cards"], [{"card_id": 1}, {"card_id": 2}])
            self.assertEqual(plan["new_target"]["id"], "foundation-kana")

    def test_standard_session_accepts_zero_to_two_due_cards(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            for count in range(3):
                with self.subTest(count=count):
                    anki = workspace / f"anki-{count}.json"
                    cards = [{"card_id": card_id} for card_id in range(count)]
                    anki.write_text(
                        json.dumps({"available": True, "weaknesses": [], "due_cards": cards}),
                        encoding="utf-8",
                    )
                    result = self.run_script(
                        workspace,
                        "session-plan",
                        "--curriculum",
                        str(CURRICULUM),
                        "--anki-status",
                        str(anki),
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout)["review_cards"], cards)

    def test_fatigue_falls_back_to_micro_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            anki = workspace / "anki.json"
            anki.write_text(
                json.dumps(
                    {
                        "available": True,
                        "weaknesses": [],
                        "due_cards": [{"card_id": 1}, {"card_id": 2}],
                    }
                ),
                encoding="utf-8",
            )
            result = self.run_script(
                workspace,
                "session-plan",
                "--session",
                "standard",
                "--fatigued",
                "--curriculum",
                str(CURRICULUM),
                "--anki-status",
                str(anki),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual(plan["requested_mode"], "standard")
            self.assertEqual(plan["mode"], "micro")
            self.assertEqual(plan["reason"], "fatigue_fallback")
            self.assertEqual(plan["review_cards"], [{"card_id": 1}])
            self.assertIsNone(plan["new_target"])

    def test_missing_prerequisite_uses_bridge_and_returns(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            bridge = self.root_node("bridge", "grammar")
            target = self.root_node("target", "reading")
            target["prerequisites"] = ["bridge"]
            curriculum = self.write_curriculum(workspace, [bridge, target])

            first = self.run_script(workspace, "plan", "--curriculum", str(curriculum))
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(json.loads(first.stdout)["next_node"]["id"], "bridge")
            path, state = self.read_state(workspace)
            state["nodes"]["bridge"] = {"status": "mastered"}
            path.write_text(json.dumps(state), encoding="utf-8")
            returned = self.run_script(workspace, "plan", "--curriculum", str(curriculum))
            self.assertEqual(returned.returncode, 0, returned.stderr)
            self.assertEqual(json.loads(returned.stdout)["next_node"]["id"], "target")

    def test_plan_reports_no_teachable_node(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            candidate = self.root_node("candidate", "grammar")
            candidate["verification"] = "candidate"
            curriculum = self.write_curriculum(workspace, [candidate])
            result = self.run_script(workspace, "plan", "--curriculum", str(curriculum))
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual(plan["reason"], "no_teachable_node")
            self.assertIsNone(plan["next_node"])

    def test_micro_session_does_not_introduce_new_target(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            result = self.run_script(
                workspace, "session-plan", "--session", "micro", "--curriculum", str(CURRICULUM)
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual(plan["budget_minutes"], 5)
            self.assertIsNone(plan["new_target"])

    def test_deep_session_adds_extended_input(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            result = self.run_script(
                workspace, "session-plan", "--session", "deep", "--curriculum", str(CURRICULUM)
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual(plan["budget_minutes"], 30)
            self.assertIn("extended_input", [step["kind"] for step in plan["steps"]])

    def test_mastery_requires_two_sessions_and_downgrades(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            common = (
                "record-evidence",
                "--curriculum",
                str(CURRICULUM),
                "--node-id",
                "foundation-kana",
            )
            for kind in ("recognition", "production"):
                result = self.run_script(
                    workspace,
                    *common,
                    "--session-id",
                    "session-1",
                    "--evidence-kind",
                    kind,
                    "--outcome",
                    "correct",
                )
                self.assertEqual(result.returncode, 0, result.stderr)
            first = json.loads(result.stdout)
            self.assertEqual(first["status"], "reviewing")
            for kind in ("recognition", "production"):
                result = self.run_script(
                    workspace,
                    *common,
                    "--session-id",
                    "session-2",
                    "--evidence-kind",
                    kind,
                    "--outcome",
                    "correct",
                )
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["status"], "mastered")
            downgraded = self.run_script(
                workspace,
                *common,
                "--session-id",
                "session-3",
                "--evidence-kind",
                "recognition",
                "--outcome",
                "incorrect",
            )
            self.assertEqual(downgraded.returncode, 0, downgraded.stderr)
            self.assertEqual(json.loads(downgraded.stdout)["status"], "reviewing")

            still_reviewing = self.run_script(
                workspace,
                *common,
                "--session-id",
                "session-4",
                "--evidence-kind",
                "recognition",
                "--outcome",
                "correct",
            )
            self.assertEqual(still_reviewing.returncode, 0, still_reviewing.stderr)
            self.assertEqual(json.loads(still_reviewing.stdout)["status"], "reviewing")

    def test_original_context_and_correction_do_not_create_mastery(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            common = (
                "record-evidence",
                "--curriculum",
                str(CURRICULUM),
                "--node-id",
                "foundation-kana",
                "--evidence-context",
                "original",
            )
            for session in ("one", "two"):
                for kind in ("recognition", "production"):
                    result = self.run_script(
                        workspace,
                        *common,
                        "--session-id",
                        session,
                        "--evidence-kind",
                        kind,
                        "--outcome",
                        "correct",
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotEqual(json.loads(result.stdout)["status"], "mastered")
            wrong = self.run_script(
                workspace,
                *common,
                "--session-id",
                "three",
                "--evidence-kind",
                "production",
                "--outcome",
                "incorrect",
                "--correction",
                "助词应使用に",
                "--used-hint",
            )
            evidence = json.loads(wrong.stdout)["evidence"][-1]
            self.assertEqual(evidence["correction"], "助词应使用に")
            self.assertTrue(evidence["used_hint"])

    def test_restart_preserves_current_node_correction_and_recommendation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            recorded = self.run_script(
                workspace,
                "record-evidence",
                "--curriculum",
                str(CURRICULUM),
                "--node-id",
                "foundation-kana",
                "--session-id",
                "restart-session",
                "--evidence-kind",
                "production",
                "--outcome",
                "incorrect",
                "--correction",
                "促音需要停顿",
            )
            self.assertEqual(recorded.returncode, 0, recorded.stderr)
            planned = self.run_script(workspace, "plan", "--curriculum", str(CURRICULUM))
            self.assertEqual(planned.returncode, 0, planned.stderr)

            restarted = self.run_script(workspace, "status")
            self.assertEqual(restarted.returncode, 0, restarted.stderr)
            status = json.loads(restarted.stdout)
            self.assertEqual(status["current_node"], "foundation-kana")
            self.assertEqual(status["next_recommendation"], "foundation-kana")
            self.assertIn("促音需要停顿", status["recent_corrections"])
            self.assertEqual(status["active_nodes"]["foundation-kana"], "learning")

    def test_concurrent_writers_preserve_both_updates(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            processes = [
                subprocess.Popen(
                    [
                        sys.executable,
                        str(SCRIPT),
                        "record-evidence",
                        "--workspace",
                        str(workspace),
                        "--curriculum",
                        str(CURRICULUM),
                        "--node-id",
                        node_id,
                        "--session-id",
                        f"session-{index}",
                        "--evidence-kind",
                        "recognition",
                        "--outcome",
                        "correct",
                    ],
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                for index, node_id in enumerate(
                    ("foundation-kana", "foundation-basic-sentence"), start=1
                )
            ]
            for process in processes:
                _, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, stderr)
            _, state = self.read_state(workspace)
            self.assertEqual(set(state["nodes"]), {"foundation-kana", "foundation-basic-sentence"})

    def test_stage_gate_checks_nodes_tracks_and_question_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            self.assertEqual(self.run_script(workspace, "init").returncode, 0)
            blocked = self.run_script(
                workspace,
                "stage-gate",
                "--stage",
                "beginner",
                "--curriculum",
                str(CURRICULUM),
            )
            self.assertEqual(blocked.returncode, 0, blocked.stderr)
            self.assertFalse(json.loads(blocked.stdout)["passed"])

            path, state = self.read_state(workspace)
            for lesson in range(1, 49):
                state["nodes"][f"textbook-beginner-{lesson:02d}"] = {"status": "mastered"}
            for track in state["tracks"].values():
                track["level"] = "N4"
            path.write_text(json.dumps(state), encoding="utf-8")
            passed = self.run_script(
                workspace,
                "stage-gate",
                "--stage",
                "beginner",
                "--curriculum",
                str(CURRICULUM),
            )
            self.assertEqual(passed.returncode, 0, passed.stderr)
            self.assertTrue(json.loads(passed.stdout)["passed"])

            gap = self.run_script(
                workspace,
                "stage-gate",
                "--stage",
                "beginner",
                "--question-gap",
                "reading:short",
                "--curriculum",
                str(CURRICULUM),
            )
            self.assertEqual(gap.returncode, 0, gap.stderr)
            self.assertFalse(json.loads(gap.stdout)["passed"])
