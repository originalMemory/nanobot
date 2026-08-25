#!/usr/bin/env python3
"""校验日语老师的静态数据，不下载或写入任何外部内容。"""

from __future__ import annotations

import argparse
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


def validate_sources(path: Path) -> None:
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


def validate_curriculum_schema(path: Path, *, allow_incomplete: bool = False) -> bool:
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
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parents[1] / "data")
    parser.add_argument("--allow-incomplete", action="store_true")
    args = parser.parse_args()
    try:
        validate_sources(args.data_dir / "source-registry.yaml")
        complete = validate_curriculum_schema(
            args.data_dir / "curriculum-n1.yaml",
            allow_incomplete=args.allow_incomplete,
        )
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
