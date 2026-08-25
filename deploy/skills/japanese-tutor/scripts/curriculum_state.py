#!/usr/bin/env python3
"""维护日语课程的稀疏状态；Anki 排程不写入此文件。"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator


TRACK_NAMES = (
    "vocabulary_kanji",
    "grammar",
    "reading",
    "listening",
    "spoken_output",
    "test_strategy",
)
LEVELS = ("foundation", "N5", "N4", "N3", "N2", "N1")
DIAGNOSTIC_TASKS = (
    {
        "id": "kana",
        "tracks": ["vocabulary_kanji", "listening"],
        "instruction": "读出一组平假名/片假名，并说明长音、促音或拗音中的一个。",
    },
    {
        "id": "comprehension",
        "tracks": ["reading", "vocabulary_kanji"],
        "instruction": "理解一条由浅入深的日语短句，并用中文说明意思。",
    },
    {
        "id": "particle",
        "tracks": ["grammar"],
        "instruction": "在助词选择题中说明选择理由。",
    },
    {
        "id": "conjugation",
        "tracks": ["grammar", "spoken_output"],
        "instruction": "把一个动词改写成指定活用，并说出使用场景。",
    },
    {
        "id": "production",
        "tracks": ["spoken_output", "test_strategy"],
        "instruction": "围绕日常场景自由表达 1～3 句，并说明当前学习目标。",
    },
)


def default_state() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "profile": {"goal": "JLPT N1", "schedule": None, "preferences": []},
        "tracks": {name: {"level": None, "evidence": []} for name in TRACK_NAMES},
        "nodes": {},
        "known_lexical_units": [],
        "legacy_observations": [],
        "current_node": None,
        "last_session": None,
        "next_recommendation": None,
    }


def validate_state(state: Any) -> dict[str, Any]:
    if not isinstance(state, dict):
        raise ValueError("状态顶层必须是对象")
    required = set(default_state())
    missing = required - state.keys()
    if missing:
        raise ValueError(f"状态缺少字段: {', '.join(sorted(missing))}")
    if state.get("schema_version") != 1:
        raise ValueError("不支持的 schema_version")
    if not isinstance(state["profile"], dict) or not isinstance(state["nodes"], dict):
        raise ValueError("profile 和 nodes 必须是对象")
    if not isinstance(state["known_lexical_units"], list) or not all(
        isinstance(item, str) for item in state["known_lexical_units"]
    ):
        raise ValueError("known_lexical_units 必须是字符串列表")
    if not isinstance(state["legacy_observations"], list) or not all(
        isinstance(item, str) for item in state["legacy_observations"]
    ):
        raise ValueError("legacy_observations 必须是字符串列表")
    if state["current_node"] is not None and not isinstance(state["current_node"], str):
        raise ValueError("current_node 必须是字符串或 null")
    if state["last_session"] is not None and not isinstance(state["last_session"], dict):
        raise ValueError("last_session 必须是对象或 null")
    if state["next_recommendation"] is not None and not isinstance(state["next_recommendation"], str):
        raise ValueError("next_recommendation 必须是字符串或 null")

    tracks = state["tracks"]
    if not isinstance(tracks, dict) or set(tracks) != set(TRACK_NAMES):
        raise ValueError("tracks 必须包含六条固定能力轨")
    for name, track in tracks.items():
        if not isinstance(track, dict) or "level" not in track or "evidence" not in track:
            raise ValueError(f"能力轨无效: {name}")
        if track["level"] is not None and not isinstance(track["level"], str):
            raise ValueError(f"能力轨等级无效: {name}")
        if not isinstance(track["evidence"], list):
            raise ValueError(f"能力轨 evidence 必须是列表: {name}")
    return state


@contextmanager
def state_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def load_state(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ValueError("状态文件不存在") from None
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"状态文件无法读取: {exc}") from exc
    return validate_state(raw)


def save_state(path: Path, state: dict[str, Any]) -> None:
    validate_state(state)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def recover_state(path: Path) -> Path | None:
    if not path.exists():
        return None
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_name(f"{path.stem}.corrupt.{stamp}{path.suffix}")
    os.replace(path, backup)
    return backup


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def import_legacy(path: Path, state: dict[str, Any]) -> int:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return 0
    except OSError as exc:
        raise ValueError(f"旧档案无法读取: {exc}") from exc

    imported = 0
    in_errors = False
    observations: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("## "):
            in_errors = line == "## 易错与待加强"
            continue
        if not line.startswith("- "):
            continue
        value = line[2:].strip()
        if value.startswith("目标：") and value.removeprefix("目标：").strip():
            state["profile"]["goal"] = value.removeprefix("目标：").strip()
            imported += 1
        elif value.startswith("学习节奏：") and value.removeprefix("学习节奏：").strip():
            state["profile"]["schedule"] = value.removeprefix("学习节奏：").strip()
            imported += 1
        elif value.startswith("偏好与素材：") and value.removeprefix("偏好与素材：").strip():
            preference = value.removeprefix("偏好与素材：").strip()
            if preference not in state["profile"]["preferences"]:
                state["profile"]["preferences"].append(preference)
                imported += 1
        elif in_errors and value:
            observations.append(value)

    for observation in observations:
        if observation not in state["legacy_observations"]:
            state["legacy_observations"].append(observation)
            imported += 1
    return imported


def record_diagnostic(state: dict[str, Any], placements: list[str], session_id: str) -> None:
    if not session_id.strip():
        raise ValueError("诊断记录必须提供 session_id")
    for placement in placements:
        try:
            track, level = placement.split("=", 1)
        except ValueError as exc:
            raise ValueError(f"诊断结果格式应为 能力轨=等级: {placement}") from exc
        if track not in TRACK_NAMES:
            raise ValueError(f"未知能力轨: {track}")
        if level not in LEVELS:
            raise ValueError(f"未知等级: {level}")
        evidence = {
            "kind": "diagnostic",
            "session_id": session_id,
            "level": level,
            "recorded_at": datetime.now(UTC).isoformat(),
        }
        state["tracks"][track]["level"] = level
        state["tracks"][track]["evidence"].append(evidence)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=("init", "status", "validate", "import-legacy", "diagnostic-plan", "record-diagnostic"),
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path(os.environ.get("NANOBOT_WORKSPACE", ".")),
    )
    parser.add_argument("--recover", action="store_true")
    parser.add_argument("--legacy-path", type=Path)
    parser.add_argument("--session-id", default="")
    parser.add_argument("--placement", action="append", default=[])
    args = parser.parse_args()
    state_path = args.workspace / "memory" / "japanese-learning-state.json"

    try:
        with state_lock(state_path):
            if args.action == "init":
                backup = None
                if state_path.exists():
                    try:
                        state = load_state(state_path)
                    except ValueError:
                        if not args.recover:
                            raise
                        backup = recover_state(state_path)
                        state = default_state()
                        save_state(state_path, state)
                else:
                    state = default_state()
                    save_state(state_path, state)
                emit({"ok": True, "path": str(state_path), "backup": str(backup) if backup else None})
                return 0

            if args.action == "diagnostic-plan":
                emit({"ok": True, "tasks": DIAGNOSTIC_TASKS, "tracks": TRACK_NAMES})
                return 0
            state = load_state(state_path)
            if args.action == "record-diagnostic":
                if not args.placement:
                    raise ValueError("至少需要一个 --placement")
                record_diagnostic(state, args.placement, args.session_id)
                save_state(state_path, state)
                emit({"ok": True, "path": str(state_path), "tracks": state["tracks"]})
                return 0
            if args.action == "import-legacy":
                legacy_path = args.legacy_path or args.workspace / "memory" / "japanese-learning.md"
                imported = import_legacy(legacy_path, state)
                save_state(state_path, state)
                emit({"ok": True, "path": str(state_path), "legacy_path": str(legacy_path), "imported": imported})
                return 0
            if args.action == "status":
                emit(
                    {
                        "ok": True,
                        "path": str(state_path),
                        "current_node": state["current_node"],
                        "next_recommendation": state["next_recommendation"],
                        "known_lexical_units": len(state["known_lexical_units"]),
                        "legacy_observations": len(state["legacy_observations"]),
                        "tracks": state["tracks"],
                    }
                )
            else:
                emit({"ok": True, "path": str(state_path)})
            return 0
    except ValueError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
