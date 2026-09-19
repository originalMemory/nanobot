#!/usr/bin/env python3
"""可断点续跑地从六册扫描 PDF 提取页级课程候选。"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from curriculum_state import state_lock

SCHEMA_VERSION = 1
MANIFEST_VERSION = 1
EXTRACTOR_VERSION = "2026-08-25.3"
PAGE_KINDS = {
    "unit-overview", "basic-text", "grammar", "expression", "applied-text",
    "exercise", "vocabulary", "contents", "appendix", "other",
}
LEVELS = {"初级": "beginner", "中级": "intermediate", "高级": "advanced"}
UNIT_RANGES = {
    "beginner-up": range(1, 7), "beginner-down": range(7, 13),
    "intermediate-up": range(1, 5), "intermediate-down": range(5, 9),
    "advanced-up": range(1, 4), "advanced-down": range(4, 7),
}
LESSON_RANGES = {
    "beginner-up": range(1, 25), "beginner-down": range(25, 49),
    "intermediate-up": range(1, 17), "intermediate-down": range(17, 33),
    "advanced-up": range(1, 13), "advanced-down": range(13, 25),
}
DEFAULT_PROMPT = Path(__file__).resolve().parents[1] / "references" / "pdf-extraction-prompt.md"
DEFAULT_SCHEMA = Path(__file__).resolve().parents[1] / "data" / "page-extraction.schema.json"


class ExtractionError(Exception):
    pass


def atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def infer_book(path: Path) -> tuple[str, str, str]:
    level = next((value for name, value in LEVELS.items() if name in path.parts), None)
    if level is None:
        raise ExtractionError(f"无法从目录判断级别: {path}")
    name = path.stem
    if "下" in name:
        volume = "down"
    elif "上" in name:
        volume = "up"
    else:
        raise ExtractionError(f"无法从文件名判断上下册: {path}")
    return f"{level}-{volume}", level, volume


def find_poppler(name: str, override: Path | None) -> Path:
    if override:
        candidate = override / f"{name}.exe"
        if not candidate.exists():
            candidate = override / name
        if candidate.exists():
            return candidate
    found = shutil.which(name)
    if found:
        return Path(found)
    bundled = (
        Path.home() / ".cache" / "codex-runtimes" / "codex-primary-runtime" /
        "dependencies" / "native" / "poppler" / "Library" / "bin" / f"{name}.exe"
    )
    if bundled.exists():
        return bundled
    raise ExtractionError(f"找不到 {name}；请安装 Poppler 或传 --poppler-bin")


def pdf_page_count(pdfinfo: Path, pdf: Path) -> int:
    result = subprocess.run(
        [str(pdfinfo), str(pdf)], capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if result.returncode != 0:
        raise ExtractionError(f"pdfinfo 失败: {pdf.name}: {result.stderr.strip()}")
    for line in result.stdout.splitlines():
        if line.startswith("Pages:"):
            return int(line.split(":", 1)[1].strip())
    raise ExtractionError(f"pdfinfo 未返回页数: {pdf.name}")


def detect_text_layer(pdf: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:
        return "unknown"
    reader = PdfReader(pdf)
    samples = [
        " ".join((reader.pages[index].extract_text() or "").replace("\x00", " ").split())
        for index in range(min(5, len(reader.pages)))
    ]
    return classify_text_samples(samples)


def classify_text_samples(samples: list[str]) -> str:
    meaningful = [sample for sample in samples if len(sample) >= 40]
    if not meaningful:
        return "absent"
    if len(meaningful) > 1 and len(set(meaningful)) == 1:
        return "absent"
    return "present"


def extractor_fingerprint(model: str, prompt: str, schema: dict[str, Any]) -> dict[str, str]:
    return {
        "extractor_version": EXTRACTOR_VERSION,
        "model": model,
        "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "schema_sha256": hashlib.sha256(
            json.dumps(schema, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest(),
    }


def scan_books(
    pdf_root: Path,
    work_dir: Path,
    pdfinfo: Path,
    extractor: dict[str, str],
) -> dict[str, Any]:
    pdfs = sorted(pdf_root.rglob("*.pdf"))
    if len(pdfs) != 6:
        raise ExtractionError(f"预期六册 PDF，实际找到 {len(pdfs)} 册")
    old = load_manifest(work_dir, required=False)
    old_books = {book["id"]: book for book in old.get("books", [])} if old else {}
    books = []
    seen: set[str] = set()
    for pdf in pdfs:
        book_id, level, volume = infer_book(pdf)
        if book_id in seen:
            raise ExtractionError(f"书册 ID 重复: {book_id}")
        seen.add(book_id)
        stat = pdf.stat()
        fingerprint = {
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
            "sha256": file_sha256(pdf),
        }
        pages = pdf_page_count(pdfinfo, pdf)
        previous = old_books.get(book_id, {})
        reusable = previous.get("fingerprint") == fingerprint and old.get("extractor") == extractor
        states = previous.get("page_states", {}) if reusable else {}
        for page in range(1, pages + 1):
            key = str(page)
            if key not in states or states[key].get("status") == "running":
                states[key] = {"status": "pending", "attempts": states.get(key, {}).get("attempts", 0)}
        books.append(
            {
                "id": book_id,
                "level": level,
                "volume": volume,
                "path": str(pdf.resolve()),
                "pages": pages,
                "text_layer": detect_text_layer(pdf),
                "fingerprint": fingerprint,
                "page_states": states,
            }
        )
    manifest = {"manifest_version": MANIFEST_VERSION, "extractor": extractor, "books": books}
    atomic_write_json(work_dir / "manifest.json", manifest)
    return manifest


def load_manifest(work_dir: Path, *, required: bool = True) -> dict[str, Any]:
    path = work_dir / "manifest.json"
    if not path.exists():
        if required:
            raise ExtractionError("manifest 不存在，请先运行 scan 或 extract")
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExtractionError(f"manifest 无效: {exc}") from exc
    if not isinstance(data, dict) or data.get("manifest_version") != MANIFEST_VERSION:
        raise ExtractionError("manifest 版本无效")
    return data


def render_page(pdftoppm: Path, pdf: Path, page: int, output: Path, dpi: int) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [str(pdftoppm), "-f", str(page), "-l", str(page), "-singlefile", "-png", "-r", str(dpi), str(pdf), str(output)]
    )
    image = output.with_suffix(".png")
    if result.returncode != 0 or not image.exists():
        raise ExtractionError(f"页面渲染失败: {pdf.name}#{page}")
    return image


def call_ollama(
    url: str,
    model: str,
    prompt: str,
    schema: dict[str, Any],
    image: Path,
    book_id: str,
    page: int,
    timeout: float,
) -> dict[str, Any]:
    content = f"书册: {book_id}\nPDF 页码: {page}\n\n{prompt}"
    body = json.dumps(
        {
            "model": model,
            "stream": False,
            "format": schema,
            "messages": [{"role": "user", "content": content, "images": [base64.b64encode(image.read_bytes()).decode("ascii")]}],
            "options": {"temperature": 0.1, "num_ctx": 16384},
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = Request(url.rstrip("/") + "/api/chat", data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise ExtractionError(f"Ollama 请求失败: {type(exc).__name__}: {exc}") from exc
    try:
        result = json.loads(payload["message"]["content"])
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ExtractionError("Ollama 未返回有效结构化 JSON") from exc
    return validate_page_result(result, book_id, page)


def validate_page_result(data: Any, book_id: str, page: int) -> dict[str, Any]:
    required_lists = (
        "section_titles", "grammar_points", "communication_functions", "pragmatics",
        "vocabulary_domains", "exercise_types", "uncertain",
    )
    if not isinstance(data, dict) or data.get("page_kind") not in PAGE_KINDS:
        raise ExtractionError("页级结果缺少有效 page_kind")
    if any(not isinstance(data.get(name), list) for name in required_lists):
        raise ExtractionError("页级结果数组字段无效")
    for key in ("unit", "lesson"):
        if data.get(key) is not None and not isinstance(data[key], int):
            raise ExtractionError(f"页级结果 {key} 无效")
    if not isinstance(data.get("continuation"), bool):
        raise ExtractionError("页级结果 continuation 无效")
    for point in data["grammar_points"]:
        if not isinstance(point, dict) or not all(
            isinstance(point.get(name), str) for name in ("pattern", "function_cn", "formation")
        ):
            raise ExtractionError("grammar_points 结构无效")
        if not all(isinstance(point.get(name), list) for name in ("constraints", "contrasts")):
            raise ExtractionError("grammar_points 数组无效")
    data["schema_version"] = SCHEMA_VERSION
    data["source"] = {"book_id": book_id, "pdf_page": page, "printed_page": data.get("source", {}).get("printed_page") if isinstance(data.get("source"), dict) else None}
    data["page_kind"] = normalized_page_kind(data["page_kind"], data["section_titles"])
    for field, allowed in (("unit", UNIT_RANGES[book_id]), ("lesson", LESSON_RANGES[book_id])):
        if data.get(field) is not None and data[field] not in allowed:
            data["uncertain"].append(f"模型给出的 {field}={data[field]} 超出书册范围，已置空")
            data[field] = None
    data["verification"] = "candidate"
    return data


def normalized_page_kind(original: str, section_titles: list[Any]) -> str:
    primary = str(section_titles[0]) if section_titles else ""
    titles = " ".join(str(title) for title in section_titles)
    mappings = (
        (("基本课文", "基本課文"), "basic-text"),
        (("语法解释", "語法解釈", "解説"), "grammar"),
        (("表达及词语讲解", "表現と語彙"), "expression"),
        (("应用课文", "応用課文"), "applied-text"),
        (("生词表", "生詞表", "新出語彙"), "vocabulary"),
        (("练习", "練習"), "exercise"),
        (("目录", "目次"), "contents"),
    )
    for markers, page_kind in mappings:
        if any(marker in primary for marker in markers):
            return page_kind
    for markers, page_kind in mappings:
        if any(marker in titles for marker in markers):
            return page_kind
    return original


def select_pages(
    book: dict[str, Any],
    start: int | None,
    end: int | None,
    only_failed: bool,
    forced: set[int],
) -> list[int]:
    lower = max(1, start or 1)
    upper = min(book["pages"], end or book["pages"])
    if forced:
        return sorted(page for page in forced if lower <= page <= upper)
    accepted = {"failed"} if only_failed else {"pending", "failed", "running"}
    return [page for page in range(lower, upper + 1) if book["page_states"][str(page)]["status"] in accepted]


def status_summary(manifest: dict[str, Any]) -> dict[str, Any]:
    books = []
    totals: dict[str, int] = {}
    for book in manifest["books"]:
        counts: dict[str, int] = {}
        for state in book["page_states"].values():
            status = state["status"]
            counts[status] = counts.get(status, 0) + 1
            totals[status] = totals.get(status, 0) + 1
        books.append({"id": book["id"], "pages": book["pages"], "states": counts})
    return {"books": books, "totals": totals}


def extract(args: argparse.Namespace) -> int:
    prompt = args.prompt.read_text(encoding="utf-8")
    schema = json.loads(args.schema.read_text(encoding="utf-8"))
    fingerprint = extractor_fingerprint(args.model, prompt, schema)
    pdfinfo = find_poppler("pdfinfo", args.poppler_bin)
    pdftoppm = find_poppler("pdftoppm", args.poppler_bin)
    manifest = scan_books(args.pdf_root, args.work_dir, pdfinfo, fingerprint)
    selected_books = [book for book in manifest["books"] if not args.book or book["id"] == args.book]
    if args.book and not selected_books:
        raise ExtractionError(f"未知书册: {args.book}")
    if args.force_page and len(selected_books) != 1:
        raise ExtractionError("--force-page 必须配合单个 --book")
    processed = failures = 0
    with state_lock(args.work_dir / "extract-curriculum"):
        for book in selected_books:
            pages = select_pages(book, args.from_page, args.to_page, args.only_failed, set(args.force_page))
            for page in pages:
                if args.max_pages and processed >= args.max_pages:
                    atomic_write_json(args.work_dir / "manifest.json", manifest)
                    return 1 if failures else 0
                state = book["page_states"][str(page)]
                state.update({"status": "running", "attempts": state.get("attempts", 0) + 1})
                state.pop("error", None)
                atomic_write_json(args.work_dir / "manifest.json", manifest)
                prefix = args.work_dir / "renders" / book["id"] / f"page-{page:04d}"
                image = prefix.with_suffix(".png")
                try:
                    render_page(pdftoppm, Path(book["path"]), page, prefix, args.dpi)
                    result = call_ollama(args.ollama_url, args.model, prompt, schema, image, book["id"], page, args.timeout)
                    atomic_write_json(args.work_dir / "pages" / book["id"] / f"page-{page:04d}.json", result)
                    state["status"] = "completed"
                    print(f"[{book['id']}] {page}/{book['pages']} completed", flush=True)
                except (ExtractionError, OSError, json.JSONDecodeError) as exc:
                    state.update({"status": "failed", "error": str(exc)[:500]})
                    failures += 1
                    print(f"[{book['id']}] {page}/{book['pages']} failed: {exc}", file=sys.stderr, flush=True)
                finally:
                    if image.exists() and not args.keep_images:
                        image.unlink()
                    atomic_write_json(args.work_dir / "manifest.json", manifest)
                processed += 1
    return 1 if failures else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("scan", "status", "extract"))
    parser.add_argument("--pdf-root", type=Path, default=Path(r"D:\标准日本语"))
    parser.add_argument("--work-dir", type=Path, default=Path(r"D:\标准日本语\.nanobot-extract"))
    parser.add_argument("--model", default="qwen3.8:27b")
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--prompt", type=Path, default=DEFAULT_PROMPT)
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA)
    parser.add_argument("--poppler-bin", type=Path)
    parser.add_argument("--book", choices=("beginner-up", "beginner-down", "intermediate-up", "intermediate-down", "advanced-up", "advanced-down"))
    parser.add_argument("--from-page", type=int)
    parser.add_argument("--to-page", type=int)
    parser.add_argument("--only-failed", action="store_true")
    parser.add_argument("--force-page", type=int, action="append", default=[])
    parser.add_argument("--max-pages", type=int)
    parser.add_argument("--dpi", type=int, default=140)
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--keep-images", action="store_true")
    return parser


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = build_parser().parse_args()
    try:
        if args.action == "status":
            print(json.dumps(status_summary(load_manifest(args.work_dir)), ensure_ascii=False, indent=2))
            return 0
        prompt = args.prompt.read_text(encoding="utf-8")
        schema = json.loads(args.schema.read_text(encoding="utf-8"))
        fingerprint = extractor_fingerprint(args.model, prompt, schema)
        if args.action == "scan":
            manifest = scan_books(args.pdf_root, args.work_dir, find_poppler("pdfinfo", args.poppler_bin), fingerprint)
            print(json.dumps(status_summary(manifest), ensure_ascii=False, indent=2))
            return 0
        return extract(args)
    except (ExtractionError, OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
