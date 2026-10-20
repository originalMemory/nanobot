"""语音文本确定性清洗与中日分段辅助。

- ``clean_for_tts``：Markdown 符号、动作括号、路径/代码块压缩（程序侧确定性处理）。
- ``contains_kana``：假名布尔检测，作为日文片段触发的唯一判据（不做字符级扩展）。
- ``validate_language_tags``：标签全覆盖校验，与 provider ``_split_language_segments`` 同规则。
"""

from __future__ import annotations

import re

# 平假名 U+3040–U+309F、片假名 U+30A0–U+30FF：日语独有指纹。
_KANA_RE = re.compile(r"[\u3040-\u309F\u30A0-\u30FF]")

_CODE_BLOCK_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
_HEADING_RE = re.compile(r"(?m)^\s{0,3}#{1,6}\s+")
_LIST_RE = re.compile(r"(?m)^\s{0,3}(?:[-*+]|\d+[.)])\s+")
_QUOTE_RE = re.compile(r"(?m)^\s{0,3}>\s?")
_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_URL_RE = re.compile(r"https?://\S+")
_TABLE_ROW_RE = re.compile(r"(?m)^\s*\|.*\|\s*$")
_TABLE_SEP_RE = re.compile(r"(?m)^\s*\|[\s:\-|]+\|\s*$")

# 动作/表情白名单：括号内容命中任一才删除，信息性括号（日期、数值、补充）保留。
_ACTION_WORDS = (
    "摇尾", "叹气", "眨眼", "拍", "戳", "抱", "歪", "嘟", "翻", "搓", "吐",
    "挥", "伸", "舔", "望", "盯", "敲", "跳", "蹭", "飘", "甩", "点头", "擦",
    "揉", "低头", "抬头", "摊手", "耸肩", "笑", "皱眉", "撇嘴",
)
_ACTION_PAREN_RE = re.compile(r"[（(]([^（()）]{1,24})[）)]")

# 绝对路径 / 文件名形态（/nas/...、~/.nanobot/...、C:\...）：压缩为占位。
_PATH_RE = re.compile(
    r"(?<![\w])(?:/(?:[\w.-]+/)+[\w.-]+|~/(?:[\w.-]+/)*[\w.-]+|[A-Za-z]:\\[\w.\\-]+)"
)

_LANG_TAG_RE = re.compile(r"\[(zh|ja)\](.*?)\[/\1\]", re.IGNORECASE | re.DOTALL)


def contains_kana(text: str) -> bool:
    """含平假名或片假名即返回 True（日文触发检测，不扩展边界）。"""
    return bool(_KANA_RE.search(text))


def clean_for_tts(text: str) -> str:
    """确定性清洗：去代码块/Markdown 符号/URL/动作括号，压缩路径，整理空白。"""
    text = _CODE_BLOCK_RE.sub("", text)
    text = _INLINE_CODE_RE.sub("", text)
    text = _BOLD_RE.sub(r"\1", text)
    text = _LINK_RE.sub(r"\1", text)
    text = _URL_RE.sub("", text)
    text = _TABLE_SEP_RE.sub("", text)

    def _table(row: re.Match[str]) -> str:
        cells = [cell.strip() for cell in row.group(0).strip("|").split("|")]
        return "、".join(cell for cell in cells if cell)

    text = _TABLE_ROW_RE.sub(_table, text)
    text = _HEADING_RE.sub("", text)
    text = _LIST_RE.sub("", text)
    text = _QUOTE_RE.sub("", text)
    text = _ACTION_PAREN_RE.sub(
        lambda m: "" if any(word in m.group(1) for word in _ACTION_WORDS) else m.group(0),
        text,
    )
    text = _PATH_RE.sub("路径省略", text)

    lines: list[str] = []
    prev_blank = False
    for raw in text.splitlines():
        line = re.sub(r"[ \t]+", " ", raw).strip()
        if not line:
            if not prev_blank:
                lines.append("")
            prev_blank = True
        else:
            lines.append(line)
            prev_blank = False
    return "\n".join(lines).strip()


def validate_language_tags(text: str) -> bool:
    """标签合法性：无标签（整段中文）合法；有标签必须覆盖全部文本。

    与 provider ``_split_language_segments`` 的硬校验同规则——未标注残留会导致
    ``ValueError("中日混合 TTS 存在未标注文本")``。
    """
    if not _LANG_TAG_RE.search(text):
        return True
    matches = list(_LANG_TAG_RE.finditer(text))
    if not matches:
        return False
    cursor = 0
    for match in matches:
        if text[cursor:match.start()].strip():
            return False
        cursor = match.end()
    return not text[cursor:].strip()
