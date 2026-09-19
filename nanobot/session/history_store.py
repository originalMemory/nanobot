"""在活动 workspace namespace 内保存裁剪原文：archive/YYYY-MM.jsonl。"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
from contextlib import suppress
from pathlib import Path
from typing import Any, cast

from filelock import FileLock

from nanobot.utils.helpers import _write_text_atomic  # pyright: ignore[reportPrivateUsage]


class SessionHistoryStore:
    def __init__(self, sessions_dir: Path):
        self.archive_dir = sessions_dir / "archive"

    def insert_messages(self, session_key: str, messages: list[dict[str, Any]], reason: str) -> None:
        """完整归档并校验；失败抛出，调用方必须停止物理裁剪。"""
        if not messages:
            return
        if not self.archive_dir.resolve().is_relative_to(self.archive_dir.parent.parent.resolve()):
            raise OSError("原文归档目录不能越出工作区")
        self.archive_dir.mkdir(parents=True, exist_ok=True)
        for parent in (self.archive_dir.parent, self.archive_dir.parent.parent):
            with suppress(PermissionError, NotImplementedError):
                fd = os.open(parent, os.O_RDONLY)
                try:
                    try:
                        os.fsync(fd)
                    except OSError as error:
                        if error.errno != errno.EINVAL:
                            raise
                finally:
                    os.close(fd)
        batch = hashlib.sha256(json.dumps([session_key, messages], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        grouped: dict[str, list[tuple[int, dict[str, Any]]]] = {}
        for index, message in enumerate(messages):
            if "_archive_meta" in message:
                raise ValueError("活跃消息包含保留的归档元数据字段")
            timestamp = message.get("timestamp")
            month = timestamp[:7] if isinstance(timestamp, str) else "unknown"
            if re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2])", month) is None:
                month = "unknown"
            grouped.setdefault(month, []).append((index, message))
        with FileLock(str(self.archive_dir / ".archive.lock")):
            for month, indexed in grouped.items():
                records = [message for _, message in indexed]
                path = self.archive_dir / f"{month}.jsonl"
                if path.is_symlink():
                    raise OSError("原文归档不能写入符号链接")
                previous = path.read_text(encoding="utf-8") if path.exists() else ""
                matching: list[dict[str, Any]] = []
                for line in previous.splitlines():
                    value: Any = json.loads(line) if line.strip() else None
                    if isinstance(value, dict):
                        value = cast(dict[str, Any], value)
                        meta = value.get("_archive_meta")
                        if isinstance(meta, dict) and cast(dict[str, Any], meta).get("batch") == batch:
                            matching.append({key: item for key, item in value.items() if key != "_archive_meta"})
                if matching:
                    if matching != records:
                        raise OSError("原文归档批次不完整，拒绝裁剪")
                    continue
                # ponytail: 月文件原子重写，避免半行和重试重复；实测规模过大再改追加日志索引。
                addition = "".join(json.dumps({**message, "_archive_meta": {
                    "session_key": session_key, "reason": reason, "batch": batch, "index": index,
                }}, ensure_ascii=False) + "\n" for index, message in indexed)
                content = previous + ("\n" if previous and not previous.endswith("\n") else "") + addition
                _write_text_atomic(path, content)
                if path.read_text(encoding="utf-8") != content:
                    raise OSError("原文归档校验失败，拒绝裁剪")
