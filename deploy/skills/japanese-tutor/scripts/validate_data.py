#!/usr/bin/env python3
"""校验日语老师的静态数据，不下载或写入任何外部内容。"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

import yaml


def load_yaml(path: Path) -> dict:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ValueError(f"无法读取 {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path} 顶层必须是对象")
    return data


def validate_sources(path: Path) -> set[str]:
    data = load_yaml(path)
    if data.get("schema_version") != 1:
        raise ValueError("source-registry schema_version 必须为 1")
    sources = data.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError("source-registry 必须包含非空 sources")

    seen: set[str] = set()
    required = {"id", "name", "url", "license", "trust", "allowed_uses", "redistributable", "attribution"}
    for source in sources:
        if not isinstance(source, dict):
            raise ValueError("每个 source 必须是对象")
        missing = required - source.keys()
        if missing:
            raise ValueError(f"source 缺少字段: {', '.join(sorted(missing))}")
        source_id = source["id"]
        if not isinstance(source_id, str) or not source_id or source_id in seen:
            raise ValueError(f"source id 无效或重复: {source_id!r}")
        seen.add(source_id)
        parsed = urlparse(source["url"])
        if parsed.scheme != "https" or not parsed.netloc:
            raise ValueError(f"source URL 必须是 HTTPS: {source_id}")
        if not isinstance(source["allowed_uses"], list) or not source["allowed_uses"]:
            raise ValueError(f"source allowed_uses 无效: {source_id}")
        if not isinstance(source["redistributable"], bool):
            raise ValueError(f"source redistributable 必须是布尔值: {source_id}")
    return seen


def validate_curriculum_schema(
    path: Path,
    *,
    allow_incomplete: bool = False,
    source_ids: set[str] | None = None,
) -> bool:
    data = load_yaml(path)
    if data.get("schema_version") != 1:
        raise ValueError("curriculum schema_version 必须为 1")
    lessons = data.get("textbook_lessons")
    if lessons != {"beginner": 48, "intermediate": 32, "advanced": 24}:
        raise ValueError("curriculum textbook_lessons 必须是初级 48、中级 32、高级 24")
    schema = data.get("node_schema")
    if not isinstance(schema, dict) or not schema.get("required"):
        raise ValueError("curriculum 缺少 node_schema.required")
    nodes = data.get("nodes")
    if not isinstance(nodes, list) or not isinstance(data.get("bridge_nodes"), list):
        raise ValueError("curriculum nodes 和 bridge_nodes 必须是列表")
    expected = sum(lessons.values())
    if len(nodes) != expected:
        if not allow_incomplete or len(nodes) > expected:
            raise ValueError(f"curriculum nodes 必须恰好 {expected} 个，当前 {len(nodes)} 个")
        return False
    required = set(schema["required"])
    allowed_verification = set(schema.get("verification_values", []))
    ids: set[str] = set()
    expected_ids = {
        *(f"textbook-beginner-{lesson:02d}" for lesson in range(1, 49)),
        *(f"textbook-intermediate-{lesson:02d}" for lesson in range(1, 33)),
        *(f"textbook-advanced-{lesson:02d}" for lesson in range(1, 25)),
    }
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("curriculum node 必须是对象")
        missing = required - node.keys()
        if missing:
            raise ValueError(f"curriculum node 缺少字段: {', '.join(sorted(missing))}")
        node_id = node.get("id")
        if not isinstance(node_id, str) or node_id in ids:
            raise ValueError(f"curriculum node id 无效或重复: {node_id!r}")
        ids.add(node_id)
        if node.get("verification") not in allowed_verification:
            raise ValueError(f"curriculum verification 无效: {node_id}")
        textbook = node.get("textbook")
        if not isinstance(textbook, dict) or textbook.get("level") not in lessons:
            raise ValueError(f"curriculum textbook 无效: {node_id}")
        if not isinstance(textbook.get("lesson"), int):
            raise ValueError(f"curriculum lesson 无效: {node_id}")
        pages = textbook.get("pdf_pages")
        if not isinstance(pages, list) or not pages or not all(
            isinstance(page, int) and page > 0 for page in pages
        ):
            raise ValueError(f"curriculum pdf_pages 无效: {node_id}")
        if not isinstance(node.get("prerequisites"), list):
            raise ValueError(f"curriculum prerequisites 无效: {node_id}")
        sources = node.get("sources")
        if not isinstance(sources, list) or not sources:
            raise ValueError(f"curriculum sources 无效: {node_id}")
        for source in sources:
            if not isinstance(source, dict) or source.get("id") not in (source_ids or set()):
                raise ValueError(f"curriculum source 引用无效: {node_id}")
            if source.get("pdf_pages") != pages:
                raise ValueError(f"curriculum source 页码不一致: {node_id}")
    if ids != expected_ids:
        missing = sorted(expected_ids - ids)
        extra = sorted(ids - expected_ids)
        raise ValueError(f"curriculum 教材 ID 不完整: missing={missing}, extra={extra}")

    bridges = data["bridge_nodes"]
    bridge_ids = {
        bridge.get("id") for bridge in bridges if isinstance(bridge, dict) and isinstance(bridge.get("id"), str)
    }
    if len(bridge_ids) != len(bridges):
        raise ValueError("bridge node id 无效或重复")
    bridge_required = {"id", "title", "skills", "prerequisites", "sources", "verification"}
    for bridge in bridges:
        if not isinstance(bridge, dict) or bridge_required - bridge.keys():
            raise ValueError("bridge node 缺少必填字段")
        if bridge["verification"] not in allowed_verification:
            raise ValueError(f"bridge verification 无效: {bridge['id']}")
        if not isinstance(bridge["skills"], list) or not bridge["skills"]:
            raise ValueError(f"bridge skills 无效: {bridge['id']}")
        if not isinstance(bridge["sources"], list) or not bridge["sources"]:
            raise ValueError(f"bridge sources 无效: {bridge['id']}")
        if any(source.get("id") not in (source_ids or set()) for source in bridge["sources"]):
            raise ValueError(f"bridge source 引用无效: {bridge['id']}")
    all_ids = ids | bridge_ids
    graph: dict[str, list[str]] = {}
    for node in [*nodes, *bridges]:
        node_id = node["id"]
        prerequisites = node.get("prerequisites", [])
        if not isinstance(prerequisites, list) or any(item not in all_ids for item in prerequisites):
            raise ValueError(f"curriculum prerequisite 引用无效: {node_id}")
        graph[node_id] = prerequisites
    validate_acyclic(graph)
    coverage = data.get("jlpt_coverage")
    if not isinstance(coverage, dict) or coverage.get("source") != "jlpt-official":
        raise ValueError("jlpt_coverage source 无效")
    if set(coverage.get("level_alignment", {})) != set(lessons):
        raise ValueError("jlpt_coverage level_alignment 无效")
    if set(coverage.get("item_types", {})) != {"vocabulary", "grammar", "reading", "listening"}:
        raise ValueError("jlpt_coverage item_types 无效")
    return True


def validate_acyclic(graph: dict[str, list[str]]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> None:
        if node in visiting:
            raise ValueError(f"curriculum prerequisite 存在循环: {node}")
        if node in visited:
            return
        visiting.add(node)
        for prerequisite in graph[node]:
            visit(prerequisite)
        visiting.remove(node)
        visited.add(node)

    for node in graph:
        visit(node)


def validate_no_extracted_payloads(skill_root: Path) -> None:
    forbidden_suffixes = {".pdf", ".apkg", ".anki2", ".mp3", ".wav", ".png", ".jpg", ".jpeg"}
    page_result = re.compile(r"page-\d{4}\.json$")
    for path in skill_root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() in forbidden_suffixes or page_result.search(path.name):
            raise ValueError(f"技能目录包含提取中间产物: {path.relative_to(skill_root)}")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parents[1] / "data")
    parser.add_argument("--skill-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--allow-incomplete", action="store_true")
    args = parser.parse_args()
    try:
        source_ids = validate_sources(args.data_dir / "source-registry.yaml")
        complete = validate_curriculum_schema(
            args.data_dir / "curriculum-n1.yaml",
            allow_incomplete=args.allow_incomplete,
            source_ids=source_ids,
        )
        validate_no_extracted_payloads(args.skill_root)
    except ValueError as exc:
        print(f"校验失败: {exc}", file=sys.stderr)
        return 1
    if complete:
        print("静态数据校验通过")
    else:
        print("静态数据结构校验通过（课程节点未完成）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
