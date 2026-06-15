"""Gateway 工作区只读文件浏览 API 的共享逻辑。"""

from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from typing import Any, Literal

from nanobot.security.workspace_policy import is_path_within, require_path_within

# 与 ListDirTool._IGNORE_DIRS 对齐
WORKSPACE_IGNORE_DIRS = frozenset({
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    "dist", "build", ".tox", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".coverage", "htmlcov",
})

# 支持 base64 内联预览的 raster 图片（不含 svg，避免脚本注入）
_IMAGE_EXTENSIONS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
})

# 不可预览的二进制扩展名
_BINARY_EXTENSIONS = frozenset({
    ".svg",
    ".pdf", ".zip", ".gz", ".tar", ".bz2", ".xz", ".7z", ".rar",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm",
    ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".pyc", ".pyo", ".class", ".o", ".a",
})

MAX_READ_BYTES = 10 * 1024 * 1024


class WorkspaceFilesError(Exception):
    """工作区文件 API 的业务错误。"""

    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _normalize_rel_path(raw: str | None) -> str:
    if raw is None:
        return ""
    text = raw.strip().replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    return text.strip("/")


def _reject_unsafe_rel_path(rel_path: str) -> None:
    if not rel_path:
        return
    if rel_path.startswith("/") or rel_path.startswith("~"):
        raise WorkspaceFilesError("path must be relative to workspace root", status=400)
    parts = [part for part in rel_path.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise WorkspaceFilesError("path traversal is not allowed", status=403)
    if any(":" in part for part in parts):
        raise WorkspaceFilesError("invalid path segment", status=400)


def resolve_workspace_relative_path(workspace_root: Path, rel_path: str | None) -> Path:
    """将相对路径解析为 workspace 内的绝对路径。"""
    root = workspace_root.expanduser().resolve(strict=False)
    normalized = _normalize_rel_path(rel_path)
    _reject_unsafe_rel_path(normalized)
    target = (root / normalized).resolve(strict=False) if normalized else root
    if not is_path_within(target, root):
        raise WorkspaceFilesError("path is outside workspace root", status=403)
    return target


def _assert_within_workspace(target: Path, workspace_root: Path) -> None:
    try:
        require_path_within(target, workspace_root.expanduser().resolve(strict=False))
    except Exception as e:
        raise WorkspaceFilesError("path is outside workspace root", status=403) from e


def list_workspace_dir(workspace_root: Path, rel_path: str | None = None) -> dict[str, Any]:
    """列出 workspace 内单层目录内容。"""
    target = resolve_workspace_relative_path(workspace_root, rel_path)
    if not target.exists():
        raise WorkspaceFilesError("directory not found", status=404)
    if not target.is_dir():
        raise WorkspaceFilesError("not a directory", status=400)

    entries: list[dict[str, str]] = []
    for item in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if item.name in WORKSPACE_IGNORE_DIRS:
            continue
        kind: Literal["file", "dir"] = "dir" if item.is_dir() else "file"
        entries.append({"name": item.name, "kind": kind})

    display_path = _normalize_rel_path(rel_path)
    return {"path": display_path, "entries": entries}


def _read_workspace_image(
    normalized: str,
    target: Path,
    raw: bytes,
    size_bytes: int,
    workspace_root: Path,
) -> dict[str, Any]:
    _assert_within_workspace(target, workspace_root)
    mime, _ = mimetypes.guess_type(target.name)
    if not mime or not mime.startswith("image/"):
        mime = "application/octet-stream"
    return {
        "path": normalized,
        "kind": "image",
        "mime_type": mime,
        "content_base64": base64.b64encode(raw).decode("ascii"),
        "size_bytes": size_bytes,
        "truncated": False,
    }


def read_workspace_file(workspace_root: Path, rel_path: str | None) -> dict[str, Any]:
    """读取 workspace 内文本或图片文件内容。"""
    normalized = _normalize_rel_path(rel_path)
    if not normalized:
        raise WorkspaceFilesError("missing path", status=400)

    target = resolve_workspace_relative_path(workspace_root, normalized)
    if not target.exists():
        raise WorkspaceFilesError("file not found", status=404)
    if not target.is_file():
        raise WorkspaceFilesError("not a file", status=400)

    suffix = target.suffix.lower()
    try:
        size_bytes = target.stat().st_size
    except OSError as e:
        raise WorkspaceFilesError(str(e), status=500) from e

    if suffix in _IMAGE_EXTENSIONS:
        if size_bytes > MAX_READ_BYTES:
            raise WorkspaceFilesError("image too large to preview", status=413)
        try:
            raw = target.read_bytes()
        except OSError as e:
            raise WorkspaceFilesError(str(e), status=500) from e
        return _read_workspace_image(normalized, target, raw, size_bytes, workspace_root)

    if suffix in _BINARY_EXTENSIONS:
        raise WorkspaceFilesError("binary file cannot be previewed", status=415)

    truncated = size_bytes > MAX_READ_BYTES
    read_len = MAX_READ_BYTES if truncated else size_bytes
    try:
        with target.open("rb") as handle:
            raw = handle.read(read_len)
    except OSError as e:
        raise WorkspaceFilesError(str(e), status=500) from e

    if b"\x00" in raw[:8192]:
        raise WorkspaceFilesError("binary file cannot be previewed", status=415)

    payload = raw
    try:
        content = payload.decode("utf-8")
    except UnicodeDecodeError as e:
        raise WorkspaceFilesError("file is not valid UTF-8 text", status=415) from e

    _assert_within_workspace(target, workspace_root)

    return {
        "path": normalized,
        "kind": "text",
        "content": content,
        "encoding": "utf-8",
        "size_bytes": size_bytes,
        "truncated": truncated,
    }
