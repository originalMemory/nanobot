"""Small image metadata helpers used when media is persisted."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError


def image_dimensions(path: Path) -> tuple[int, int] | None:
    """Read image dimensions without decoding the full pixel payload."""
    try:
        with Image.open(path) as image:
            width, height = image.size
    except (OSError, UnidentifiedImageError):
        return None
    return (width, height) if width > 0 and height > 0 else None


def read_media_sidecar(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def update_media_sidecar(path: Path, **values: Any) -> None:
    metadata = read_media_sidecar(path)
    metadata.update(values)
    path.with_suffix(".json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
