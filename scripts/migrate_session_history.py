#!/usr/bin/env python3
"""一次性迁移脚本：legacy last_consolidated 前缀 + sessions/archive/*.jsonl → history.db

用法:
  # 预览（默认不写盘）
  python scripts/migrate_session_history.py

  # 执行迁移
  python scripts/migrate_session_history.py --apply

  # 指定 workspace 或 sessions 目录
  python scripts/migrate_session_history.py --workspace ~/my-ws --apply
  python scripts/migrate_session_history.py --sessions-dir ~/.nanobot/sessions --apply

  # 同时迁移 legacy 全局 sessions 目录
  python scripts/migrate_session_history.py --include-legacy --apply
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from nanobot.config.paths import get_legacy_sessions_dir, get_workspace_path
from nanobot.session.history_store import _SCHEMA, _content_text_for_row
from nanobot.session.manager import Session
from nanobot.utils.helpers import ensure_dir

_ARCHIVE_SCHEMA = _SCHEMA


@dataclass
class MigrationStats:
    sessions_scanned: int = 0
    sessions_trimmed: int = 0
    prefix_messages: int = 0
    archive_files: int = 0
    archive_records: int = 0
    archive_messages: int = 0
    sqlite_inserted: int = 0
    sqlite_skipped_dedup: int = 0
    errors: list[str] = field(default_factory=list)


def _infer_key_from_stem(stem: str) -> str:
    if "_" in stem:
        return stem.replace("_", ":", 1)
    return stem


def _load_session(path: Path) -> Session | None:
    messages: list[dict[str, Any]] = []
    metadata: dict[str, Any] = {}
    created_at: datetime | None = None
    updated_at: datetime | None = None
    key: str | None = None
    last_consolidated = 0

    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                data = json.loads(line)
                if data.get("_type") == "metadata":
                    key = data.get("key")
                    metadata = data.get("metadata", {})
                    last_consolidated = int(data.get("last_consolidated", 0) or 0)
                    if data.get("created_at"):
                        created_at = datetime.fromisoformat(data["created_at"])
                    if data.get("updated_at"):
                        updated_at = datetime.fromisoformat(data["updated_at"])
                else:
                    messages.append(data)
    except Exception as exc:
        return None

    if not key:
        key = _infer_key_from_stem(path.stem)

    now = datetime.now(timezone.utc).astimezone()
    return Session(
        key=key,
        messages=messages,
        created_at=created_at or now,
        updated_at=updated_at or now,
        metadata=metadata,
        last_consolidated=last_consolidated,
    )


def _save_session(path: Path, session: Session) -> None:
    tmp_path = path.with_suffix(".jsonl.tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        metadata_line = {
            "_type": "metadata",
            "key": session.key,
            "created_at": session.created_at.isoformat(),
            "updated_at": session.updated_at.isoformat(),
            "metadata": session.metadata,
            "last_consolidated": session.last_consolidated,
        }
        f.write(json.dumps(metadata_line, ensure_ascii=False) + "\n")
        for msg in session.messages:
            f.write(json.dumps(msg, ensure_ascii=False) + "\n")
    os.replace(tmp_path, path)


def _open_history_db(sessions_dir: Path) -> sqlite3.Connection:
    db_path = ensure_dir(sessions_dir) / "history.db"
    conn = sqlite3.connect(str(db_path))
    with conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_ARCHIVE_SCHEMA)
    return conn


def _raw_exists(conn: sqlite3.Connection, session_key: str, raw_json: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM session_messages WHERE session_key = ? AND raw_json = ? LIMIT 1",
        (session_key, raw_json),
    ).fetchone()
    return row is not None


def _insert_messages(
    conn: sqlite3.Connection,
    session_key: str,
    messages: list[dict[str, Any]],
    reason: str,
    trimmed_at: str,
    *,
    dedup: bool,
    stats: MigrationStats,
) -> None:
    rows: list[tuple[Any, ...]] = []
    for message in messages:
        raw_json = json.dumps(message, ensure_ascii=False)
        if dedup and _raw_exists(conn, session_key, raw_json):
            stats.sqlite_skipped_dedup += 1
            continue
        rows.append((
            session_key,
            trimmed_at,
            reason,
            str(message.get("role", "unknown")),
            _content_text_for_row(message, raw_json),
            raw_json,
        ))

    if not rows:
        return

    with conn:
        conn.executemany(
            """
            INSERT INTO session_messages (
                session_key, trimmed_at, reason, role, content_text, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
    stats.sqlite_inserted += len(rows)


def _iter_session_files(sessions_dir: Path) -> Iterator[Path]:
    for path in sorted(sessions_dir.glob("*.jsonl")):
        name = path.name
        if name.endswith(".tmp") or name.endswith(".pre-migrate-bak"):
            continue
        yield path


def _iter_archive_files(sessions_dir: Path) -> Iterator[Path]:
    archive_dir = sessions_dir / "archive"
    if not archive_dir.is_dir():
        return
    yield from sorted(archive_dir.glob("*.jsonl"))


def migrate_last_consolidated_prefixes(
    sessions_dir: Path,
    conn: sqlite3.Connection | None,
    *,
    apply: bool,
    dedup: bool,
    backup: bool,
    stats: MigrationStats,
) -> None:
    trimmed_at = datetime.now(timezone.utc).isoformat()
    reason = "legacy_consolidated_prefix"

    for path in _iter_session_files(sessions_dir):
        stats.sessions_scanned += 1
        session = _load_session(path)
        if session is None:
            stats.errors.append(f"failed to load session file: {path}")
            continue

        lc = session.last_consolidated
        if lc <= 0:
            continue
        if lc > len(session.messages):
            stats.errors.append(
                f"{session.key}: last_consolidated={lc} > messages={len(session.messages)}, reset only",
            )
            lc = len(session.messages)

        prefix = list(session.messages[:lc])
        if not prefix:
            if apply:
                session.last_consolidated = 0
                session.updated_at = datetime.now(timezone.utc).astimezone()
                if backup:
                    shutil.copy2(path, path.with_suffix(".jsonl.pre-migrate-bak"))
                _save_session(path, session)
            stats.sessions_trimmed += 1
            continue

        stats.prefix_messages += len(prefix)
        stats.sessions_trimmed += 1

        if not apply:
            continue

        assert conn is not None
        _insert_messages(
            conn,
            session.key,
            prefix,
            reason,
            trimmed_at,
            dedup=dedup,
            stats=stats,
        )

        session.messages = session.messages[lc:]
        session.last_consolidated = 0
        session.updated_at = datetime.now(timezone.utc).astimezone()

        if backup:
            shutil.copy2(path, path.with_suffix(".jsonl.pre-migrate-bak"))
        _save_session(path, session)


def migrate_archive_jsonl(
    sessions_dir: Path,
    conn: sqlite3.Connection | None,
    *,
    apply: bool,
    dedup: bool,
    stats: MigrationStats,
) -> None:
    for path in _iter_archive_files(sessions_dir):
        stats.archive_files += 1
        try:
            with open(path, encoding="utf-8") as f:
                lines = f.readlines()
        except OSError as exc:
            stats.errors.append(f"failed to read archive {path}: {exc}")
            continue

        for line_no, line in enumerate(lines, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                stats.errors.append(f"{path}:{line_no}: invalid json: {exc}")
                continue

            if record.get("_type") != "trim_archive":
                continue

            stats.archive_records += 1
            session_key = str(record.get("session_key") or "")
            messages = record.get("messages")
            if not session_key or not isinstance(messages, list) or not messages:
                stats.errors.append(f"{path}:{line_no}: skip empty trim_archive record")
                continue

            trimmed_at = str(record.get("trimmed_at") or datetime.now(timezone.utc).isoformat())
            reason = str(record.get("reason") or "archive_migration")
            stats.archive_messages += len(messages)

            if not apply:
                continue

            assert conn is not None
            _insert_messages(
                conn,
                session_key,
                messages,
                reason,
                trimmed_at,
                dedup=dedup,
                stats=stats,
            )


def _print_stats(label: str, stats: MigrationStats, *, apply: bool) -> None:
    mode = "APPLY" if apply else "DRY-RUN"
    print(f"\n=== {label} ({mode}) ===")
    print(f"  sessions scanned:      {stats.sessions_scanned}")
    print(f"  sessions trimmed:        {stats.sessions_trimmed}")
    print(f"  prefix messages:         {stats.prefix_messages}")
    print(f"  archive files:           {stats.archive_files}")
    print(f"  archive records:         {stats.archive_records}")
    print(f"  archive messages:        {stats.archive_messages}")
    if apply:
        print(f"  sqlite inserted:         {stats.sqlite_inserted}")
        print(f"  sqlite skipped (dedup):  {stats.sqlite_skipped_dedup}")
    if stats.errors:
        print(f"  errors ({len(stats.errors)}):")
        for err in stats.errors[:20]:
            print(f"    - {err}")
        if len(stats.errors) > 20:
            print(f"    ... and {len(stats.errors) - 20} more")


def _resolve_targets(args: argparse.Namespace) -> list[tuple[str, Path]]:
    targets: list[tuple[str, Path]] = []

    if args.sessions_dir is not None:
        targets.append(("custom", args.sessions_dir.expanduser().resolve()))
    else:
        workspace = get_workspace_path(str(args.workspace) if args.workspace else None)
        targets.append((f"workspace:{workspace}", (workspace / "sessions").resolve()))

    if args.include_legacy:
        legacy = get_legacy_sessions_dir().resolve()
        if not any(path == legacy for _, path in targets):
            targets.append(("legacy", legacy))

    return targets


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="写入 history.db 并裁剪 session 文件（默认仅预览）",
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=None,
        help="workspace 路径（默认 ~/.nanobot/workspace）",
    )
    parser.add_argument(
        "--sessions-dir",
        type=Path,
        default=None,
        help="直接指定 sessions 目录（优先级高于 --workspace）",
    )
    parser.add_argument(
        "--include-legacy",
        action="store_true",
        help="同时迁移 ~/.nanobot/sessions",
    )
    parser.add_argument(
        "--no-dedup",
        action="store_true",
        help="插入 SQLite 时不按 raw_json 去重",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="裁剪 session 文件前不创建 .pre-migrate-bak 备份",
    )
    parser.add_argument(
        "--prefix-only",
        action="store_true",
        help="仅迁移 last_consolidated 前缀，跳过 archive/",
    )
    parser.add_argument(
        "--archive-only",
        action="store_true",
        help="仅迁移 sessions/archive/*.jsonl，跳过 session 裁剪",
    )
    args = parser.parse_args(argv)

    if args.prefix_only and args.archive_only:
        parser.error("--prefix-only 与 --archive-only 不能同时使用")

    apply = args.apply
    dedup = not args.no_dedup
    backup = not args.no_backup

    if not apply:
        print("DRY-RUN 模式：加 --apply 才会写入 history.db 并裁剪 session 文件\n")

    exit_code = 0
    for label, sessions_dir in _resolve_targets(args):
        print(f"Target: {label} → {sessions_dir}")
        if not sessions_dir.is_dir():
            print(f"  skip: directory does not exist\n")
            continue

        stats = MigrationStats()
        conn: sqlite3.Connection | None = None
        if apply:
            conn = _open_history_db(sessions_dir)
        try:
            if not args.archive_only:
                migrate_last_consolidated_prefixes(
                    sessions_dir,
                    conn,
                    apply=apply,
                    dedup=dedup,
                    backup=backup,
                    stats=stats,
                )
            if not args.prefix_only:
                migrate_archive_jsonl(
                    sessions_dir,
                    conn,
                    apply=apply,
                    dedup=dedup,
                    stats=stats,
                )
            if apply and conn is not None:
                conn.commit()
        finally:
            if conn is not None:
                conn.close()

        _print_stats(label, stats, apply=apply)
        if stats.errors:
            exit_code = 1

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
