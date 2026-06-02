"""SessionArchiver — 保存被裁剪消息的原始 JSON，供事后回溯。

写入位置：{sessions_dir}/archive/{safe_key}.jsonl
单文件超过 MAX_FILE_BYTES 时 rotate：重命名为 .1.jsonl、.2.jsonl …
每条记录格式：
  {"_type": "trim_archive", "session_key": ..., "trimmed_at": ...,
   "reason": "file_cap"|"idle_compact", "messages": [...]}
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

from nanobot.utils.helpers import ensure_dir, safe_filename


class SessionArchiver:
    """追加写入被裁剪消息到 sessions/archive/ 目录，按大小 rotate。"""

    MAX_FILE_BYTES: int = 10 * 1024 * 1024  # 10 MB

    def __init__(self, sessions_dir: Path) -> None:
        self._archive_dir = ensure_dir(sessions_dir / "archive")

    def _current_path(self, safe_key: str) -> Path:
        return self._archive_dir / f"{safe_key}.jsonl"

    def _rotate_if_needed(self, path: Path) -> None:
        """当 path 超过阈值时，向后推编号腾出新文件。"""
        if not path.exists():
            return
        try:
            size = path.stat().st_size
        except OSError:
            return
        if size < self.MAX_FILE_BYTES:
            return

        # 找最小可用编号
        n = 1
        while True:
            rotated = path.with_name(f"{path.stem}.{n}.jsonl")
            if not rotated.exists():
                break
            n += 1
        try:
            path.rename(rotated)
            logger.info(
                "SessionArchiver: rotated {} → {} (was {} bytes)",
                path.name,
                rotated.name,
                size,
            )
        except OSError:
            logger.warning("SessionArchiver: rotate failed for {}", path)

    def append(
        self,
        session_key: str,
        messages: list[dict[str, Any]],
        reason: str,
    ) -> None:
        """将 messages 作为一条 trim_archive 记录追加到对应 session 的 archive 文件。

        Args:
            session_key: 原始 session key（如 "telegram:123456"）。
            messages:    被裁剪的消息列表，保留原始 dict 结构。
            reason:      裁剪原因，"file_cap" 或 "idle_compact"。
        """
        if not messages:
            return

        safe_key = safe_filename(session_key.replace(":", "_"))
        path = self._current_path(safe_key)
        self._rotate_if_needed(path)

        record: dict[str, Any] = {
            "_type": "trim_archive",
            "session_key": session_key,
            "trimmed_at": datetime.now(timezone.utc).isoformat(),
            "reason": reason,
            "messages": messages,
        }
        try:
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            logger.warning(
                "SessionArchiver: failed to write archive for {} ({})",
                session_key,
                reason,
            )
