"""日记搜索工具（grep 实现）。

用 grep 搜索 Obsidian 日记 markdown 文件，替代旧数据库索引查询。
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


def canonical_diary_files(files: set[str]) -> set[str]:
    """冲突副本不作记忆证据，同一文件的链接只保留一份。"""
    canonical: dict[Path, str] = {}
    for filename in sorted(files):
        path = Path(filename)
        if ".sync-conflict-" not in path.name:
            canonical.setdefault(path.resolve(), filename)
    return set(canonical.values())


def diary_body(content: str) -> str:
    """去掉日记元数据、引言、天气与导航，保留生活正文。"""
    content = re.sub(r"\A---\s*\n.*?\n---[^\n]*(?:\n|$)", "", content, count=1, flags=re.S)
    content = re.split(r"(?m)^# 天气\s*$", content, maxsplit=1)[0]
    lines: list[str] = []
    quote = False
    for line in content.splitlines():
        if re.match(r">\s*\[!quote\]", line):
            quote = True
        if quote and not line.startswith(">"):
            quote = False
        if quote or line.startswith(("概要:", "<< ", "<div ")):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def contains_diary_term(text: str, term: str) -> bool:
    """英文/数值词匹配完整标识，避免 115 命中 1150 或附件哈希。"""
    if not term:
        return False
    pattern = re.escape(term)
    if term[0].isascii() and term[0].isalnum():
        pattern = r"(?<![0-9A-Za-z_])" + pattern
    if term[-1].isascii() and term[-1].isalnum():
        pattern += r"(?![0-9A-Za-z_])"
    return re.search(pattern, text, re.IGNORECASE) is not None


def diary_excerpt(content: str, words: list[str], *, limit: int = 400) -> str:
    """按命中词覆盖选择完整段落，长段落截取命中附近。"""
    paragraphs = re.split(r"\n\s*\n", diary_body(content))
    ranked = sorted(
        ((sum(contains_diary_term(p, w) for w in words), i, p)
         for i, p in enumerate(paragraphs)),
        key=lambda item: (-item[0], item[1]),
    )
    selected: list[str] = []
    for count, _, paragraph in ranked:
        if not count:
            break
        paragraph = " ".join(paragraph.split())
        if len(paragraph) > limit:
            folded = paragraph.casefold()
            offset = min((folded.find(w.casefold()) for w in words
                          if w.casefold() in folded), default=0)
            paragraph = paragraph[max(0, offset - 60):max(0, offset - 60) + limit]
        selected.append(paragraph)
        if sum(map(len, selected)) >= limit:
            break
    return "\n".join(selected)[:limit]


def search_diary_files(
    root: str | Path, word: str, *, include_conflicts: bool = False,
) -> set[str]:
    """完整字面扫描；读取/搜索失败抛出，不能冒充空证据。"""
    root = Path(root).expanduser().resolve()
    if not root.is_dir():
        raise OSError("日记目录不可读")
    command = ["rg", "-l", "-i", "-F", "--hidden", "--no-ignore", "-g", "*.md", "--", word, str(root)]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=10)
    files = {str(Path(name).resolve()) for name in result.stdout.splitlines()
             if Path(name).resolve().is_relative_to(root)}
    if result.returncode not in (0, 1):
        raise subprocess.CalledProcessError(result.returncode, command, output="\n".join(files))
    return files if include_conflicts else canonical_diary_files(files)
