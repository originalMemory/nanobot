"""SessionHistoryStore — 将 consolidation 裁掉的消息追加到按月 jsonl，供事后检索。"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from loguru import logger

from nanobot.utils.helpers import ensure_dir


def extract_content_text(message: dict[str, Any]) -> str:
    """从消息 dict 提取可搜索纯文本（OpenAI / Anthropic 混合格式）。"""
    content = message.get("content", "")
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text", "")
                if isinstance(text, str) and text:
                    parts.append(text)
            elif block_type == "tool_use":
                name = block.get("name", "")
                payload = block.get("input", "")
                try:
                    payload_text = json.dumps(payload, ensure_ascii=False)[:200]
                except TypeError:
                    payload_text = str(payload)[:200]
                parts.append(f"{name}: {payload_text}")
            elif block_type == "tool_result":
                result = block.get("content", "")
                if isinstance(result, str):
                    parts.append(result)
                else:
                    try:
                        parts.append(json.dumps(result, ensure_ascii=False)[:200])
                    except TypeError:
                        parts.append(str(result)[:200])
        if parts:
            return " ".join(parts)

    return ""


class SessionHistoryStore:
    """按条持久化被 consolidation 裁掉的消息到按月 jsonl 文件。"""

    def __init__(self, sessions_dir: Path) -> None:
        self._lock = threading.Lock()
        self._archive_dir: Path | None = None
        if isinstance(sessions_dir, Path):
            self._archive_dir = sessions_dir / "archive"
        else:
            logger.debug(
                "SessionHistoryStore: invalid sessions_dir type {}, disabled",
                type(sessions_dir).__name__,
            )

    def insert_messages(
        self,
        session_key: str,
        messages: list[dict[str, Any]],
        reason: str,
    ) -> None:
        """将 messages 逐条追加到按月 jsonl；失败只记 warning，不抛出。"""
        if not messages:
            return
        if not self._archive_dir:
            return

        by_month: dict[str, list[str]] = {}
        for message in messages:
            raw_json = json.dumps(message, ensure_ascii=False)
            msg_ts = message.get("timestamp", "") or ""
            month = msg_ts[:7] if msg_ts else "unknown"
            by_month.setdefault(month, []).append(raw_json)

        try:
            with self._lock:
                self._archive_dir.mkdir(parents=True, exist_ok=True)
                for month, lines in by_month.items():
                    out_file = self._archive_dir / f"{month}.jsonl"
                    with open(out_file, "a", encoding="utf-8") as f:
                        for line in lines:
                            f.write(line + "\n")
        except Exception:
            logger.warning(
                "SessionHistoryStore: failed to append {} messages for {} ({})",
                len(messages),
                session_key,
                reason,
                exc_info=True,
            )
