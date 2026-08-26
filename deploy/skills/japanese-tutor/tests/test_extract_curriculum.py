from __future__ import annotations

import importlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

extractor = importlib.import_module("extract_curriculum")


class ExtractCurriculumTest(unittest.TestCase):
    def test_infer_all_six_book_ids(self) -> None:
        cases = {
            Path("初级/标日上.pdf"): "beginner-up",
            Path("初级/新标日PDF初级下清晰版.pdf"): "beginner-down",
            Path("中级/新版中日交流标准日本语中级上电子书.pdf"): "intermediate-up",
            Path("中级/新版中日交流标准日本语中级下电子书.pdf"): "intermediate-down",
            Path("高级/新版中日交流标准日本语高级-上.pdf"): "advanced-up",
            Path("高级/新版中日交流标准日本语高级-下.pdf"): "advanced-down",
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(extractor.infer_book(path)[0], expected)

    def test_manifest_preserves_completed_pages_until_extractor_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "pdfs"
            work = Path(temp_dir) / "work"
            paths = (
                root / "初级" / "标日上.pdf",
                root / "初级" / "标日下.pdf",
                root / "中级" / "标日中级上.pdf",
                root / "中级" / "标日中级下.pdf",
                root / "高级" / "标日高级上.pdf",
                root / "高级" / "标日高级下.pdf",
            )
            for path in paths:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(path.name.encode())
            fingerprint = {"model": "qwen", "prompt_sha256": "p1", "schema_sha256": "s1"}
            with (
                patch.object(extractor, "pdf_page_count", return_value=2),
                patch.object(extractor, "detect_text_layer", return_value="absent"),
            ):
                manifest = extractor.scan_books(root, work, Path("pdfinfo"), fingerprint)
                manifest["books"][0]["page_states"]["1"]["status"] = "completed"
                extractor.atomic_write_json(work / "manifest.json", manifest)
                resumed = extractor.scan_books(root, work, Path("pdfinfo"), fingerprint)
                self.assertEqual(resumed["books"][0]["page_states"]["1"]["status"], "completed")

                changed = extractor.scan_books(
                    root,
                    work,
                    Path("pdfinfo"),
                    {**fingerprint, "prompt_sha256": "p2"},
                )
                self.assertEqual(changed["books"][0]["page_states"]["1"]["status"], "pending")

    def test_page_selection_supports_resume_failed_and_force(self) -> None:
        book = {
            "pages": 4,
            "page_states": {
                "1": {"status": "completed"},
                "2": {"status": "failed"},
                "3": {"status": "pending"},
                "4": {"status": "running"},
            },
        }
        self.assertEqual(extractor.select_pages(book, None, None, False, set()), [2, 3, 4])
        self.assertEqual(extractor.select_pages(book, None, None, True, set()), [2])
        self.assertEqual(extractor.select_pages(book, None, None, False, {1}), [1])

    def test_repeated_watermark_text_is_not_a_text_layer(self) -> None:
        watermark = "下载自日语学习资料站 " * 5
        self.assertEqual(extractor.classify_text_samples([watermark] * 5), "absent")
        self.assertEqual(
            extractor.classify_text_samples(["第一课的正文内容 " * 5, "第二页不同正文内容 " * 5]),
            "present",
        )

    def test_fixed_section_titles_override_model_page_kind(self) -> None:
        self.assertEqual(
            extractor.normalized_page_kind("contents", ["语法解释"]),
            "grammar",
        )
        self.assertEqual(
            extractor.normalized_page_kind("contents", ["解説", "课文特点"]),
            "grammar",
        )
        self.assertEqual(
            extractor.normalized_page_kind("exercise", ["表达及词语讲解"]),
            "expression",
        )
        self.assertEqual(
            extractor.normalized_page_kind("exercise", ["生词表 4", "语法与表达", "练习"]),
            "vocabulary",
        )

    def test_page_result_is_normalized_and_invalid_shape_rejected(self) -> None:
        data = {
            "page_kind": "grammar",
            "unit": 1,
            "lesson": 1,
            "continuation": False,
            "section_titles": ["语法解释"],
            "grammar_points": [
                {
                    "pattern": "名词は名词です",
                    "function_cn": "判断",
                    "formation": "名词＋は＋名词＋です",
                    "constraints": [],
                    "contrasts": [],
                }
            ],
            "communication_functions": [],
            "pragmatics": [],
            "vocabulary_domains": [],
            "exercise_types": [],
            "uncertain": [],
            "source": {"printed_page": 23},
        }
        result = extractor.validate_page_result(data, "beginner-up", 39)
        self.assertEqual(
            result["source"],
            {"book_id": "beginner-up", "pdf_page": 39, "printed_page": 23},
        )
        self.assertEqual(result["verification"], "candidate")

        with self.assertRaises(extractor.ExtractionError):
            extractor.validate_page_result({"page_kind": "grammar"}, "beginner-up", 39)

    def test_out_of_range_unit_is_cleared(self) -> None:
        data = {
            "page_kind": "exercise",
            "unit": 10,
            "lesson": 1,
            "continuation": False,
            "section_titles": ["基本练习"],
            "grammar_points": [],
            "communication_functions": [],
            "pragmatics": [],
            "vocabulary_domains": [],
            "exercise_types": [],
            "uncertain": [],
        }
        result = extractor.validate_page_result(data, "intermediate-up", 42)
        self.assertIsNone(result["unit"])
        self.assertIn("超出书册范围", result["uncertain"][-1])
