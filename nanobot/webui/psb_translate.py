"""PSB 模型日文标签翻译。"""

from __future__ import annotations

import json
import re
import time
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


def parse_translation_mapping(content: str) -> dict[str, str]:
    """从 LLM 回复中提取原文→中文映射。"""
    text = (content or "").strip()
    if not text:
        return {}
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}

    mapping: dict[str, str] = {}
    for key, value in parsed.items():
        if isinstance(key, str) and isinstance(value, str) and key.strip() and value.strip():
            mapping[key.strip()] = value.strip()
    return mapping


def _translation_messages(labels: list[str]) -> list[dict[str, str]]:
    system_prompt = (
        "你是一个专业的日语到简体中文翻译助手，负责翻译 E-mote/PSB 模型中的 UI 标签。\n"
        "要求：\n"
        "1. 翻译要简短自然，适合按钮、下拉框、配置项展示。\n"
        "2. 保留原文中的下划线、数字、英文缩写含义，例如「はい_遅」可译为「是_慢」。\n"
        "3. 不要解释，不要添加 Markdown。\n"
        "4. 只返回 JSON 对象，键为原文，值为中文。"
    )
    user_prompt = "请翻译以下 E-mote/PSB 标签为简体中文：\n" + json.dumps(
        labels,
        ensure_ascii=False,
    )
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]


def _log_empty_translation_response(response: Any, *, model: str, label_count: int) -> None:
    finish = getattr(response, "finish_reason", None)
    reasoning_len = len(getattr(response, "reasoning_content", None) or "")
    if finish == "length" and reasoning_len:
        logger.warning(
            "PSB translate: model {} hit max_tokens during reasoning before content "
            "(labels={}, reasoning_chars={})",
            model,
            label_count,
            reasoning_len,
        )
        return
    logger.warning(
        "PSB translate: model {} returned empty content (finish={}, labels={})",
        model,
        finish,
        label_count,
    )


async def translate_psb_labels(labels: list[str]) -> tuple[dict[str, str], str]:
    """调用当前配置的 LLM 将日文标签翻译为中文。返回 (映射, status)。"""
    pending = labels_need_translation(labels)
    if not pending:
        return {}, "skipped"

    try:
        from nanobot.config.loader import load_config
        from nanobot.providers.factory import build_provider_snapshot
    except Exception as exc:
        logger.warning("PSB translate: provider unavailable: {}", exc)
        return {}, "failed"

    try:
        config = load_config()
        snapshot = build_provider_snapshot(config)
        provider = snapshot.provider
        model = snapshot.model
    except Exception as exc:
        logger.warning("PSB translate setup failed: {}", exc)
        return {}, "failed"

    messages = _translation_messages(pending)
    prompt_chars = sum(len(message["content"]) for message in messages)
    started = time.perf_counter()
    logger.info(
        "PSB translate request: model={}, labels={}, prompt_chars={}, provider={}",
        model,
        len(pending),
        prompt_chars,
        type(provider).__name__,
    )
    try:
        response = await provider.chat_with_retry(
            messages=messages,
            model=model,
            reasoning_effort="none",
        )
    except Exception as exc:
        logger.warning("PSB translate LLM call failed: {}", exc)
        return {}, "failed"

    content = (response.content or "").strip()
    elapsed = time.perf_counter() - started
    logger.info(
        "PSB translate response: model={}, elapsed_s={:.3f}, finish={}, content_chars={}, reasoning_chars={}, tool_calls={}",
        model,
        elapsed,
        getattr(response, "finish_reason", None),
        len(content),
        len(getattr(response, "reasoning_content", None) or ""),
        len(getattr(response, "tool_calls", None) or []),
    )
    mapping = parse_translation_mapping(content)
    if mapping:
        if len(mapping) < len(pending):
            logger.warning(
                "PSB translate partial result: {}/{} labels",
                len(mapping),
                len(pending),
            )
            return mapping, "failed"
        return mapping, "done"

    _log_empty_translation_response(response, model=model, label_count=len(pending))
    return {}, "failed"
