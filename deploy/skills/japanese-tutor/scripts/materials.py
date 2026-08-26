#!/usr/bin/env python3
"""校验 AI 生成的日语材料，并生成与 Anki adapter 兼容的候选。"""

from __future__ import annotations

import argparse
import json
import sys

from anki_adapter import candidate_fields
from sudachipy import Dictionary, Tokenizer

TOKENIZER = Dictionary().create()


def units(
    text: str, known: set[str], primary: set[str], exemptions: set[str]
) -> list[dict[str, str]]:
    result = []
    for token in TOKENIZER.tokenize(text, Tokenizer.SplitMode.C):
        surface, lemma, kind = token.surface(), token.dictionary_form(), token.part_of_speech()[0]
        if kind == "補助記号" or surface.isdigit():
            continue
        reason = (
            "known"
            if lemma in known
            else "primary_target"
            if lemma in primary
            else "exemption"
            if lemma in exemptions
            else "unknown"
        )
        result.append({"surface": surface, "lemma": lemma, "kind": kind, "known_reason": reason})
    return result


def analyze(text: str, known: set[str], primary: set[str], exemptions: set[str]) -> dict:
    lexical = units(text, known, primary, exemptions)
    unknown = [item for item in lexical if item["known_reason"] == "unknown"]
    coverage = (len(lexical) - len(unknown)) / len(lexical) if lexical else 1.0
    return {
        "lexical_units": lexical,
        "coverage": coverage,
        "unknown": unknown,
        "accepted": coverage >= 0.9,
        "exemptions": sorted(exemptions),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("analyze", "preview"))
    parser.add_argument("--text", action="append", required=True)
    parser.add_argument("--reading", action="append", default=[])
    parser.add_argument("--meaning", action="append", default=[])
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--source-ref", action="append", default=[])
    parser.add_argument("--known", default="[]")
    parser.add_argument("--primary-target", action="append", default=[])
    parser.add_argument("--exemption", action="append", default=[])
    parser.add_argument("--generator-version", default="japanese-tutor-v1")
    args = parser.parse_args()
    try:
        raw_known = json.loads(args.known)
        if not isinstance(raw_known, list) or not all(isinstance(item, str) for item in raw_known):
            raise ValueError("--known 必须是字符串 JSON 数组")
        if len(args.primary_target) > 1:
            raise ValueError("每份材料最多一个 primary target")
        analyses = [
            analyze(text, set(raw_known), set(args.primary_target), set(args.exemption))
            for text in args.text
        ]
        if args.action == "analyze":
            print(json.dumps({"ok": True, "materials": analyses}, ensure_ascii=False))
            return 0
        if len(args.reading) != len(args.text) or len(args.meaning) != len(args.text):
            raise ValueError("每条 --text 都需要对应的 --reading 和 --meaning")
        if not args.source_ref:
            raise ValueError("preview 至少需要一个 --source-ref")
        candidates = []
        for text, reading, meaning, result in zip(
            args.text[:3], args.reading[:3], args.meaning[:3], analyses[:3], strict=True
        ):
            if not result["accepted"]:
                continue
            candidate = {
                "Japanese": text,
                "Reading": reading,
                "Meaning": meaning,
                "CurriculumNode": args.node_id,
                "SourceRefs": args.source_ref,
                "Generator": {"version": args.generator_version, "coverage": result},
            }
            candidate_id, _ = candidate_fields(candidate)
            candidates.append({"CandidateId": candidate_id, **candidate})
        print(
            json.dumps(
                {"ok": True, "candidates": candidates, "requires_confirmation": True},
                ensure_ascii=False,
            )
        )
        return 0
    except (ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
