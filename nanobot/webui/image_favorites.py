"""Collect generated images for the image-sharing skill."""

from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from filelock import FileLock

from nanobot.utils.helpers import safe_filename


def _sidecar(path: Path) -> dict[str, Any]:
    sidecar = path.with_suffix(".json")
    try:
        value = json.loads(sidecar.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _metadata(path: Path) -> dict[str, str]:
    raw = _sidecar(path)
    values = {key: str(raw.get(key, "")).strip() for key in ("title", "model", "prompt")}
    if not all(values.values()):
        raise ValueError(f"image metadata missing: {path.name}")
    return values


def _unique_path(directory: Path, stem: str, suffix: str) -> Path:
    candidate = directory / f"{stem}{suffix}"
    index = 2
    while candidate.exists():
        candidate = directory / f"{stem}_{index}{suffix}"
        index += 1
    return candidate


def _mark_favorited(path: Path, gallery_file: str) -> None:
    metadata = _sidecar(path)
    paths = [path]
    source_path = metadata.get("path")
    if isinstance(source_path, str) and source_path:
        original = Path(source_path)
        if original.resolve() != path and original.with_suffix(".json").is_file():
            paths.append(original)
    for target in paths:
        metadata_path = target.with_suffix(".json")
        current = metadata if target == path else _sidecar(target)
        current["favorited"] = True
        current["favorite_file"] = gallery_file
        temporary = metadata_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(metadata_path)


def collect_image(
    source: Path,
    *,
    workspace: Path,
    timezone: str,
) -> dict[str, Any]:
    """Copy one generated image and append the gallery ledger."""
    source = source.resolve(strict=True)
    if not source.is_file():
        raise FileNotFoundError(source)
    metadata = _metadata(source)
    source_metadata = _sidecar(source)
    if source_metadata.get("favorited") and source_metadata.get("favorite_file"):
        return {"ok": True, "already": True, "file": source_metadata["favorite_file"], "title": metadata["title"]}
    now = datetime.now(ZoneInfo(timezone))
    day = now.date().isoformat()
    title = metadata["title"]
    model = metadata["model"]
    safe_title = safe_filename(title) or "image"
    safe_model = safe_filename(model) or "unknown"
    gallery = workspace / "data" / "image-sharing" / "gallery"
    records = workspace / "data" / "image-sharing" / "prompt-gallery.jsonl"
    gallery.mkdir(parents=True, exist_ok=True)
    records.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(records) + ".lock"):
        base = gallery / f"{now:%Y%m%d}_{safe_title}_{safe_model}{source.suffix.lower()}"
        if base.is_file() and base.read_bytes() == source.read_bytes():
            _mark_favorited(source, base.name)
            return {"ok": True, "already": True, "file": base.name, "title": title}
        target = _unique_path(gallery, f"{now:%Y%m%d}_{safe_title}_{safe_model}", source.suffix.lower())
        shutil.copyfile(source, target)
        record = {
            "kind": "image", "date": day, "title": title, "file": target.name,
            "model": model, "prompt": metadata["prompt"],
            "feedback": "通过图片收藏按钮收藏",
        }
        with records.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        _mark_favorited(source, target.name)
    return {"ok": True, "file": target.name, "title": title}
