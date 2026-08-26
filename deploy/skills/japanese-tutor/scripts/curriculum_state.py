#!/usr/bin/env python3
"""维护日语课程的稀疏状态；Anki 排程不写入此文件。"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

import yaml

if os.name == "nt":
    import msvcrt
else:
    import fcntl


TRACK_NAMES = (
    "vocabulary_kanji",
    "grammar",
    "reading",
    "listening",
    "spoken_output",
    "test_strategy",
)
LEVELS = ("foundation", "N5", "N4", "N3", "N2", "N1")
LEVEL_RANKS = {level: index for index, level in enumerate(LEVELS)}
TEXTBOOK_TARGETS = {"beginner": "N4", "intermediate": "N2", "advanced": "N1"}
NODE_STATES = {"new", "learning", "reviewing", "mastered"}
STATE_PRIORITY = {"reviewing": 0, "learning": 1, "new": 2}
QUESTION_SKILLS = {
    "vocabulary": "vocabulary_kanji",
    "grammar": "grammar",
    "reading": "reading",
    "listening": "listening",
}
STAGE_TARGETS = {
    "foundation": "N5",
    "beginner": "N4",
    "intermediate": "N2",
    "advanced": "N1",
}
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
SESSION_BUDGETS = {
    "micro": {"minutes": 5, "review_limit": 1},
    "standard": {"minutes": 20, "review_limit": 5},
    "deep": {"minutes": 30, "review_limit": 5},
}


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
    if state["next_recommendation"] is not None and not isinstance(
        state["next_recommendation"], str
    ):
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
    for node_id, node in state["nodes"].items():
        if not isinstance(node_id, str) or not isinstance(node, dict):
            raise ValueError("nodes 必须是节点 ID 到对象的映射")
        if node.get("status", "new") not in NODE_STATES or not isinstance(
            node.get("evidence", []), list
        ):
            raise ValueError(f"节点状态无效: {node_id}")
    return state


@contextmanager
def state_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a+b") as lock_file:
        if os.name == "nt":
            if lock_file.tell() == 0:
                lock_file.write(b"\0")
                lock_file.flush()
            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
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


def write_summary(path: Path, state: dict[str, Any]) -> None:
    tracks = "\n".join(
        f"- {name}: {state['tracks'][name]['level'] or '未定级'}" for name in TRACK_NAMES
    )
    observations = "\n".join(f"- {item}" for item in state["legacy_observations"][-8:]) or "- 暂无"
    start, end = "<!-- japanese-tutor:summary:start -->", "<!-- japanese-tutor:summary:end -->"
    block = (
        f"{start}\n## 自动摘要\n- 目标：{state['profile']['goal']}\n"
        f"- 当前节点：{state['current_node'] or '暂无'}\n\n### 六轨\n{tracks}\n\n"
        f"### 易错与待加强\n{observations}\n{end}"
    )
    existing = path.read_text(encoding="utf-8") if path.exists() else "# 日语学习档案\n"
    if start in existing and end in existing:
        before, remainder = existing.split(start, 1)
        _, after = remainder.split(end, 1)
        content = before.rstrip() + "\n\n" + block + after
    else:
        content = existing.rstrip() + "\n\n" + block + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_name, path)


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


def load_curriculum(path: Path) -> dict[str, Any]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ValueError(f"课程文件无法读取: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("课程文件顶层必须是对象")
    nodes = data.get("nodes")
    bridges = data.get("bridge_nodes")
    if not isinstance(nodes, list) or not isinstance(bridges, list):
        raise ValueError("课程文件缺少 nodes 或 bridge_nodes")
    return data


def load_anki_status(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {"available": False, "reason": "not_configured", "weaknesses": [], "due_cards": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Anki 状态文件无法读取: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("available"), bool):
        raise ValueError("Anki 状态文件必须包含布尔 available")
    weaknesses = data.get("weaknesses", [])
    if not isinstance(weaknesses, list):
        raise ValueError("Anki 状态 weaknesses 必须是列表")
    due_cards = data.get("due_cards", [])
    if not isinstance(due_cards, list) or not all(isinstance(card, dict) for card in due_cards):
        raise ValueError("Anki 状态 due_cards 必须是对象列表")
    return {
        "available": data["available"],
        "reason": data.get("reason"),
        "weaknesses": weaknesses,
        "due_cards": due_cards,
    }


def node_state(state: dict[str, Any], node_id: str) -> str:
    entry = state["nodes"].get(node_id, {})
    if not isinstance(entry, dict):
        raise ValueError(f"节点状态无效: {node_id}")
    value = entry.get("status", "new")
    if value not in NODE_STATES:
        raise ValueError(f"节点状态无效: {node_id}={value!r}")
    return value


def target_level(node: dict[str, Any]) -> str:
    explicit = node.get("target_level")
    if explicit in LEVEL_RANKS:
        return explicit
    textbook = node.get("textbook")
    if isinstance(textbook, dict) and textbook.get("level") in TEXTBOOK_TARGETS:
        return TEXTBOOK_TARGETS[textbook["level"]]
    return "foundation"


def weak_tracks(state: dict[str, Any], node: dict[str, Any]) -> list[str]:
    target = LEVEL_RANKS[target_level(node)]
    result = []
    for track in node.get("skills", []):
        current = state["tracks"].get(track, {}).get("level")
        if current is None or LEVEL_RANKS.get(current, -1) < target:
            result.append(track)
    return result


def matching_question_gaps(node: dict[str, Any], question_gaps: list[str]) -> list[str]:
    skills = set(node.get("skills", []))
    return [gap for gap in question_gaps if QUESTION_SKILLS.get(gap.split(":", 1)[0]) in skills]


def plan_next(
    state: dict[str, Any],
    curriculum: dict[str, Any],
    anki: dict[str, Any],
    question_gaps: list[str] | None = None,
) -> dict[str, Any]:
    question_gaps = question_gaps or []
    all_nodes = [*curriculum["bridge_nodes"], *curriculum["nodes"]]
    index = {node.get("id"): node for node in all_nodes if isinstance(node, dict)}
    if len(index) != len(all_nodes) or any(not node_id for node_id in index):
        raise ValueError("课程节点 ID 无效或重复")
    weakness_score: dict[str, int] = {}
    for weakness in anki["weaknesses"]:
        if not isinstance(weakness, dict):
            continue
        node_id = weakness.get("node_id")
        lapses = weakness.get("lapses", 0)
        if isinstance(node_id, str) and isinstance(lapses, int) and lapses > 0:
            weakness_score[node_id] = max(weakness_score.get(node_id, 0), lapses)

    ready: list[tuple[tuple[int, int, int, int, int], dict[str, Any]]] = []
    for order, node in enumerate(all_nodes):
        node_id = node["id"]
        status = node_state(state, node_id)
        if node.get("verification") == "candidate" or status == "mastered":
            continue
        prerequisites = node.get("prerequisites", [])
        if not isinstance(prerequisites, list) or any(item not in index for item in prerequisites):
            raise ValueError(f"节点前置关系无效: {node_id}")
        if any(node_state(state, prerequisite) != "mastered" for prerequisite in prerequisites):
            continue
        weak_count = len(weak_tracks(state, node))
        gap_count = len(matching_question_gaps(node, question_gaps))
        score = (
            STATE_PRIORITY[status],
            -weakness_score.get(node_id, 0),
            -gap_count,
            -weak_count,
            order,
        )
        ready.append((score, node))

    if not ready:
        return {
            "ok": True,
            "anki": {"available": anki["available"], "reason": anki.get("reason")},
            "next_node": None,
            "reason": "no_teachable_node",
            "review_focus": [],
        }
    _, node = min(ready, key=lambda item: item[0])
    node_id = node["id"]
    status = node_state(state, node_id)
    matched_weaknesses = [
        weakness
        for weakness in anki["weaknesses"]
        if isinstance(weakness, dict) and weakness.get("node_id") == node_id
    ]
    return {
        "ok": True,
        "anki": {"available": anki["available"], "reason": anki.get("reason")},
        "next_node": {
            "id": node_id,
            "textbook": node.get("textbook"),
            "themes": node.get("themes", [node.get("title", node_id)]),
            "skills": node.get("skills", []),
            "prerequisites": node.get("prerequisites", []),
            "target_level": target_level(node),
            "status": status,
        },
        "reason": "anki_unavailable" if not anki["available"] else "next_teachable_node",
        "review_focus": weak_tracks(state, node),
        "question_type_gaps": matching_question_gaps(node, question_gaps),
        "anki_weaknesses": matched_weaknesses if anki["available"] else [],
    }


def build_session_plan(
    next_plan: dict[str, Any], anki: dict[str, Any], mode: str, *, fatigued: bool = False
) -> dict[str, Any]:
    requested_mode = mode
    if fatigued:
        mode = "micro"
    budget = SESSION_BUDGETS[mode]
    due_cards = anki["due_cards"][: budget["review_limit"]] if anki["available"] else []
    steps: list[dict[str, Any]] = []
    if due_cards:
        steps.append({"kind": "anki_review", "cards": len(due_cards)})
    elif mode != "micro":
        steps.append({"kind": "transfer_check", "cards": 0})

    new_target = None if mode == "micro" else next_plan["next_node"]
    if new_target is not None:
        steps.extend(
            [
                {"kind": "teach", "node_id": new_target["id"], "examples": 2, "dialogue_turns": 2},
                {"kind": "practice", "primary_target": new_target["id"]},
            ]
        )
        if mode == "deep":
            steps.append({"kind": "extended_input", "options": ["graded_reading", "tts_listening"]})
        steps.append({"kind": "transfer_check", "node_id": new_target["id"]})
    elif mode == "micro" and not due_cards:
        steps.append({"kind": "transfer_check", "cards": 0})

    return {
        "ok": True,
        "mode": mode,
        "requested_mode": requested_mode,
        "budget_minutes": budget["minutes"],
        "reason": "fatigue_fallback" if fatigued else next_plan["reason"],
        "planner_reason": next_plan["reason"],
        "review_cards": due_cards,
        "new_target": new_target,
        "steps": steps,
    }


def stage_gate(
    state: dict[str, Any],
    curriculum: dict[str, Any],
    stage: str,
    question_gaps: list[str] | None = None,
) -> dict[str, Any]:
    target = STAGE_TARGETS[stage]
    if stage == "foundation":
        required_nodes = [
            node["id"]
            for node in curriculum["bridge_nodes"]
            if node["id"].startswith("foundation-")
        ]
    else:
        required_nodes = [
            node["id"]
            for node in curriculum["nodes"]
            if node.get("textbook", {}).get("level") == stage
        ]
    missing_nodes = [
        node_id for node_id in required_nodes if node_state(state, node_id) != "mastered"
    ]
    below_tracks = [
        track
        for track in TRACK_NAMES
        if LEVEL_RANKS.get(state["tracks"][track]["level"], -1) < LEVEL_RANKS[target]
    ]
    gaps = question_gaps or []
    return {
        "ok": True,
        "stage": stage,
        "target_level": target,
        "passed": not missing_nodes and not below_tracks and not gaps,
        "missing_nodes": missing_nodes,
        "below_tracks": below_tracks,
        "question_type_gaps": gaps,
    }


def record_evidence(
    state: dict[str, Any],
    curriculum: dict[str, Any],
    *,
    node_id: str,
    session_id: str,
    kind: str,
    outcome: str,
    context: str = "transfer",
    correction: str = "",
    used_hint: bool = False,
) -> dict[str, Any]:
    if not session_id.strip():
        raise ValueError("课程证据必须提供 session_id")
    if kind not in {"recognition", "production"}:
        raise ValueError("课程证据 kind 必须是 recognition 或 production")
    if outcome not in {"correct", "incorrect"}:
        raise ValueError("课程证据 outcome 必须是 correct 或 incorrect")
    if context not in {"original", "transfer"}:
        raise ValueError("课程证据 context 必须是 original 或 transfer")
    known_ids = {
        node["id"]
        for node in [*curriculum["nodes"], *curriculum["bridge_nodes"]]
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }
    if node_id not in known_ids:
        raise ValueError(f"未知课程节点: {node_id}")

    entry = state["nodes"].setdefault(node_id, {"status": "new", "evidence": []})
    evidence = {
        "session_id": session_id,
        "kind": kind,
        "outcome": outcome,
        "context": context,
        "correction": correction.strip(),
        "used_hint": used_hint,
        "recorded_at": datetime.now(UTC).isoformat(),
    }
    entry["evidence"].append(evidence)
    state["current_node"] = node_id
    state["last_session"] = {
        "id": session_id,
        "node_id": node_id,
        "recorded_at": evidence["recorded_at"],
    }

    if outcome == "incorrect":
        entry["status"] = "reviewing" if entry["status"] == "mastered" else "learning"
        return entry

    last_incorrect = max(
        (
            index
            for index, item in enumerate(entry["evidence"])
            if item.get("outcome") == "incorrect"
        ),
        default=-1,
    )
    successful: dict[str, set[str]] = {}
    for item in entry["evidence"][last_incorrect + 1 :]:
        if (
            item.get("outcome") == "correct"
            and item.get("context", "transfer") == "transfer"
            and not item.get("used_hint", False)
            and isinstance(item.get("session_id"), str)
        ):
            successful.setdefault(item["session_id"], set()).add(str(item.get("kind")))
    complete_sessions = [
        evidence_session
        for evidence_session, kinds in successful.items()
        if {"recognition", "production"}.issubset(kinds)
    ]
    if len(complete_sessions) >= 2:
        entry["status"] = "mastered"
    elif complete_sessions:
        entry["status"] = "reviewing"
    elif entry["status"] != "reviewing":
        entry["status"] = "learning"
    return entry


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=(
            "init",
            "status",
            "validate",
            "import-legacy",
            "diagnostic-plan",
            "record-diagnostic",
            "update-summary",
            "plan",
            "session-plan",
            "stage-gate",
            "record-evidence",
        ),
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path(os.environ.get("NANOBOT_WORKSPACE", ".")),
    )
    parser.add_argument("--recover", action="store_true")
    parser.add_argument("--legacy-path", type=Path)
    parser.add_argument(
        "--curriculum",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "curriculum-n1.yaml",
    )
    parser.add_argument("--anki-status", type=Path)
    parser.add_argument("--session", choices=tuple(SESSION_BUDGETS), default="standard")
    parser.add_argument("--fatigued", action="store_true")
    parser.add_argument("--stage", choices=tuple(STAGE_TARGETS))
    parser.add_argument("--question-gap", action="append", default=[])
    parser.add_argument("--node-id")
    parser.add_argument("--evidence-kind", choices=("recognition", "production"))
    parser.add_argument("--outcome", choices=("correct", "incorrect"))
    parser.add_argument("--evidence-context", choices=("original", "transfer"), default="transfer")
    parser.add_argument("--correction", default="")
    parser.add_argument("--used-hint", action="store_true")
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
                emit(
                    {"ok": True, "path": str(state_path), "backup": str(backup) if backup else None}
                )
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
            if args.action == "update-summary":
                summary_path = args.workspace / "memory" / "japanese-learning.md"
                write_summary(summary_path, state)
                emit({"ok": True, "path": str(summary_path)})
                return 0
            if args.action == "plan":
                curriculum = load_curriculum(args.curriculum)
                anki = load_anki_status(args.anki_status)
                result = plan_next(state, curriculum, anki, args.question_gap)
                state["next_recommendation"] = (
                    result["next_node"]["id"] if result["next_node"] else None
                )
                save_state(state_path, state)
                emit(result)
                return 0
            if args.action == "session-plan":
                curriculum = load_curriculum(args.curriculum)
                anki = load_anki_status(args.anki_status)
                emit(
                    build_session_plan(
                        plan_next(state, curriculum, anki, args.question_gap),
                        anki,
                        args.session,
                        fatigued=args.fatigued,
                    )
                )
                return 0
            if args.action == "stage-gate":
                if not args.stage:
                    raise ValueError("stage-gate 需要 --stage")
                curriculum = load_curriculum(args.curriculum)
                emit(stage_gate(state, curriculum, args.stage, args.question_gap))
                return 0
            if args.action == "record-evidence":
                if not args.node_id or not args.evidence_kind or not args.outcome:
                    raise ValueError("record-evidence 需要 --node-id、--evidence-kind 和 --outcome")
                curriculum = load_curriculum(args.curriculum)
                entry = record_evidence(
                    state,
                    curriculum,
                    node_id=args.node_id,
                    session_id=args.session_id,
                    kind=args.evidence_kind,
                    outcome=args.outcome,
                    context=args.evidence_context,
                    correction=args.correction,
                    used_hint=args.used_hint,
                )
                save_state(state_path, state)
                emit(
                    {
                        "ok": True,
                        "node_id": args.node_id,
                        "status": entry["status"],
                        "evidence": entry["evidence"],
                    }
                )
                return 0
            if args.action == "import-legacy":
                legacy_path = args.legacy_path or args.workspace / "memory" / "japanese-learning.md"
                imported = import_legacy(legacy_path, state)
                save_state(state_path, state)
                emit(
                    {
                        "ok": True,
                        "path": str(state_path),
                        "legacy_path": str(legacy_path),
                        "imported": imported,
                    }
                )
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
                        "active_nodes": {
                            node_id: node.get("status", "new")
                            for node_id, node in state["nodes"].items()
                            if node.get("status", "new") != "mastered"
                        },
                        "recent_corrections": [
                            item["correction"]
                            for node in state["nodes"].values()
                            for item in node.get("evidence", [])
                            if item.get("correction")
                        ][-8:],
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
