"""PSB 模型仓库：平铺目录、启动扫描、元数据 sidecar。"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from loguru import logger

from nanobot.config.loader import load_config, save_config
from nanobot.config.paths import get_psb_dir
from nanobot.config.schema import PSBInitialState
from nanobot.webui.psb_parser import is_psb_upload_filename, parse_psb_file, parse_result_to_metadata_dict
from nanobot.webui.psb_translate import labels_need_translation, translate_psb_labels

_MODEL_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")
_META_SUFFIX = ".meta.json"
_METADATA_TRANSLATION_DEBOUNCE_S = 0.5
_metadata_translation_tasks: dict[str, asyncio.Task[None]] = {}


class PsbStoreError(ValueError):
    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _metadata_path(psb_filename: str) -> Path:
    return get_psb_dir() / f"{psb_filename}{_META_SUFFIX}"


def _load_meta_file(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _read_metadata(model_id: str) -> dict[str, Any] | None:
    for path in sorted(get_psb_dir().glob(f"*{_META_SUFFIX}")):
        data = _load_meta_file(path)
        if data and data.get("modelId") == model_id:
            return data
    return None


def _write_metadata(psb_filename: str, data: dict[str, Any]) -> None:
    get_psb_dir().mkdir(parents=True, exist_ok=True)
    _metadata_path(psb_filename).write_text(
        json.dumps(_compact_metadata(data), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _optional_label_zh(label: str, label_zh: str | None) -> str | None:
    text = str(label_zh or "").strip()
    if text and text != label:
        return text
    return None


def _compact_frame(frame: dict[str, Any]) -> dict[str, Any]:
    label = str(frame.get("label") or "")
    compact: dict[str, Any] = {"label": label, "value": frame.get("value")}
    zh = _optional_label_zh(label, str(frame.get("labelZh") or ""))
    if zh:
        compact["labelZh"] = zh
    return compact


def _compact_timeline_item(item: dict[str, Any]) -> dict[str, Any]:
    label = str(item.get("label") or "")
    compact: dict[str, Any] = {"label": label, "looping": bool(item.get("looping", False))}
    zh = _optional_label_zh(label, str(item.get("labelZh") or ""))
    if zh:
        compact["labelZh"] = zh
    return compact


def _compact_expression_item(item: dict[str, Any]) -> dict[str, Any]:
    label = str(item.get("label") or "")
    compact: dict[str, Any] = {"label": label}
    zh = _optional_label_zh(label, str(item.get("labelZh") or ""))
    if zh:
        compact["labelZh"] = zh
    return compact


def _compact_variable_item(item: dict[str, Any]) -> dict[str, Any]:
    label = str(item.get("label") or "")
    compact: dict[str, Any] = {
        "label": label,
        "minValue": item.get("minValue", 0),
        "maxValue": item.get("maxValue", 1),
        "frames": [
            _compact_frame(frame)
            for frame in item.get("frames") or []
            if isinstance(frame, dict)
        ],
    }
    zh = _optional_label_zh(label, str(item.get("labelZh") or ""))
    if zh:
        compact["labelZh"] = zh
    return compact


def _compact_metadata(data: dict[str, Any]) -> dict[str, Any]:
    """落盘前去掉未使用的占位字段，并省略与 label 相同的中文。"""
    compact: dict[str, Any] = {
        "modelId": data.get("modelId"),
        "name": data.get("name"),
        "format": data.get("format"),
        "compatible": data.get("compatible"),
        "psbFile": data.get("psbFile"),
        "hasFaceTalk": data.get("hasFaceTalk"),
        "translationStatus": data.get("translationStatus"),
        "timelines": [
            _compact_timeline_item(item)
            for item in data.get("timelines") or []
            if isinstance(item, dict)
        ],
        "expressions": [
            _compact_expression_item(item)
            for item in data.get("expressions") or []
            if isinstance(item, dict)
        ],
        "faceVariables": [
            _compact_variable_item(item)
            for item in data.get("faceVariables") or []
            if isinstance(item, dict)
        ],
        "fadeVariables": [
            _compact_variable_item(item)
            for item in data.get("fadeVariables") or []
            if isinstance(item, dict)
        ],
        "initialState": data.get("initialState")
        or {"timeline": "", "expression": "", "face": {}, "fade": {}},
    }
    parse_error = data.get("parseError")
    if parse_error:
        compact["parseError"] = parse_error
    return compact


def _model_id_from_filename(filename: str) -> str:
    stem = Path(filename).stem
    base = re.sub(r"[^a-zA-Z0-9]+", "-", stem.strip()).strip("-").lower() or "psb-model"
    return base[:48]


def _unique_model_id(candidate: str, existing: set[str]) -> str:
    if _MODEL_ID_RE.match(candidate) and candidate not in existing:
        return candidate
    for index in range(2, 100):
        alt = f"{candidate[:40]}-{index}"
        if _MODEL_ID_RE.match(alt) and alt not in existing:
            return alt
    return f"{candidate[:32]}-{uuid.uuid4().hex[:6]}"


def _validate_model_id(model_id: str) -> None:
    if not _MODEL_ID_RE.match(model_id):
        raise PsbStoreError("invalid modelId")


def _psb_path_for_model(metadata: dict[str, Any]) -> Path:
    psb_file = str(metadata.get("psbFile") or "").strip()
    if not psb_file or not is_psb_upload_filename(psb_file):
        raise PsbStoreError("model file missing")
    root = get_psb_dir().resolve()
    target = (root / psb_file).resolve()
    if not str(target).startswith(str(root)) or not target.is_file():
        raise PsbStoreError("model file not found", status=404)
    return target


async def _finalize_metadata(model_id: str, psb_path: Path, display_name: str) -> dict[str, Any]:
    result = parse_psb_file(psb_path, display_name=display_name)
    translation_map: dict[str, str] = {}
    translation_status = "skipped"
    if result.compatible and result.labels_to_translate:
        translation_map, translation_status = await translate_psb_labels(result.labels_to_translate)
    metadata = parse_result_to_metadata_dict(
        result,
        model_id=model_id,
        translation_map=translation_map,
        translation_status=translation_status,
    )
    _write_metadata(psb_path.name, metadata)
    return metadata


async def scan_psb_models() -> list[str]:
    """扫描 PSB 目录，为尚无 sidecar 元数据的模型文件生成 .meta.json。"""
    root = get_psb_dir()
    root.mkdir(parents=True, exist_ok=True)
    existing_ids = {
        str(data.get("modelId"))
        for path in root.glob(f"*{_META_SUFFIX}")
        if (data := _load_meta_file(path)) and data.get("modelId")
    }
    discovered: list[str] = []
    for path in sorted(root.iterdir()):
        if not path.is_file() or not is_psb_upload_filename(path.name):
            continue
        if _metadata_path(path.name).is_file():
            continue
        model_id = _unique_model_id(_model_id_from_filename(path.name), existing_ids)
        existing_ids.add(model_id)
        await _finalize_metadata(model_id, path, path.stem)
        discovered.append(model_id)
    return discovered


def list_models() -> list[dict[str, Any]]:
    root = get_psb_dir()
    root.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, Any]] = []
    for path in sorted(root.glob(f"*{_META_SUFFIX}")):
        data = _load_meta_file(path)
        if data is None:
            continue
        items.append(_public_model_summary(data))
    return items


def get_model(model_id: str) -> dict[str, Any]:
    _validate_model_id(model_id)
    metadata = _read_metadata(model_id)
    if metadata is None:
        raise PsbStoreError("model not found", status=404)
    return metadata


def _public_model_summary(metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        "modelId": metadata.get("modelId"),
        "name": metadata.get("name"),
        "format": metadata.get("format"),
        "compatible": metadata.get("compatible"),
        "parseError": metadata.get("parseError"),
        "translationStatus": metadata.get("translationStatus"),
        "hasFaceTalk": metadata.get("hasFaceTalk"),
    }


def delete_model(model_id: str) -> dict[str, Any]:
    _validate_model_id(model_id)
    metadata = _read_metadata(model_id)
    if metadata is None:
        raise PsbStoreError("model not found", status=404)

    config = load_config()
    cleared_selection = config.desk_pet.psb.selected_model_id == model_id
    if cleared_selection:
        config.desk_pet.psb.selected_model_id = None
        save_config(config)

    psb_file = str(metadata.get("psbFile") or "")
    if psb_file:
        (get_psb_dir() / psb_file).unlink(missing_ok=True)
        _metadata_path(psb_file).unlink(missing_ok=True)
    return {"ok": True, "clearedSelection": cleared_selection}


def _metadata_translation_collections(metadata: dict[str, Any]) -> list[list[dict[str, Any]]]:
    return [
        list(metadata.get(key) or [])
        for key in ("timelines", "expressions", "faceVariables", "fadeVariables")
    ]


def _collect_metadata_translation_labels(metadata: dict[str, Any]) -> list[str]:
    return _collect_translation_labels(_metadata_translation_collections(metadata))


def _apply_translation_to_metadata(metadata: dict[str, Any], translation_map: dict[str, str]) -> None:
    _apply_translation_labels(_metadata_translation_collections(metadata), translation_map)


async def _translate_metadata_once(model_id: str) -> None:
    """读取 sidecar 全量标签并调用 LLM 翻译，写回 metadata。"""
    _validate_model_id(model_id)
    metadata = _read_metadata(model_id)
    if metadata is None:
        return

    pending = labels_need_translation(_collect_metadata_translation_labels(metadata))
    if not pending:
        metadata["translationStatus"] = "skipped"
        psb_file = str(metadata.get("psbFile") or "")
        if psb_file:
            _write_metadata(psb_file, metadata)
        return

    metadata["translationStatus"] = "translating"
    psb_file = str(metadata.get("psbFile") or "")
    if psb_file:
        _write_metadata(psb_file, metadata)

    translation_map, status = await translate_psb_labels(pending)

    metadata = _read_metadata(model_id)
    if metadata is None:
        return
    if translation_map:
        _apply_translation_to_metadata(metadata, translation_map)
    metadata["translationStatus"] = status
    psb_file = str(metadata.get("psbFile") or "")
    if psb_file:
        _write_metadata(psb_file, metadata)


async def _debounced_metadata_translation(model_id: str) -> None:
    try:
        await asyncio.sleep(_METADATA_TRANSLATION_DEBOUNCE_S)
        await _translate_metadata_once(model_id)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("PSB metadata translation failed for {}: {}", model_id, exc)
        metadata = _read_metadata(model_id)
        if metadata is None:
            return
        metadata["translationStatus"] = "failed"
        psb_file = str(metadata.get("psbFile") or "")
        if psb_file:
            _write_metadata(psb_file, metadata)


def _schedule_metadata_translation(model_id: str) -> None:
    """分块 runtime sync 结束后合并触发一次后台翻译。"""
    existing = _metadata_translation_tasks.pop(model_id, None)
    if existing and not existing.done():
        existing.cancel()
    _metadata_translation_tasks[model_id] = asyncio.create_task(
        _debounced_metadata_translation(model_id),
        name=f"psb-metadata-translation:{model_id}",
    )


async def retry_translation(model_id: str) -> dict[str, Any]:
    """立即翻译（测试/内部用）；正常运行时由 merge_runtime_metadata 自动调度。"""
    _validate_model_id(model_id)
    metadata = _read_metadata(model_id)
    if metadata is None:
        raise PsbStoreError("model not found", status=404)
    await _translate_metadata_once(model_id)
    refreshed = _read_metadata(model_id)
    if refreshed is None:
        raise PsbStoreError("model not found", status=404)
    return refreshed


def save_initial_state(model_id: str, state: PSBInitialState) -> dict[str, Any]:
    _validate_model_id(model_id)
    metadata = _read_metadata(model_id)
    if metadata is None:
        raise PsbStoreError("model not found", status=404)

    if state.timeline:
        looping = False
        for item in metadata.get("timelines") or []:
            if not isinstance(item, dict):
                continue
            if item.get("label") == state.timeline and item.get("looping"):
                looping = True
                break
        if not looping:
            raise PsbStoreError("initial timeline must be a looping timeline")

    metadata["initialState"] = {
        "timeline": state.timeline,
        "expression": state.expression,
        "face": dict(state.face),
        "fade": dict(state.fade),
    }
    psb_file = str(metadata.get("psbFile") or "")
    if not psb_file:
        raise PsbStoreError("model file missing")
    _write_metadata(psb_file, metadata)
    return metadata


def _pick_label_zh(
    label: str,
    existing_zh: str | None,
    translation_map: dict[str, str],
) -> str:
    if label in translation_map:
        return translation_map[label]
    if existing_zh and existing_zh.strip() and existing_zh != label:
        return existing_zh
    return label


def _merge_timeline_item(metadata: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    label = str(item.get("label") or "").strip()
    existing_tl = {
        str(existing.get("label")): existing
        for existing in metadata.get("timelines") or []
        if isinstance(existing, dict) and existing.get("label")
    }
    prev = existing_tl.get(label, {})
    looping = bool(item.get("looping", prev.get("looping", False)))
    return {
        "label": label,
        "labelZh": str(prev.get("labelZh") or item.get("labelZh") or label),
        "looping": looping,
    }


def _patch_timelines(metadata: dict[str, Any], runtime_items: list[Any]) -> list[dict[str, Any]]:
    by_label: dict[str, dict[str, Any]] = {
        str(item.get("label")): dict(item)
        for item in metadata.get("timelines") or []
        if isinstance(item, dict) and item.get("label")
    }
    for item in runtime_items:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip()
        if not label:
            continue
        by_label[label] = _merge_timeline_item(metadata, item)

    ordered_labels = [
        str(item.get("label"))
        for item in metadata.get("timelines") or []
        if isinstance(item, dict) and item.get("label")
    ]
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for label in ordered_labels:
        if label in by_label and label not in seen:
            merged.append(by_label[label])
            seen.add(label)
    for label, item in by_label.items():
        if label not in seen:
            merged.append(item)
    return merged


def _merge_expression_item(metadata: dict[str, Any], item: dict[str, Any]) -> dict[str, str]:
    label = str(item.get("label") or "").strip()
    existing_expr = {
        str(existing.get("label")): existing
        for existing in metadata.get("expressions") or []
        if isinstance(existing, dict) and existing.get("label")
    }
    prev = existing_expr.get(label, {})
    return {
        "label": label,
        "labelZh": str(prev.get("labelZh") or item.get("labelZh") or label),
    }


def _patch_expressions(metadata: dict[str, Any], runtime_items: list[Any]) -> list[dict[str, str]]:
    by_label: dict[str, dict[str, str]] = {
        str(item.get("label")): dict(item)
        for item in metadata.get("expressions") or []
        if isinstance(item, dict) and item.get("label")
    }
    for item in runtime_items:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip()
        if not label:
            continue
        by_label[label] = _merge_expression_item(metadata, item)

    ordered_labels = [
        str(item.get("label"))
        for item in metadata.get("expressions") or []
        if isinstance(item, dict) and item.get("label")
    ]
    merged: list[dict[str, str]] = []
    seen: set[str] = set()
    for label in ordered_labels:
        if label in by_label and label not in seen:
            merged.append(by_label[label])
            seen.add(label)
    for label, item in by_label.items():
        if label not in seen:
            merged.append(item)
    return merged


def _merge_variable_item(
    metadata: dict[str, Any],
    key: str,
    item: dict[str, Any],
) -> dict[str, Any]:
    label = str(item.get("label") or "").strip()
    existing = {
        str(existing_item.get("label")): existing_item
        for existing_item in metadata.get(key) or []
        if isinstance(existing_item, dict) and existing_item.get("label")
    }
    prev = existing.get(label, {})
    frames: list[dict[str, Any]] = []
    runtime_frames = item.get("frames") or []
    if runtime_frames:
        for frame in runtime_frames:
            if not isinstance(frame, dict):
                continue
            frame_label = str(frame.get("label") or "")
            prev_frames = prev.get("frames") or []
            prev_frame = next(
                (f for f in prev_frames if isinstance(f, dict) and f.get("label") == frame_label),
                None,
            )
            frames.append(
                {
                    "label": frame_label,
                    "labelZh": str(
                        (prev_frame or {}).get("labelZh") or frame.get("labelZh") or frame_label
                    ),
                    "value": frame.get("value"),
                }
            )
    elif prev.get("frames"):
        frames = [dict(frame) for frame in prev.get("frames") or [] if isinstance(frame, dict)]
    label_zh = str(prev.get("labelZh") or item.get("labelZh") or label)
    return {
        "label": label,
        "labelZh": label_zh,
        "minValue": item.get("minValue", prev.get("minValue", 0)),
        "maxValue": item.get("maxValue", prev.get("maxValue", 1)),
        "frames": frames,
    }


def _patch_variables(
    metadata: dict[str, Any],
    key: str,
    runtime_items: list[Any],
) -> list[dict[str, Any]]:
    by_label: dict[str, dict[str, Any]] = {
        str(item.get("label")): dict(item)
        for item in metadata.get(key) or []
        if isinstance(item, dict) and item.get("label")
    }
    for item in runtime_items:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip()
        if not label:
            continue
        by_label[label] = _merge_variable_item(metadata, key, item)

    ordered_labels = [
        str(item.get("label"))
        for item in metadata.get(key) or []
        if isinstance(item, dict) and item.get("label")
    ]
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for label in ordered_labels:
        if label in by_label and label not in seen:
            merged.append(by_label[label])
            seen.add(label)
    for label, item in by_label.items():
        if label not in seen:
            merged.append(item)
    return merged


def _collect_translation_labels(
    collections: list[list[dict[str, Any]]],
) -> list[str]:
    labels_to_translate: list[str] = []
    for collection in collections:
        for item in collection:
            label = str(item.get("label") or "")
            label_zh = str(item.get("labelZh") or label)
            if label and label_zh == label:
                labels_to_translate.append(label)
            for frame in item.get("frames") or []:
                if not isinstance(frame, dict):
                    continue
                frame_label = str(frame.get("label") or "")
                frame_zh = str(frame.get("labelZh") or frame_label)
                if frame_label and frame_zh == frame_label:
                    labels_to_translate.append(frame_label)
    return labels_to_translate


def _apply_translation_labels(
    collections: list[list[dict[str, Any]]],
    translation_map: dict[str, str],
) -> None:
    for collection in collections:
        for item in collection:
            item["labelZh"] = _pick_label_zh(
                str(item.get("label") or ""),
                str(item.get("labelZh") or ""),
                translation_map,
            )
            for frame in item.get("frames") or []:
                if not isinstance(frame, dict):
                    continue
                frame_label = str(frame.get("label") or "")
                frame["labelZh"] = _pick_label_zh(
                    frame_label,
                    str(frame.get("labelZh") or ""),
                    translation_map,
                )


async def merge_runtime_metadata(model_id: str, runtime: dict[str, Any]) -> dict[str, Any]:
    """合并 PSB 窗口运行时解析的能力摘要，并补全中文翻译。

    ``runtime`` 可只包含需更新的字段（分块 GET sync）；未出现的字段保持 sidecar 原值。
    ``timelines`` / ``expressions`` / ``faceVariables`` / ``fadeVariables`` 均按 label 增量合并。
    """
    _validate_model_id(model_id)
    metadata = _read_metadata(model_id)
    if metadata is None:
        raise PsbStoreError("model not found", status=404)

    patch_keys = set(runtime.keys())
    timelines = list(metadata.get("timelines") or [])
    expressions = list(metadata.get("expressions") or [])
    face_variables = list(metadata.get("faceVariables") or [])
    fade_variables = list(metadata.get("fadeVariables") or [])

    if "timelines" in patch_keys:
        timelines = _patch_timelines(metadata, runtime.get("timelines") or [])
    if "expressions" in patch_keys:
        expressions = _patch_expressions(metadata, runtime.get("expressions") or [])
    if "faceVariables" in patch_keys:
        face_variables = _patch_variables(metadata, "faceVariables", runtime.get("faceVariables") or [])
    if "fadeVariables" in patch_keys:
        fade_variables = _patch_variables(metadata, "fadeVariables", runtime.get("fadeVariables") or [])

    updated_collections: list[list[dict[str, Any]]] = []
    if "timelines" in patch_keys:
        updated_collections.append(timelines)
    if "expressions" in patch_keys:
        updated_collections.append(expressions)
    if "faceVariables" in patch_keys:
        updated_collections.append(face_variables)
    if "fadeVariables" in patch_keys:
        updated_collections.append(fade_variables)

    _apply_translation_labels(updated_collections, {})

    if "timelines" in patch_keys:
        metadata["timelines"] = timelines
    if "expressions" in patch_keys:
        metadata["expressions"] = expressions
    if "faceVariables" in patch_keys:
        metadata["faceVariables"] = face_variables
    if "fadeVariables" in patch_keys:
        metadata["fadeVariables"] = fade_variables
    if "hasFaceTalk" in patch_keys:
        metadata["hasFaceTalk"] = bool(runtime.get("hasFaceTalk"))

    pending = labels_need_translation(_collect_metadata_translation_labels(metadata))
    if pending:
        translation_status = "translating"
    elif str(metadata.get("translationStatus") or "") in {"pending", "translating"}:
        translation_status = "done"
    else:
        translation_status = str(metadata.get("translationStatus") or "skipped")

    metadata["translationStatus"] = translation_status

    psb_file = str(metadata.get("psbFile") or "")
    if not psb_file:
        raise PsbStoreError("model file missing")
    _write_metadata(psb_file, metadata)
    if pending:
        _schedule_metadata_translation(model_id)
    return metadata


def select_model(model_id: str | None) -> None:
    config = load_config()
    if model_id:
        _validate_model_id(model_id)
        metadata = _read_metadata(model_id)
        if metadata is None:
            raise PsbStoreError("model not found", status=404)
        if not metadata.get("compatible", False):
            raise PsbStoreError("model is not compatible")
    config.desk_pet.psb.selected_model_id = model_id
    save_config(config)


def build_resource_manifest(model_id: str) -> dict[str, Any]:
    _validate_model_id(model_id)
    metadata = _read_metadata(model_id)
    if metadata is None:
        raise PsbStoreError("model not found", status=404)
    psb_path = _psb_path_for_model(metadata)
    rel = psb_path.name
    files = [
        {
            "path": rel,
            "size": psb_path.stat().st_size,
            "url": f"/api/desk-pet/psb/models/{model_id}/files/{rel}",
        }
    ]
    return {"modelId": model_id, "files": files, "metadata": metadata}


def resolve_model_file(model_id: str, rel_path: str) -> Path:
    _validate_model_id(model_id)
    metadata = _read_metadata(model_id)
    if metadata is None:
        raise PsbStoreError("model not found", status=404)
    psb_file = str(metadata.get("psbFile") or "")
    # 浏览器请求会把中文文件名 percent-encode，需解码后再与元数据比对。
    normalized = unquote(rel_path.replace("\\", "/").lstrip("/"))
    if normalized != psb_file:
        raise PsbStoreError("file not found", status=404)
    return _psb_path_for_model(metadata)
