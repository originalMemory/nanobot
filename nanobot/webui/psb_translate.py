"""PSB 模型日文标签翻译。"""

from __future__ import annotations

import json
import re
from typing import Any

from loguru import logger

_JP_RE = re.compile(r"[\u3040-\u30ff\u4e00-\u9fff]")


def labels_need_translation(labels: list[str]) -> list[str]:
    """筛选可能需要翻译的标签（含假名/汉字）。"""
    unique: list[str] = []
    seen: set[str] = set()
    for label in labels:
        text = str(label or "").strip()
        if not text or text in seen:
            continue
        if _JP_RE.search(text):
            unique.append(text)
            seen.add(text)
    return unique


async def translate_psb_labels(labels: list[str]) -> tuple[dict[str, str], str]:
    """调用当前配置的 LLM 将日文标签翻译为中文。返回 (映射, status)。"""
    pending = labels_need_translation(labels)
    if not pending:
        return {}, "skipped"

    try:
        from nanobot.config.loader import load_config
        from nanobot.providers.factory import _make_provider_core
    except Exception:
        logger.debug("PSB translate: provider unavailable")
        return {}, "failed"

    try:
        config = load_config()
        provider = _make_provider_core(config)
        model = config.agents.defaults.model
    except Exception as exc:
        logger.debug("PSB translate setup failed: {}", exc)
        return {}, "failed"

    prompt = (
        "将以下 E-mote/PSB 模型中的日文标签翻译为简短中文，用于 UI 展示。"
        "保持专有名词可读，输出 JSON 对象：键为原文，值为中文。"
        "只输出 JSON，不要解释。\n\n"
        + json.dumps(pending, ensure_ascii=False)
    )
    try:
        response = await provider.chat(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            max_tokens=2048,
            temperature=0.2,
        )
    except Exception as exc:
        logger.debug("PSB translate LLM call failed: {}", exc)
        return {}, "failed"

    content = (response.content or "").strip()
    if not content:
        return {}, "failed"

    # 提取 JSON 对象
    start = content.find("{")
    end = content.rfind("}")
    if start < 0 or end <= start:
        return {}, "failed"
    try:
        parsed = json.loads(content[start : end + 1])
    except json.JSONDecodeError:
        return {}, "failed"
    if not isinstance(parsed, dict):
        return {}, "failed"

    mapping: dict[str, str] = {}
    for key, value in parsed.items():
        if isinstance(key, str) and isinstance(value, str) and key.strip() and value.strip():
            mapping[key.strip()] = value.strip()
    if not mapping:
        return {}, "failed"
    return mapping, "done"
