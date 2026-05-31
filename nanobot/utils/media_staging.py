"""将出站附件复制到 ``media/`` 目录，供 WebUI 签名 URL 与其它通道复用。"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from nanobot.config.paths import get_media_dir
from nanobot.utils.helpers import safe_filename

# 超过此大小的文件用 stat 指纹命名，避免全量读盘算 hash。
_FULL_HASH_MAX_BYTES = 8 * 1024 * 1024
_REMOTE_MEDIA_PREFIXES = ("http://", "https://")


def is_remote_media_url(value: str) -> bool:
    """判断媒体条目是否是浏览器可直接加载的远程 URL。"""
    return value.startswith(_REMOTE_MEDIA_PREFIXES)


def staging_channel_for(channel: str | None) -> str:
    """将逻辑通道名映射到 ``media/<name>/`` 子目录。"""
    if not channel or channel in {"cli", "system"}:
        return "websocket"
    return channel


def is_under_media_dir(path: Path) -> bool:
    """*path* 是否已位于实例 ``media/`` 根目录下。"""
    try:
        path.resolve().relative_to(get_media_dir().resolve())
        return True
    except (OSError, ValueError):
        return False


def _staging_prefix(resolved: Path) -> str | None:
    """生成 staging 文件名前缀：小文件全量 hash，大文件用 size+mtime 指纹。"""
    try:
        st = resolved.stat()
    except OSError:
        return None
    if st.st_size <= _FULL_HASH_MAX_BYTES:
        digest = hashlib.sha256()
        with resolved.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()[:16]
    meta = f"{st.st_size}:{st.st_mtime_ns}:{resolved.name}".encode()
    return hashlib.sha256(meta).hexdigest()[:16]


def stage_media_file(path: Path, *, channel: str = "websocket") -> Path | None:
    """把本地文件放入 ``media/<channel>/``；已在 media 内则原样返回。

    使用内容 hash（或大文件的 stat 指纹）作为文件名前缀，相同文件只保留一份副本。
    """
    try:
        resolved = path.expanduser().resolve()
    except OSError:
        return None
    if not resolved.is_file():
        return None
    if is_under_media_dir(resolved):
        return resolved

    prefix = _staging_prefix(resolved)
    if prefix is None:
        return None
    safe_name = safe_filename(resolved.name) or "attachment"
    staged = get_media_dir(staging_channel_for(channel)) / f"{prefix}-{safe_name}"
    if staged.is_file():
        return staged.resolve()
    try:
        staged.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(resolved, staged)
    except OSError:
        return None
    return staged.resolve()


def normalize_outbound_media(media: list[str], *, channel: str = "websocket") -> list[str]:
    """把出站 ``media`` 路径列表规范化为可持久化 / 可签名的本地路径。"""
    out: list[str] = []
    bucket = staging_channel_for(channel)
    for entry in media:
        if not isinstance(entry, str) or not entry:
            continue
        if is_remote_media_url(entry):
            out.append(entry)
            continue
        staged = stage_media_file(Path(entry), channel=bucket)
        if staged is not None:
            out.append(str(staged))
    return out
