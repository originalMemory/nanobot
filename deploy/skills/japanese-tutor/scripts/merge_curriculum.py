#!/usr/bin/env python3
"""把本地页级候选确定性合并为 104 个课程节点。"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import tempfile
from pathlib import Path
from typing import Any

import yaml

BOOKS = (
    ("beginner-up", "beginner", range(1, 25), "basic"),
    ("beginner-down", "beginner", range(25, 49), "basic"),
    ("intermediate-up", "intermediate", range(1, 17), "conversation"),
    ("intermediate-down", "intermediate", range(17, 33), "conversation"),
    ("advanced-up", "advanced", range(1, 13), "ordered"),
    ("advanced-down", "advanced", range(13, 25), "ordered"),
)
GENERIC_TITLES = {
    "基本课文", "基本課文", "语法解释", "語法解釈", "表达及词语讲解", "表現と語彙",
    "应用课文", "応用課文", "练习", "練習", "生词表", "生詞表", "会話", "解説",
}
TEACHING_PAGE_KINDS = {"basic-text", "grammar", "expression", "applied-text", "contents"}
BRIDGE_NODES = [
    {
        "id": "foundation-kana",
        "title": "假名、长音、促音与拗音",
        "skills": ["vocabulary_kanji", "listening"],
        "prerequisites": [],
        "sources": [{"id": "irodori"}],
        "verification": "cross_checked",
    },
    {
        "id": "foundation-basic-sentence",
        "title": "日语基本句、助词与礼貌体",
        "skills": ["grammar", "spoken_output"],
        "prerequisites": ["foundation-kana"],
        "sources": [{"id": "irodori"}],
        "verification": "cross_checked",
    },
    {
        "id": "bridge-n4-n3",
        "title": "从基础课堂日语到日常连贯表达",
        "skills": ["grammar", "reading", "listening", "spoken_output"],
        "prerequisites": ["textbook-beginner-48"],
        "sources": [{"id": "jlpt-official"}],
        "verification": "cross_checked",
    },
    {
        "id": "bridge-n3-n2",
        "title": "从日常理解到复杂篇章与自然语速",
        "skills": ["grammar", "reading", "listening", "spoken_output", "exam_strategy"],
        "prerequisites": ["textbook-intermediate-32"],
        "sources": [{"id": "jlpt-official"}],
        "verification": "cross_checked",
    },
]
JLPT_COVERAGE = {
    "source": "jlpt-official",
    "status": "official-format-only",
    "level_alignment": {
        "beginner": ["N5", "N4"],
        "intermediate": ["N3", "N2"],
        "advanced": ["N2", "N1"],
    },
    "item_types": {
        "vocabulary": ["kanji_reading", "orthography", "context", "paraphrase", "usage"],
        "grammar": ["form_selection", "sentence_composition", "text_grammar"],
        "reading": ["short", "mid", "long", "integrated", "thematic", "information_retrieval"],
        "listening": ["task", "key_points", "outline", "verbal_expressions", "quick_response", "integrated"],
    },
}


class MergeError(Exception):
    pass


def load_pages(work_dir: Path, book_id: str) -> list[dict[str, Any]]:
    page_dir = work_dir / "pages" / book_id
    pages = []
    for path in sorted(page_dir.glob("page-*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise MergeError(f"页级结果无效: {path}: {exc}") from exc
        if data.get("verification") != "candidate":
            raise MergeError(f"页级结果 verification 无效: {path}")
        pages.append(data)
    return sorted(pages, key=lambda item: item["source"]["pdf_page"])


def is_anchor(page: dict[str, Any], strategy: str) -> bool:
    if strategy == "basic":
        return page.get("page_kind") == "basic-text"
    if strategy == "conversation":
        return "会話" in " ".join(page.get("section_titles", []))
    return True


def lesson_starts(
    pages: list[dict[str, Any]], lessons: range, strategy: str
) -> dict[int, int]:
    previous = 0
    starts: dict[int, int] = {}
    for lesson in lessons:
        candidates = [
            page for page in pages
            if page.get("lesson") == lesson
            and page["source"]["pdf_page"] > previous
            and is_anchor(page, strategy)
        ]
        if not candidates:
            candidates = [
                page for page in pages
                if page.get("lesson") == lesson and page["source"]["pdf_page"] > previous
            ]
        if not candidates:
            raise MergeError(f"找不到第 {lesson} 课递增起点")
        start = min(page["source"]["pdf_page"] for page in candidates)
        if start - previous > 40 and previous:
            raise MergeError(f"第 {lesson} 课起点跨度异常: {previous} -> {start}")
        starts[lesson] = start
        previous = start
    return starts


def unique_strings(values: list[Any]) -> list[str]:
    result = []
    seen = set()
    for value in values:
        text = " ".join(str(value).split())
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def merge_grammar(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for page in pages:
        for point in page.get("grammar_points", []):
            pattern = " ".join(point.get("pattern", "").split())
            if not pattern:
                continue
            current = merged.setdefault(
                pattern,
                {
                    "pattern": pattern,
                    "function_cn": point.get("function_cn", ""),
                    "formation": point.get("formation", ""),
                    "constraints": [],
                    "contrasts": [],
                },
            )
            if not current["function_cn"] and point.get("function_cn"):
                current["function_cn"] = point["function_cn"]
            if not current["formation"] and point.get("formation"):
                current["formation"] = point["formation"]
            current["constraints"] = unique_strings(current["constraints"] + point.get("constraints", []))
            current["contrasts"] = unique_strings(current["contrasts"] + point.get("contrasts", []))
    return list(merged.values())


def lesson_pages(
    pages: list[dict[str, Any]], starts: dict[int, int], lessons: range
) -> dict[int, list[dict[str, Any]]]:
    ordered = list(lessons)
    gaps = [starts[right] - starts[left] for left, right in zip(ordered, ordered[1:], strict=False)]
    last_span = max(1, round(statistics.median(gaps)))
    grouped = {}
    for index, lesson in enumerate(ordered):
        start = starts[lesson]
        end = starts[ordered[index + 1]] - 1 if index + 1 < len(ordered) else start + last_span - 1
        grouped[lesson] = [
            page for page in pages
            if start <= page["source"]["pdf_page"] <= end
            and page.get("page_kind") not in {"unit-overview", "appendix", "other"}
        ]
        if not grouped[lesson]:
            raise MergeError(f"第 {lesson} 课没有可合并页面")
    return grouped


def node_for(
    level: str,
    book_id: str,
    lesson: int,
    pages: list[dict[str, Any]],
    verification: str,
) -> dict[str, Any]:
    source_pages = [page["source"]["pdf_page"] for page in pages]
    printed_pages = unique_strings(
        [page["source"].get("printed_page") for page in pages if page["source"].get("printed_page")]
    )
    teaching_pages = [page for page in pages if page.get("page_kind") in TEACHING_PAGE_KINDS]
    grammar = merge_grammar(
        [page for page in teaching_pages if page.get("page_kind") != "applied-text"]
    )
    communications = unique_strings(
        [value for page in teaching_pages for value in page.get("communication_functions", [])]
    )
    pragmatics = unique_strings(
        [value for page in teaching_pages for value in page.get("pragmatics", [])]
    )
    vocabulary_domains = unique_strings(
        [value for page in pages for value in page.get("vocabulary_domains", [])]
    )
    exercise_types = unique_strings(
        [value for page in pages for value in page.get("exercise_types", [])]
    )
    review_flags = unique_strings([value for page in pages for value in page.get("uncertain", [])])
    titles = unique_strings([value for page in pages for value in page.get("section_titles", [])])
    themes = [title for title in titles if title not in GENERIC_TITLES and len(title) <= 80][:8]
    skills = ["vocabulary_kanji"]
    kinds = {page.get("page_kind") for page in pages}
    if grammar:
        skills.append("grammar")
    if kinds & {"basic-text", "applied-text", "contents"}:
        skills.append("reading")
    if communications:
        skills.append("spoken_output")
    if any("听" in item or "录音" in item for item in exercise_types):
        skills.append("listening")
    node_id = f"textbook-{level}-{lesson:02d}"
    first_prerequisite = {
        "beginner": "foundation-basic-sentence",
        "intermediate": "bridge-n4-n3",
        "advanced": "bridge-n3-n2",
    }[level]
    previous = (
        f"textbook-{level}-{lesson - 1:02d}"
        if lesson > 1
        else first_prerequisite
    )
    return {
        "id": node_id,
        "textbook": {
            "level": level,
            "lesson": lesson,
            "book": book_id,
            "pdf_pages": source_pages,
            "printed_pages": printed_pages,
        },
        "themes": themes,
        "jlpt_estimate": {"status": "unverified"},
        "communication_functions": communications,
        "grammar": grammar,
        "pragmatics": pragmatics,
        "vocabulary_domains": vocabulary_domains,
        "similar_contrasts": unique_strings(
            [contrast for point in grammar for contrast in point.get("contrasts", [])]
        ),
        "prerequisites": [previous] if previous else [],
        "vocabulary_selector": {"deck_level": level, "lesson": f"{lesson:02d}"},
        "skills": skills,
        "exercise_types": exercise_types,
        "review_flags": review_flags,
        "sources": [{"id": "standard-japanese-publisher", "pdf_pages": source_pages}],
        "verification": verification,
    }


def build_curriculum(work_dir: Path, verification: str = "candidate") -> dict[str, Any]:
    nodes = []
    boundary_report = {}
    for book_id, level, lessons, strategy in BOOKS:
        pages = load_pages(work_dir, book_id)
        starts = lesson_starts(pages, lessons, strategy)
        grouped = lesson_pages(pages, starts, lessons)
        boundary_report[book_id] = starts
        nodes.extend(
            node_for(level, book_id, lesson, grouped[lesson], verification) for lesson in lessons
        )
    return {
        "schema_version": 1,
        "textbook_lessons": {"beginner": 48, "intermediate": 32, "advanced": 24},
        "node_schema": {
            "required": [
                "id", "textbook", "themes", "jlpt_estimate", "communication_functions",
                "grammar", "pragmatics", "vocabulary_domains", "similar_contrasts",
                "prerequisites", "vocabulary_selector", "skills", "exercise_types", "sources",
                "verification",
            ],
            "verification_values": ["candidate", "cross_checked", "verified"],
        },
        "boundary_report": boundary_report,
        "jlpt_coverage": JLPT_COVERAGE,
        "nodes": nodes,
        "bridge_nodes": BRIDGE_NODES,
    }


def write_yaml(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.safe_dump(data, allow_unicode=True, sort_keys=False, width=100)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", newline="\n", dir=path.parent, delete=False
    ) as handle:
        handle.write(text)
        temp = Path(handle.name)
    temp.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work-dir", type=Path, default=Path(r"D:\标准日本语\.nanobot-extract"))
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "curriculum-n1.yaml",
    )
    parser.add_argument(
        "--cross-checked",
        action="store_true",
        help="在人工课程级复核完成后，将教材节点标为 cross_checked",
    )
    args = parser.parse_args()
    try:
        verification = "cross_checked" if args.cross_checked else "candidate"
        curriculum = build_curriculum(args.work_dir, verification)
        write_yaml(args.output, curriculum)
        print(json.dumps({"ok": True, "nodes": len(curriculum["nodes"]), "output": str(args.output)}, ensure_ascii=False))
        return 0
    except (MergeError, OSError, yaml.YAMLError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
