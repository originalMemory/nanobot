"""Read-only workspace and note-library browsing, confined to configured roots."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote
from zoneinfo import ZoneInfo

import yaml
from markdown_it import MarkdownIt
from markdown_it.token import Token

from nanobot.config.schema import Config
from nanobot.webui.file_preview import MAX_FILE_PREVIEW_BYTES, language_for_path

IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_ENTRIES = 1000
IGNORE_DIRS = frozenset({
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
    ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".coverage", "htmlcov",
})


class LibraryError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def resolve_library_path(root: Path, raw: str) -> Path:
    value = raw.replace("\\", "/")
    if len(value) > 4096 or value.startswith(("/", "~")) or any(p in {".."} or ":" in p for p in value.split("/")):
        raise LibraryError(403, "invalid relative path")
    try:
        target = (root / value).resolve(strict=True)
        target.relative_to(root)
    except FileNotFoundError as exc:
        raise LibraryError(404, "not found") from exc
    except (ValueError, RuntimeError) as exc:
        raise LibraryError(403, "outside library root") from exc
    return target


def library_payload(
    config: Config,
    *,
    source: str,
    action: str,
    path: str,
    sign_image: Callable[[Path], dict[str, str] | None],
    now: datetime | None = None,
) -> dict[str, Any]:
    if source not in {"workspace", "notes"} or action not in {"list", "read", "today"}:
        raise LibraryError(400, "invalid library request")
    diary = Path(config.diary_root).expanduser().resolve() if config.diary_root else None
    if source == "notes" and diary is None:
        raise LibraryError(404, "diaryRoot is not configured")
    root = (diary.parent if source == "notes" and diary else config.workspace_path).resolve()
    if action == "today":
        if source != "notes" or diary is None:
            raise LibraryError(400, "today is only available for notes")
        date = (now or datetime.now(ZoneInfo(config.agents.defaults.timezone))).astimezone(ZoneInfo(config.agents.defaults.timezone))
        weekday = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")[date.weekday()]
        path = f"{diary.name}/{date:%Y/%m/%Y-%m-%d} {weekday}.md"
        action = "read"
    target = resolve_library_path(root, path)
    relative = target.relative_to(root).as_posix()
    base = {"root": str(root), "path": "" if relative == "." else relative}
    if action == "list":
        if not target.is_dir():
            raise LibraryError(400, "not a directory")
        entries: list[dict[str, str]] = []
        for item in target.iterdir():
            if item.name in IGNORE_DIRS:
                continue
            try:
                resolved = item.resolve()
                if not resolved.is_relative_to(root) or not (resolved.is_dir() or resolved.is_file()):
                    continue
            except (OSError, RuntimeError):
                continue
            entries.append({"name": item.name, "kind": "dir" if resolved.is_dir() else "file"})
            if len(entries) > MAX_ENTRIES:
                break
        return {**base, "kind": "directory", "entries": sorted(entries[:MAX_ENTRIES], key=lambda e: (e["kind"] != "dir", e["name"].casefold())), "truncated": len(entries) > MAX_ENTRIES}
    if not target.is_file():
        raise LibraryError(400, "not a file")

    def image_url(candidate: Path) -> str | None:
        resolved = candidate.resolve()
        if not resolved.is_relative_to(root) or not resolved.is_file() or resolved.suffix.lower() not in IMAGE_TYPES:
            return None
        if resolved.stat().st_size > MAX_IMAGE_BYTES:
            return None
        signed = sign_image(resolved)
        return signed.get("url") if signed else None

    if target.suffix.lower() in IMAGE_TYPES:
        url = image_url(target)
        if not url:
            raise LibraryError(413, "image cannot be previewed")
        return {**base, "kind": "image", "url": url, "truncated": False}
    with target.open("rb") as file:
        raw = file.read(MAX_FILE_PREVIEW_BYTES + 1)
    if b"\0" in raw or target.suffix.lower() in {".pdf", ".zip", ".gz", ".mp4", ".mp3", ".woff", ".woff2"}:
        raise LibraryError(415, "unsupported binary file")
    truncated = len(raw) > MAX_FILE_PREVIEW_BYTES
    content = raw[:MAX_FILE_PREVIEW_BYTES].decode("utf-8", errors="replace")
    original_content = content
    frontmatter = ""
    properties: dict[str, Any] = {}
    image_sources: dict[str, str] = {}
    images_omitted = 0
    if target.suffix.lower() in {".md", ".markdown"}:
        match = re.match(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", content, re.S)
        if match:
            frontmatter = match[1]
            content = content[match.end():]
            try:
                # 不展开 YAML 别名，避免循环或指数展开；解析失败仍可查看完整原文。
                if not any(isinstance(token, yaml.AliasToken) for token in yaml.scan(frontmatter)):  # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType]
                    parsed = yaml.safe_load(frontmatter)
                    if isinstance(parsed, dict):
                        properties = json.loads(json.dumps(parsed, default=str, allow_nan=False))
            except (yaml.YAMLError, ValueError, TypeError, RecursionError):
                pass
        # Parse image nodes instead of rewriting source text, including references/titles.
        date_dir = re.search(r"(?:^|/)(\d{4})/(\d{2})/", base["path"])
        seen: set[str] = set()

        def embed(raw_name: str) -> None:
            nonlocal images_omitted
            key = unquote(raw_name)
            if key in seen or raw_name.lower().startswith(("http://", "https://")) or raw_name.startswith("/api/media/"):
                return
            seen.add(key)
            if len(image_sources) >= 8:
                images_omitted += 1
                return
            name = unquote(raw_name.split("#", 1)[0].strip())
            if ":" in name or name.startswith(("/", "\\", "~")):
                images_omitted += 1
                return
            try:
                candidates = [target.parent / name, root / name]
                if date_dir and Path(name).name == name:
                    candidates.append(root / "assets" / "images" / date_dir[1] / date_dir[2] / name)
                url = next((url for candidate in candidates if (url := image_url(candidate))), None)
                # 旧 JPEG 引用可读取转换后的同名 WebP；原文件存在时优先原文件。
                if url is None and Path(name).suffix.lower() in {".jpg", ".jpeg"}:
                    url = next((url for candidate in candidates if (url := image_url(candidate.with_suffix(".webp")))), None)
            except (OSError, RuntimeError, ValueError):
                url = None
            if url:
                image_sources[key] = url
            else:
                images_omitted += 1

        def collect(tokens: list[Token]) -> None:
            for token in tokens:
                if token.type == "image":
                    src = token.attrGet("src")
                    if isinstance(src, str):
                        embed(src)
                elif token.type == "text":
                    for match in re.finditer(r"!\[\[([^\]]+)\]\]", token.content):
                        embed(match[1].split("|", 1)[0].strip())
                elif token.children:
                    collect(token.children)

        banner = properties.get("banner") or properties.get("cover")
        if isinstance(banner, str) and banner.strip():
            banner = banner.strip()
            if banner.startswith("[[") and banner.endswith("]]"):
                banner = banner[2:-2].split("|", 1)[0].strip()
            embed(banner)
        collect(MarkdownIt().parse(content))
    return {**base, "kind": "text", "content": content, "frontmatter": frontmatter,
            "properties": properties,
            "image_sources": image_sources, "images_omitted": images_omitted,
            **({"raw_content": original_content} if target.suffix.lower() in {".md", ".markdown"} else {}),
            "language": "markdown" if target.suffix.lower() == ".markdown" else language_for_path(target),
            "size": target.stat().st_size, "truncated": truncated}
