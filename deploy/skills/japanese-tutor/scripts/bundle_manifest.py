#!/usr/bin/env python3
"""生成并验证 japanese-tutor bundle 的文件清单与 SHA-256。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

MANIFEST = "bundle-manifest.json"
FORBIDDEN = {".apkg", ".anki2", ".colpkg", ".pdf", ".mp3", ".wav"}


def bundle_files(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.name != MANIFEST
        and "__pycache__" not in path.parts
        and not path.name.endswith((".pyc", ".private.json"))
    )


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def scan(root: Path) -> None:
    bad = [path for path in bundle_files(root) if path.suffix.lower() in FORBIDDEN]
    if bad:
        raise ValueError(
            "bundle 包含禁止文件: " + ", ".join(str(path.relative_to(root)) for path in bad)
        )


def scan_repo(repo: Path) -> None:
    result = subprocess.run(["git", "ls-files", "-z"], cwd=repo, capture_output=True, check=True)
    names = [name.decode() for name in result.stdout.split(b"\0") if name]
    bad = [
        name
        for name in names
        if Path(name).suffix.lower() in {".apkg", ".anki2", ".colpkg"}
        or name.endswith(".private.json")
    ]
    if bad:
        raise ValueError("仓库包含私人或牌组文件: " + ", ".join(bad))


def create(root: Path, output: Path) -> dict:
    scan(root)
    data = {
        "schema_version": 1,
        "files": {str(path.relative_to(root)): digest(path) for path in bundle_files(root)},
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temp_name, output)
    return data


def verify(root: Path, manifest: Path) -> dict:
    expected = json.loads(manifest.read_text(encoding="utf-8"))
    actual = {str(path.relative_to(root)): digest(path) for path in bundle_files(root)}
    if expected.get("files") != actual:
        raise ValueError("bundle checksum 不一致")
    return expected


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("create", "verify", "scan-repo"))
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    manifest = args.manifest or args.root / MANIFEST
    try:
        result = (
            scan_repo(args.root)
            if args.action == "scan-repo"
            else create(args.root, manifest)
            if args.action == "create"
            else verify(args.root, manifest)
        )
        print(
            json.dumps(
                {"ok": True, "files": len(result.get("files", {})) if result else 0},
                ensure_ascii=False,
            )
        )
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
