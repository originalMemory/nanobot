"""SessionHistoryStore — 将 consolidation 裁掉的消息按条写入 SQLite，供事后检索。"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

from nanobot.utils.helpers import ensure_dir

_SCHEMA = """
CREATE TABLE IF NOT EXISTS session_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key  TEXT    NOT NULL,
    trimmed_at   TEXT    NOT NULL,
    reason       TEXT    NOT NULL,
    role         TEXT    NOT NULL,
    content_text TEXT,
    raw_json     TEXT    NOT NULL,
    msg_timestamp TEXT   NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sk ON session_messages(session_key);
CREATE INDEX IF NOT EXISTS idx_time ON session_messages(trimmed_at);
CREATE INDEX IF NOT EXISTS idx_msg_time ON session_messages(msg_timestamp);
"""

_MAX_SEARCH_LIMIT = 100
_SNIPPET_RADIUS = 50
_RESULT_CONTENT_MAX = 300


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


def _content_text_for_row(message: dict[str, Any], raw_json: str) -> str:
    text = extract_content_text(message)
    if text:
        return text
    return raw_json[:500]


def _make_snippet(content_text: str, query: str) -> str:
    if not content_text or not query:
        return content_text[: _SNIPPET_RADIUS * 2] if content_text else ""
    match = re.search(re.escape(query), content_text, flags=re.IGNORECASE)
    if not match:
        return content_text[: _SNIPPET_RADIUS * 2]
    start = max(0, match.start() - _SNIPPET_RADIUS)
    end = min(len(content_text), match.end() + _SNIPPET_RADIUS)
    snippet = content_text[start:end]
    if start > 0:
        snippet = "…" + snippet
    if end < len(content_text):
        snippet = snippet + "…"
    return snippet


def _normalize_until(until: str) -> str:
    """若只传日期，补全到当天末尾。"""
    if "T" in until or " " in until:
        return until
    return f"{until}T23:59:59"


class SessionHistoryStore:
    """按条持久化被 consolidation 裁掉的消息，支持关键词检索。"""

    def __init__(self, sessions_dir: Path) -> None:
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self._db_path: Path | None = None
        if isinstance(sessions_dir, Path):
            self._db_path = ensure_dir(sessions_dir) / "history.db"
        else:
            logger.debug(
                "SessionHistoryStore: invalid sessions_dir type {}, disabled",
                type(sessions_dir).__name__,
            )

    def _ensure_conn(self) -> sqlite3.Connection | None:
        if self._conn is not None:
            return self._conn
        if self._db_path is None:
            return None
        with self._lock:
            if self._conn is not None:
                return self._conn
            conn = sqlite3.connect(
                str(self._db_path),
                check_same_thread=False,
            )
            conn.row_factory = sqlite3.Row
            with conn:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.executescript(_SCHEMA)
            self._conn = conn
            return self._conn

    def insert_messages(
        self,
        session_key: str,
        messages: list[dict[str, Any]],
        reason: str,
    ) -> None:
        """将 messages 逐条写入 SQLite；失败只记 warning，不抛出。"""
        if not messages:
            return
        conn = self._ensure_conn()
        if conn is None:
            return
        trimmed_at = datetime.now(timezone.utc).isoformat()
        rows: list[tuple[Any, ...]] = []
        for message in messages:
            raw_json = json.dumps(message, ensure_ascii=False)
            msg_ts = message.get("timestamp", "") or ""
            rows.append((
                session_key,
                trimmed_at,
                reason,
                str(message.get("role", "unknown")),
                _content_text_for_row(message, raw_json),
                raw_json,
                msg_ts,
            ))
        try:
            with self._lock:
                with conn:
                    # 保证旧库有 msg_timestamp 列
                    conn.executescript(
                        "ALTER TABLE session_messages ADD COLUMN msg_timestamp TEXT NOT NULL DEFAULT ''"
                    )
        except Exception:
            pass  # 列已存在，忽略

        try:
            with self._lock:
                with conn:
                    conn.executemany(
                        """
                        INSERT INTO session_messages (
                            session_key, trimmed_at, reason, role, content_text, raw_json, msg_timestamp
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        rows,
                    )
        except Exception:
            logger.warning(
                "SessionHistoryStore: failed to insert {} messages for {} ({})",
                len(messages),
                session_key,
                reason,
            )

    def search(
        self,
        query: str,
        *,
        session_key: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """关键词检索历史消息，返回带 snippet 的结果列表。"""
        if not query.strip():
            return []

        conn = self._ensure_conn()
        if conn is None:
            return []

        capped_limit = max(1, min(limit, _MAX_SEARCH_LIMIT))
        clauses = ["content_text LIKE ? COLLATE NOCASE"]
        params: list[Any] = [f"%{query}%"]

        if session_key:
            clauses.append("session_key = ?")
            params.append(session_key)
        if since:
            clauses.append("msg_timestamp >= ?")
            params.append(since)
        if until:
            clauses.append("msg_timestamp <= ?")
            params.append(_normalize_until(until))

        sql = f"""
            SELECT session_key, trimmed_at, msg_timestamp, role, content_text
            FROM session_messages
            WHERE {" AND ".join(clauses)}
            ORDER BY msg_timestamp DESC
            LIMIT ?
        """
        params.append(capped_limit)

        try:
            with self._lock:
                cursor = conn.execute(sql, params)
                rows = cursor.fetchall()
        except Exception:
            logger.warning("SessionHistoryStore: search failed for query={!r}", query)
            return []

        results: list[dict[str, Any]] = []
        for row in rows:
            content_text = row["content_text"] or ""
            display_text = content_text
            if len(display_text) > _RESULT_CONTENT_MAX:
                display_text = display_text[: _RESULT_CONTENT_MAX - 1] + "…"
            results.append({
                "session_key": row["session_key"],
                "trimmed_at": row["trimmed_at"],
                "msg_timestamp": row["msg_timestamp"],
                "role": row["role"],
                "content_text": display_text,
                "snippet": _make_snippet(content_text, query),
            })
        return results
