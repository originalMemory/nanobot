from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

merger = importlib.import_module("merge_curriculum")


def page(number: int, lesson: int | None, kind: str, sections: list[str]) -> dict:
    return {
        "source": {"pdf_page": number, "printed_page": number - 10},
        "lesson": lesson,
        "page_kind": kind,
        "section_titles": sections,
        "grammar_points": [],
        "communication_functions": [],
        "pragmatics": [],
        "vocabulary_domains": [],
        "exercise_types": [],
    }


class MergeCurriculumTest(unittest.TestCase):
    def test_beginner_uses_basic_text_anchor(self) -> None:
        pages = [
            page(10, 1, "exercise", ["答案引用"]),
            page(20, 1, "basic-text", ["基本课文"]),
            page(30, 2, "basic-text", ["基本课文"]),
        ]
        self.assertEqual(merger.lesson_starts(pages, range(1, 3), "basic"), {1: 20, 2: 30})

    def test_intermediate_uses_conversation_anchor(self) -> None:
        pages = [
            page(10, 1, "expression", ["第1课相关表达"]),
            page(20, 1, "contents", ["会話", "1 出会い"]),
            page(40, 2, "contents", ["会話", "2 あいさつ"]),
        ]
        self.assertEqual(
            merger.lesson_starts(pages, range(1, 3), "conversation"),
            {1: 20, 2: 40},
        )

    def test_grammar_merges_duplicate_patterns(self) -> None:
        pages = [
            {
                "grammar_points": [
                    {
                        "pattern": "～とは",
                        "function_cn": "定义",
                        "formation": "名词＋とは",
                        "constraints": ["书面语"],
                        "contrasts": [],
                    }
                ]
            },
            {
                "grammar_points": [
                    {
                        "pattern": "～とは",
                        "function_cn": "定义",
                        "formation": "名词＋とは",
                        "constraints": ["用于说明"],
                        "contrasts": ["～というのは"],
                    }
                ]
            },
        ]
        merged = merger.merge_grammar(pages)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["constraints"], ["书面语", "用于说明"])

    def test_node_excludes_exercise_grammar(self) -> None:
        pages = [
            {
                **page(10, 1, "grammar", ["解説"]),
                "grammar_points": [{"pattern": "～とは"}],
                "communication_functions": [],
                "pragmatics": [],
                "vocabulary_domains": [],
                "exercise_types": [],
                "uncertain": [],
            },
            {
                **page(11, 1, "exercise", ["練習"]),
                "grammar_points": [{"pattern": "练习干扰项"}],
                "communication_functions": ["练习干扰项"],
                "pragmatics": [],
                "vocabulary_domains": [],
                "exercise_types": [],
                "uncertain": [],
            },
        ]
        node = merger.node_for("beginner", "beginner-up", 1, pages, "candidate")
        self.assertEqual([item["pattern"] for item in node["grammar"]], ["～とは"])
        self.assertEqual(node["communication_functions"], [])

    def test_first_lessons_use_bridge_prerequisites(self) -> None:
        pages = [{
            **page(10, 1, "grammar", ["解説"]),
            "grammar_points": [], "communication_functions": [], "pragmatics": [],
            "vocabulary_domains": [], "exercise_types": [], "uncertain": [],
        }]
        beginner = merger.node_for("beginner", "beginner-up", 1, pages, "candidate")
        intermediate = merger.node_for("intermediate", "intermediate-up", 1, pages, "candidate")
        self.assertEqual(beginner["prerequisites"], ["foundation-basic-sentence"])
        self.assertEqual(intermediate["prerequisites"], ["bridge-n4-n3"])
