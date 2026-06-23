"""PSB 回复标签解析与剥离。"""

from __future__ import annotations

import re
from typing import Any

_PSB_TAG_RE = re.compile(
    r'<psb:(timeline|expression|face|fade)\b([^>]*?)/?>',
    re.IGNORECASE,
)
_ATTR_RE = re.compile(r"""(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")


def _parse_attrs(attr_text: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for match in _ATTR_RE.finditer(attr_text):
        key = match.group(1)
        value = match.group(2) if match.group(2) is not None else match.group(3)
        attrs[key] = value or ""
    return attrs


def parse_psb_tag_actions(text: str) -> list[dict[str, Any]]:
    """从文本中解析 PSB 标签为运行时动作列表。"""
    actions: list[dict[str, Any]] = []
    for match in _PSB_TAG_RE.finditer(text or ""):
        tag_type = match.group(1).lower()
        attrs = _parse_attrs(match.group(2))
        if tag_type in {"timeline", "expression"}:
            name = attrs.get("name") or attrs.get("label") or ""
            if name:
                actions.append({"type": tag_type, "payload": {"name": name}})
        elif tag_type in {"face", "fade"}:
            var_name = attrs.get("var") or attrs.get("name") or ""
            raw_value = attrs.get("value")
            if var_name and raw_value is not None and raw_value != "":
                actions.append(
                    {
                        "type": tag_type,
                        "payload": {"var": var_name, "value": raw_value},
                    }
                )
    return actions


def strip_psb_tags(text: str) -> str:
    """去掉 PSB 特殊标签，用于展示或 TTS。"""
    cleaned = _PSB_TAG_RE.sub("", text or "")
    return re.sub(r"[ \t]{2,}", " ", cleaned).strip()
