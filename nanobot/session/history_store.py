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
_DEFAULT_SEARCH_LIMIT = 10
_SNIPPET_RADIUS = 120
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


def _make_snippet(content_text: str, keywords: list[str]) -> str:
    """在 content_text 中找到第一个关键词，提取上下文作为 snippet。"""
    if not content_text:
        return ""
    if not keywords:
        return content_text[: _SNIPPET_RADIUS * 2]

    lower_content = content_text.lower()
    best_pos = -1
    best_len = 0
    for kw in keywords:
        pos = lower_content.find(kw.lower())
        if pos != -1 and (best_pos == -1 or pos < best_pos):
            best_pos = pos
            best_len = len(kw)

    if best_pos == -1:
        return content_text[: _SNIPPET_RADIUS * 2]

    start = max(0, best_pos - _SNIPPET_RADIUS)
    end = min(len(content_text), best_pos + best_len + _SNIPPET_RADIUS)
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
        limit: int = _DEFAULT_SEARCH_LIMIT,
    ) -> list[dict[str, Any]]:
        """关键词检索历史消息，返回带 snippet 的结果列表。

        策略与 search_diary 一致：多关键词 AND 优先，不足时 OR 补充；
        各组内按 msg_timestamp 倒序，结果含 match_type 字段（and/or）。
        """
        keywords = query.strip().split()
        if not keywords:
            return []

        conn = self._ensure_conn()
        if conn is None:
            return []

        k = max(1, min(limit, _MAX_SEARCH_LIMIT))

        def _build_filter_clauses() -> tuple[list[str], list[Any]]:
            clauses: list[str] = []
            params: list[Any] = []
            if session_key:
                clauses.append("session_key = ?")
                params.append(session_key)
            if since:
                clauses.append("msg_timestamp >= ?")
                params.append(since)
            if until:
                clauses.append("msg_timestamp <= ?")
                params.append(_normalize_until(until))
            return clauses, params

        def _run_query(operator: str, sql_limit: int | None) -> list[sqlite3.Row]:
            filter_clauses, filter_params = _build_filter_clauses()
            kw_clauses = ["content_text LIKE ? COLLATE NOCASE" for _ in keywords]
            kw_join = f" {'{op}'} ".format(op=operator).join(kw_clauses)
            all_clauses = filter_clauses + [kw_join]
            params = filter_params + [f"%{kw}%" for kw in keywords]
            sql = f"""
                SELECT session_key, trimmed_at, msg_timestamp, role, content_text
                FROM session_messages
                WHERE {" AND ".join(all_clauses)}
                ORDER BY msg_timestamp DESC
            """
            if sql_limit is not None:
                sql += " LIMIT ?"
                params.append(sql_limit)
            try:
                with self._lock:
                    return conn.execute(sql, params).fetchall()
            except Exception:
                logger.warning("SessionHistoryStore: search failed for query={!r}", query)
                return []

        def _rows_to_results(rows: list[sqlite3.Row], match_type: str) -> list[dict[str, Any]]:
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
                    "snippet": _make_snippet(content_text, keywords),
                    "match_type": match_type,
                })
            return results

        and_rows = _run_query("AND", sql_limit=k)
        and_results = _rows_to_results(and_rows, "and")

        if len(and_results) >= k:
            return and_results[:k]

        and_keys = {
            (r["session_key"], r["msg_timestamp"], r["role"])
            for r in and_results
        }
        or_rows = _run_query("OR", sql_limit=None)
        or_results: list[dict[str, Any]] = []
        for row in or_rows:
            key = (row["session_key"], row["msg_timestamp"], row["role"])
            if key in and_keys:
                continue
            or_results.append(_rows_to_results([row], "or")[0])
            if len(and_results) + len(or_results) >= k:
                break

        return and_results + or_results
