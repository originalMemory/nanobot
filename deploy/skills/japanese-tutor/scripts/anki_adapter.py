#!/usr/bin/env python3
"""通过 AnkiConnect 管理日语学习牌组；所有命令输出 JSON。"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import ProxyHandler, Request, build_opener

from curriculum_state import state_lock

API_VERSION = 6
TARGET_DECKS = (
    "新标准日本语初级(解释到假名)",
    "新标准日本语中级(解释到假名)",
    "新标准日本语高级(解释到假名)",
)
LEVEL_DECKS = dict(zip(("beginner", "intermediate", "advanced"), TARGET_DECKS, strict=True))
LEVEL_LABELS = {"beginner": "初级", "intermediate": "中级", "advanced": "高级"}
RATINGS = {"again": 1, "hard": 2, "good": 3, "easy": 4}
PRIVATE_CONFIG = Path(__file__).resolve().parents[1] / "japanese-anki.private.json"
IMMERSION_MODEL = "Japanese Immersion"
IMMERSION_DECK = "日语沉浸学习"
IMMERSION_FIELDS = (
    "CandidateId",
    "Japanese",
    "Reading",
    "Meaning",
    "Audio",
    "CurriculumNode",
    "SourceRefs",
    "Generator",
)
IMMERSION_TEMPLATES = (
    {"Name": "Reading", "Front": "{{Japanese}}", "Back": "{{FrontSide}}<hr>{{Reading}}<br>{{Meaning}}"},
    {"Name": "Speaking", "Front": "{{Meaning}}", "Back": "{{FrontSide}}<hr>{{Japanese}}<br>{{Reading}}"},
    {
        "Name": "Listening",
        "Front": "{{#Audio}}{{Audio}}{{/Audio}}",
        "Back": "{{FrontSide}}<hr>{{Japanese}}<br>{{Reading}}<br>{{Meaning}}",
    },
)
IMMERSION_CSS = ".card { font-family: sans-serif; font-size: 28px; text-align: center; }"
SOUND_RE = re.compile(r"\[sound:([^\]]+)]")
IMAGE_RE = re.compile(r"<img[^>]+src=[\"']([^\"']+)[\"']", re.IGNORECASE)
TAG_RE = re.compile(r"<[^>]+>")


class AdapterError(Exception):
    def __init__(self, code: str, message: str, *, exit_code: int = 1) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


class AnkiClient:
    def __init__(self, endpoint: str, api_key: str | None = None, timeout: float = 10) -> None:
        self.endpoint = validate_endpoint(endpoint)
        self.api_key = api_key or None
        self.timeout = timeout
        self.opener = build_opener(ProxyHandler({}))

    def call(self, action: str, params: dict[str, Any] | None = None) -> Any:
        payload: dict[str, Any] = {"action": action, "version": API_VERSION}
        if params:
            payload["params"] = params
        if self.api_key:
            payload["key"] = self.api_key
        request = Request(
            self.endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read()
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            raise AdapterError(
                "unavailable",
                f"AnkiConnect 不可用: {type(exc).__name__}",
                exit_code=2,
            ) from exc
        try:
            result = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AdapterError("malformed_response", "AnkiConnect 返回了无效 JSON") from exc
        if not isinstance(result, dict) or "result" not in result or "error" not in result:
            raise AdapterError("malformed_response", "AnkiConnect 响应结构无效")
        if result["error"] is not None:
            message = str(result["error"])
            if self.api_key:
                message = message.replace(self.api_key, "***")
            lowered = message.lower()
            code = (
                "authentication_failed"
                if "key" in lowered or "permission" in lowered
                else "anki_error"
            )
            raise AdapterError(code, message)
        return result["result"]


def validate_endpoint(value: str) -> str:
    endpoint = value.strip().rstrip("/")
    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise AdapterError("invalid_config", "AnkiConnect URL 必须是有效的 HTTP(S) 地址")
    if parsed.username or parsed.password or parsed.path not in {"", "/"}:
        raise AdapterError("invalid_config", "AnkiConnect URL 不允许凭据或额外路径")
    return endpoint


def load_config(path: Path, url_override: str | None = None) -> tuple[str, str | None, float]:
    data: dict[str, Any] = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise AdapterError("invalid_config", f"无法读取 Anki 配置: {exc}") from exc
        if not isinstance(loaded, dict):
            raise AdapterError("invalid_config", "Anki 配置顶层必须是对象")
        data = loaded

    endpoint = url_override or os.environ.get("ANKI_CONNECT_URL") or data.get("url")
    api_key = os.environ.get("ANKI_CONNECT_API_KEY") or data.get("apiKey")
    timeout = data.get("timeout", 10)
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise AdapterError("invalid_config", "未配置 AnkiConnect URL")
    if api_key is not None and not isinstance(api_key, str):
        raise AdapterError("invalid_config", "AnkiConnect apiKey 必须是字符串")
    if not isinstance(timeout, (int, float)) or timeout <= 0:
        raise AdapterError("invalid_config", "AnkiConnect timeout 必须是正数")
    return endpoint, api_key, float(timeout)


def health(client: AnkiClient) -> dict[str, Any]:
    version = client.call("version")
    if not isinstance(version, int):
        raise AdapterError("malformed_response", "AnkiConnect version 响应无效")
    return {"ok": True, "available": True, "version": version}


def sync(client: AnkiClient) -> dict[str, Any]:
    return {"ok": True, "result": client.call("sync")}


def quote_query(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def note_chunks(note_ids: list[int], size: int = 500) -> list[list[int]]:
    return [note_ids[index : index + size] for index in range(0, len(note_ids), size)]


def plain_primary_field(fields: dict[str, Any]) -> str:
    ordered = sorted(fields.values(), key=lambda item: item.get("order", 999))
    if not ordered:
        return ""
    # ponytail: 精确首字段去重足够发现导入异常；需要语义去重时再做日语归一化。
    value = TAG_RE.sub("", str(ordered[0].get("value", "")))
    return " ".join(html.unescape(value).split())


def discover(client: AnkiClient) -> dict[str, Any]:
    available = client.call("deckNames")
    if not isinstance(available, list):
        raise AdapterError("malformed_response", "deckNames 响应无效")

    reports: list[dict[str, Any]] = []
    all_media: set[str] = set()
    media_by_deck: dict[str, set[str]] = {}
    for deck in TARGET_DECKS:
        if deck not in available:
            reports.append({"name": deck, "present": False})
            continue
        query = f'deck:"{quote_query(deck)}"'
        note_ids = client.call("findNotes", {"query": query})
        if not isinstance(note_ids, list) or not all(isinstance(item, int) for item in note_ids):
            raise AdapterError("malformed_response", f"findNotes 响应无效: {deck}")
        notes: list[dict[str, Any]] = []
        for chunk in note_chunks(note_ids):
            result = client.call("notesInfo", {"notes": chunk})
            if not isinstance(result, list):
                raise AdapterError("malformed_response", f"notesInfo 响应无效: {deck}")
            notes.extend(item for item in result if isinstance(item, dict))

        model_fields: dict[str, set[str]] = defaultdict(set)
        tags: set[str] = set()
        primary_values: list[str] = []
        media: set[str] = set()
        for note in notes:
            model = str(note.get("modelName", ""))
            fields = note.get("fields", {})
            if not isinstance(fields, dict):
                continue
            model_fields[model].update(fields)
            tags.update(str(tag) for tag in note.get("tags", []) if isinstance(tag, str))
            primary = plain_primary_field(fields)
            if primary:
                primary_values.append(primary)
            for field in fields.values():
                value = str(field.get("value", "")) if isinstance(field, dict) else ""
                media.update(SOUND_RE.findall(value))
                media.update(IMAGE_RE.findall(value))
        duplicates = Counter(primary_values)
        media_by_deck[deck] = media
        all_media.update(media)
        reports.append(
            {
                "name": deck,
                "present": True,
                "note_count": len(note_ids),
                "returned_notes": len(notes),
                "models": [
                    {"name": name, "fields": sorted(fields)}
                    for name, fields in sorted(model_fields.items())
                ],
                "tag_count": len(tags),
                "duplicate_groups": sum(count > 1 for count in duplicates.values()),
                "duplicate_notes": sum(count for count in duplicates.values() if count > 1),
                "media_references": len(media),
            }
        )

    media_files = set(client.call("getMediaFilesNames", {"pattern": "*"})) if all_media else set()
    for report in reports:
        if report.get("present"):
            missing = sorted(media_by_deck[report["name"]] - media_files)
            report["missing_media"] = len(missing)
            report["missing_media_samples"] = missing[:5]
    return {"ok": True, "decks": reports}


def field_values(fields: Any) -> dict[str, str]:
    if not isinstance(fields, dict):
        return {}
    return {
        str(name): str(value.get("value", ""))
        for name, value in fields.items()
        if isinstance(value, dict)
    }


def media_references(fields: dict[str, str]) -> list[str]:
    media: set[str] = set()
    for value in fields.values():
        media.update(SOUND_RE.findall(value))
        media.update(IMAGE_RE.findall(value))
    return sorted(media)


def deck_level(deck: str) -> str | None:
    return next((level for level, name in LEVEL_DECKS.items() if name == deck), None)


def normalize_card(card: Any) -> dict[str, Any]:
    if not isinstance(card, dict) or not isinstance(card.get("cardId"), int):
        raise AdapterError("malformed_response", "cardsInfo 响应包含无效卡片")
    fields = field_values(card.get("fields"))
    level = deck_level(str(card.get("deckName", "")))
    lesson = fields.get("课号")
    return {
        "card_id": card["cardId"],
        "note_id": card.get("note"),
        "deck": card.get("deckName"),
        "model": card.get("modelName"),
        "card_type": card.get("ord"),
        "queue": card.get("queue"),
        "type": card.get("type"),
        "due": card.get("due"),
        "interval": card.get("interval"),
        "factor": card.get("factor"),
        "reps": card.get("reps"),
        "lapses": card.get("lapses"),
        "fields": fields,
        "media": media_references(fields),
        "curriculum_mapping": {"level": level, "lesson": lesson} if level and lesson else None,
    }


def card_info(client: AnkiClient, card_ids: list[int]) -> dict[str, Any]:
    if not card_ids:
        raise AdapterError("invalid_arguments", "至少需要一个 --card-id")
    result = client.call("cardsInfo", {"cards": card_ids})
    if not isinstance(result, list):
        raise AdapterError("malformed_response", "cardsInfo 响应无效")
    return {"ok": True, "cards": [normalize_card(card) for card in result]}


def due(client: AnkiClient, limit: int) -> dict[str, Any]:
    if limit < 1:
        raise AdapterError("invalid_arguments", "limit 必须大于 0")
    card_ids: list[int] = []
    for deck in TARGET_DECKS:
        result = client.call("findCards", {"query": f'deck:"{quote_query(deck)}" is:due'})
        if not isinstance(result, list) or not all(isinstance(item, int) for item in result):
            raise AdapterError("malformed_response", f"findCards 响应无效: {deck}")
        card_ids.extend(result)
    selected = card_ids[:limit]
    cards = card_info(client, selected)["cards"] if selected else []
    return {"ok": True, "total_due": len(card_ids), "cards": cards}


def review_history(client: AnkiClient, card_ids: list[int], limit: int) -> dict[str, Any]:
    if not card_ids:
        raise AdapterError("invalid_arguments", "至少需要一个 --card-id")
    if limit < 1:
        raise AdapterError("invalid_arguments", "limit 必须大于 0")
    result = client.call("getReviewsOfCards", {"cards": card_ids})
    if not isinstance(result, dict):
        raise AdapterError("malformed_response", "getReviewsOfCards 响应无效")
    histories: dict[str, list[Any]] = {}
    for card_id in card_ids:
        items = result.get(str(card_id), result.get(card_id, []))
        if not isinstance(items, list):
            raise AdapterError("malformed_response", f"复习历史无效: {card_id}")
        histories[str(card_id)] = sorted(
            (item for item in items if isinstance(item, dict)),
            key=lambda item: item.get("id", 0),
            reverse=True,
        )[:limit]
    return {"ok": True, "reviews": histories}


def lesson_vocabulary(
    client: AnkiClient,
    level: str | None,
    lesson: str | None,
    unit: int | None,
) -> dict[str, Any]:
    if level not in LEVEL_DECKS or not lesson:
        raise AdapterError("invalid_arguments", "lesson-vocabulary 需要 --level 和 --lesson")
    lesson_value = lesson.zfill(2) if lesson.isdigit() else lesson
    terms = [f'deck:"{quote_query(LEVEL_DECKS[level])}"', f'课号:"{quote_query(lesson_value)}"']
    if unit is not None:
        if unit < 1:
            raise AdapterError("invalid_arguments", "unit 必须大于 0")
        terms.append(f'tag:"{LEVEL_LABELS[level]}第{unit}单元"')
    note_ids = client.call("findNotes", {"query": " ".join(terms)})
    if not isinstance(note_ids, list) or not all(isinstance(item, int) for item in note_ids):
        raise AdapterError("malformed_response", "findNotes 响应无效")
    notes: list[dict[str, Any]] = []
    for chunk in note_chunks(note_ids):
        result = client.call("notesInfo", {"notes": chunk})
        if not isinstance(result, list):
            raise AdapterError("malformed_response", "notesInfo 响应无效")
        notes.extend(item for item in result if isinstance(item, dict))
    card_ids = [card for note in notes for card in note.get("cards", []) if isinstance(card, int)]
    cards = card_info(client, card_ids)["cards"] if card_ids else []
    cards_by_note: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for card in cards:
        if isinstance(card["note_id"], int):
            cards_by_note[card["note_id"]].append(card)
    vocabulary = []
    for note in notes:
        note_id = note.get("noteId")
        fields = field_values(note.get("fields"))
        note_cards = cards_by_note.get(note_id, [])
        vocabulary.append(
            {
                "note_id": note_id,
                "card_ids": [card["card_id"] for card in note_cards],
                "model": note.get("modelName"),
                "tags": note.get("tags", []),
                "fields": fields,
                "media": media_references(fields),
                "max_lapses": max((card["lapses"] or 0 for card in note_cards), default=0),
                "curriculum_mapping": {"level": level, "lesson": lesson_value, "unit": unit},
            }
        )
    return {"ok": True, "count": len(vocabulary), "vocabulary": vocabulary}


def automatic_rating(
    outcome: str | None,
    *,
    used_hint: bool,
    attempts: int,
    answer_revealed: bool,
    explicit_easy: bool,
) -> int:
    if outcome not in {"correct", "incorrect", "give-up"}:
        raise AdapterError("invalid_arguments", "auto 模式需要有效的 --outcome")
    if attempts < 1:
        raise AdapterError("invalid_arguments", "attempts 必须大于 0")
    if outcome != "correct" or answer_revealed:
        return RATINGS["again"]
    if explicit_easy:
        return RATINGS["easy"]
    if used_hint or attempts > 1:
        return RATINGS["hard"]
    return RATINGS["good"]


def answer(
    client: AnkiClient,
    card_id: int | None,
    *,
    mode: str,
    outcome: str | None,
    used_hint: bool,
    attempts: int,
    answer_revealed: bool,
    explicit_easy: bool,
    manual_rating: str | None,
) -> dict[str, Any]:
    if not isinstance(card_id, int):
        raise AdapterError("invalid_arguments", "answer 需要一个 --card-id")
    if mode == "practice":
        return {"ok": True, "submitted": False, "reason": "practice_only"}
    if mode == "manual" and manual_rating is None:
        return {"ok": True, "submitted": False, "reason": "manual_rating_required"}
    if mode == "manual":
        if manual_rating not in RATINGS:
            raise AdapterError("invalid_arguments", "manual 模式需要有效的 --rating")
        ease = RATINGS[manual_rating]
    elif mode == "auto":
        ease = automatic_rating(
            outcome,
            used_hint=used_hint,
            attempts=attempts,
            answer_revealed=answer_revealed,
            explicit_easy=explicit_easy,
        )
    else:
        raise AdapterError("invalid_arguments", "未知 answer 模式")
    cards = card_info(client, [card_id])["cards"]
    if len(cards) != 1 or cards[0]["deck"] not in {*TARGET_DECKS, IMMERSION_DECK}:
        raise AdapterError("card_not_allowed", "只允许评分日语学习牌组中的卡片")
    due_result = client.call("areDue", {"cards": [card_id]})
    if due_result != [True]:
        raise AdapterError("card_not_due", "卡片当前未到期，拒绝提交评分")
    result = client.call("answerCards", {"answers": [{"cardId": card_id, "ease": ease}]})
    if not isinstance(result, list) or result != [True]:
        raise AdapterError("anki_error", "Anki scheduler 未接受评分")
    return {"ok": True, "submitted": True, "card_id": card_id, "ease": ease}


def ensure_immersion_model(client: AnkiClient) -> dict[str, Any]:
    models = client.call("modelNames")
    if not isinstance(models, list):
        raise AdapterError("malformed_response", "modelNames 响应无效")
    if IMMERSION_MODEL not in models:
        client.call("createDeck", {"deck": IMMERSION_DECK})
        client.call(
            "createModel",
            {
                "modelName": IMMERSION_MODEL,
                "inOrderFields": list(IMMERSION_FIELDS),
                "cardTemplates": list(IMMERSION_TEMPLATES),
                "css": IMMERSION_CSS,
            },
        )
        return {"ok": True, "created": True, "model": IMMERSION_MODEL, "deck": IMMERSION_DECK}
    fields = client.call("modelFieldNames", {"modelName": IMMERSION_MODEL})
    templates = client.call("modelTemplates", {"modelName": IMMERSION_MODEL})
    styling = client.call("modelStyling", {"modelName": IMMERSION_MODEL})
    expected_templates = {
        item["Name"]: {"Front": item["Front"], "Back": item["Back"]}
        for item in IMMERSION_TEMPLATES
    }
    if fields != list(IMMERSION_FIELDS) or templates != expected_templates or styling != {"css": IMMERSION_CSS}:
        raise AdapterError("model_conflict", "现有 Japanese Immersion Note Type 与预期结构不同")
    client.call("createDeck", {"deck": IMMERSION_DECK})
    return {"ok": True, "created": False, "model": IMMERSION_MODEL, "deck": IMMERSION_DECK}


def read_workspace_json(path: Path, workspace: Path) -> dict[str, Any]:
    try:
        resolved_workspace = workspace.resolve(strict=True)
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise AdapterError("invalid_arguments", f"文件不可读: {path}") from exc
    if not resolved.is_relative_to(resolved_workspace) or not resolved.is_file():
        raise AdapterError("workspace_violation", "文件必须位于 workspace 内")
    try:
        data = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AdapterError("invalid_arguments", f"JSON 文件无效: {exc}") from exc
    if not isinstance(data, dict):
        raise AdapterError("invalid_arguments", "候选文件顶层必须是对象")
    return data


def candidate_fields(candidate: dict[str, Any]) -> tuple[str, dict[str, str]]:
    required = ("Japanese", "Reading", "Meaning", "CurriculumNode", "SourceRefs", "Generator")
    if any(name not in candidate for name in required):
        raise AdapterError("invalid_arguments", "候选缺少必填字段")
    if not all(isinstance(candidate[name], str) for name in required[:4]):
        raise AdapterError("invalid_arguments", "候选文本字段必须是字符串")
    if not isinstance(candidate["SourceRefs"], list) or not all(
        isinstance(item, str) for item in candidate["SourceRefs"]
    ):
        raise AdapterError("invalid_arguments", "SourceRefs 必须是字符串列表")
    if not isinstance(candidate["Generator"], dict):
        raise AdapterError("invalid_arguments", "Generator 必须是对象")
    identity = {
        "Japanese": candidate["Japanese"].strip(),
        "Reading": candidate["Reading"].strip(),
        "Meaning": candidate["Meaning"].strip(),
        "CurriculumNode": candidate["CurriculumNode"].strip(),
        "SourceRefs": sorted(candidate["SourceRefs"]),
    }
    if any(not identity[name] for name in ("Japanese", "Reading", "Meaning", "CurriculumNode")):
        raise AdapterError("invalid_arguments", "候选核心文本字段不能为空")
    candidate_id = "jt-" + hashlib.sha256(
        json.dumps(identity, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:24]
    fields = {
        "CandidateId": candidate_id,
        **{name: identity[name] for name in ("Japanese", "Reading", "Meaning", "CurriculumNode")},
        "SourceRefs": json.dumps(identity["SourceRefs"], ensure_ascii=False),
        "Generator": json.dumps(candidate["Generator"], ensure_ascii=False, sort_keys=True),
        "Audio": "",
    }
    return candidate_id, fields


def find_candidate(client: AnkiClient, candidate_id: str) -> dict[str, Any]:
    if not candidate_id.startswith("jt-"):
        raise AdapterError("invalid_arguments", "CandidateId 无效")
    query = f'note:"{IMMERSION_MODEL}" CandidateId:"{quote_query(candidate_id)}"'
    note_ids = client.call("findNotes", {"query": query})
    if not isinstance(note_ids, list) or not all(isinstance(item, int) for item in note_ids):
        raise AdapterError("malformed_response", "findNotes 响应无效")
    return {"ok": True, "candidate_id": candidate_id, "note_ids": note_ids}


def read_media(path: Path, workspace: Path) -> tuple[str, str]:
    try:
        resolved_workspace = workspace.resolve(strict=True)
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise AdapterError("invalid_arguments", f"音频不可读: {path}") from exc
    if not resolved.is_relative_to(resolved_workspace) or not resolved.is_file():
        raise AdapterError("workspace_violation", "音频必须位于 workspace 内")
    data = resolved.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    suffix = resolved.suffix.lower() or ".mp3"
    return f"japanese_{digest[:24]}{suffix}", base64.b64encode(data).decode("ascii")


def store_media(client: AnkiClient, path: Path, workspace: Path) -> dict[str, Any]:
    filename, encoded = read_media(path, workspace)
    existing = client.call("getMediaFilesNames", {"pattern": filename})
    if existing == [filename]:
        return {"ok": True, "filename": filename, "created": False}
    result = client.call(
        "storeMediaFile",
        {"filename": filename, "data": encoded, "deleteExisting": False},
    )
    if result != filename:
        raise AdapterError("anki_error", "媒体写入失败")
    return {"ok": True, "filename": filename, "created": True}


def add_candidate_note(
    client: AnkiClient,
    candidate: dict[str, Any],
    workspace: Path,
    *,
    confirmed: bool,
) -> dict[str, Any]:
    if not confirmed:
        raise AdapterError("confirmation_required", "创建卡片需要明确确认")
    candidate_id, fields = candidate_fields(candidate)
    with state_lock(workspace / "memory" / "japanese-anki-mutation"):
        ensure_immersion_model(client)
        existing = find_candidate(client, candidate_id)["note_ids"]
        if len(existing) > 1:
            raise AdapterError("candidate_conflict", "同一 CandidateId 对应多个 Note")
        if existing:
            try:
                client.call("sync")
            except AdapterError:
                return {"ok": True, "status": "written_unsynced", "note_id": existing[0]}
            return {"ok": True, "status": "synced_existing", "note_id": existing[0]}
        audio_path = candidate.get("AudioPath")
        if audio_path is not None:
            if not isinstance(audio_path, str):
                raise AdapterError("invalid_arguments", "AudioPath 必须是字符串")
            media_path = Path(audio_path)
            if not media_path.is_absolute():
                media_path = workspace / media_path
            media = store_media(client, media_path, workspace)
            fields["Audio"] = f'[sound:{media["filename"]}]'
        note_id = client.call(
            "addNote",
            {
                "note": {
                    "deckName": IMMERSION_DECK,
                    "modelName": IMMERSION_MODEL,
                    "fields": fields,
                    "tags": ["japanese-immersion"],
                    "options": {"allowDuplicate": False},
                }
            },
        )
        if not isinstance(note_id, int):
            raise AdapterError("anki_error", "Note 创建失败")
        try:
            client.call("sync")
        except AdapterError:
            return {"ok": True, "status": "written_unsynced", "note_id": note_id}
        return {"ok": True, "status": "synced", "note_id": note_id}


def emit(payload: dict[str, Any], *, stream: Any = sys.stdout) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True), file=stream)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=(
            "health",
            "sync",
            "discover",
            "due",
            "card-info",
            "review-history",
            "lesson-vocabulary",
            "answer",
            "ensure-immersion-model",
            "find",
            "add-note",
            "store-media",
        ),
    )
    parser.add_argument("--config", type=Path, default=PRIVATE_CONFIG)
    parser.add_argument("--url")
    parser.add_argument("--card-id", type=int, action="append", default=[])
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--level", choices=tuple(LEVEL_DECKS))
    parser.add_argument("--lesson")
    parser.add_argument("--unit", type=int)
    parser.add_argument("--mode", choices=("auto", "practice", "manual"), default="auto")
    parser.add_argument("--outcome", choices=("correct", "incorrect", "give-up"))
    parser.add_argument("--used-hint", action="store_true")
    parser.add_argument("--attempts", type=int, default=1)
    parser.add_argument("--answer-revealed", action="store_true")
    parser.add_argument("--explicit-easy", action="store_true")
    parser.add_argument("--rating", choices=tuple(RATINGS))
    parser.add_argument(
        "--workspace", type=Path, default=Path(os.environ.get("NANOBOT_WORKSPACE", "."))
    )
    parser.add_argument("--candidate-file", type=Path)
    parser.add_argument("--candidate-id")
    parser.add_argument("--media-path", type=Path)
    parser.add_argument("--confirmed", action="store_true")
    args = parser.parse_args()
    try:
        endpoint, api_key, timeout = load_config(args.config, args.url)
        client = AnkiClient(endpoint, api_key, timeout)
        if args.action == "health":
            result = health(client)
        elif args.action == "sync":
            result = sync(client)
        elif args.action == "discover":
            result = discover(client)
        elif args.action == "due":
            result = due(client, args.limit)
        elif args.action == "card-info":
            result = card_info(client, args.card_id)
        elif args.action == "review-history":
            result = review_history(client, args.card_id, args.limit)
        elif args.action == "lesson-vocabulary":
            result = lesson_vocabulary(client, args.level, args.lesson, args.unit)
        elif args.action == "answer":
            result = answer(
                client,
                args.card_id[0] if len(args.card_id) == 1 else None,
                mode=args.mode,
                outcome=args.outcome,
                used_hint=args.used_hint,
                attempts=args.attempts,
                answer_revealed=args.answer_revealed,
                explicit_easy=args.explicit_easy,
                manual_rating=args.rating,
            )
        elif args.action == "ensure-immersion-model":
            if not args.confirmed:
                raise AdapterError("confirmation_required", "创建 Note Type 需要明确确认")
            with state_lock(args.workspace / "memory" / "japanese-anki-mutation"):
                result = ensure_immersion_model(client)
        elif args.action == "find":
            result = find_candidate(client, args.candidate_id or "")
        elif args.action == "add-note":
            if args.candidate_file is None:
                raise AdapterError("invalid_arguments", "add-note 需要 --candidate-file")
            candidate = read_workspace_json(args.candidate_file, args.workspace)
            result = add_candidate_note(client, candidate, args.workspace, confirmed=args.confirmed)
        else:
            if not args.confirmed or args.media_path is None:
                raise AdapterError("confirmation_required", "store-media 需要确认和 --media-path")
            with state_lock(args.workspace / "memory" / "japanese-anki-mutation"):
                result = store_media(client, args.media_path, args.workspace)
        emit(result)
        return 0
    except AdapterError as exc:
        emit({"ok": False, "error": {"code": exc.code, "message": str(exc)}}, stream=sys.stderr)
        return exc.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
