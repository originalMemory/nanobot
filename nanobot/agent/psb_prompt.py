"""根据当前 PSB 模型元数据构建 AI 标签说明。"""

from __future__ import annotations

from typing import Any

_MAX_TIMELINES = 10
_MAX_EXPRESSIONS = 10
_MAX_FACE = 8
_MAX_FADE = 8


def _label_line(item: dict[str, Any]) -> str:
    label = str(item.get("label") or "").strip()
    zh = str(item.get("labelZh") or "").strip()
    if label and zh and zh != label:
        return f"{label}（{zh}）"
    return label or zh


def _bullet_lines(items: list[dict[str, Any]], *, limit: int) -> list[str]:
    lines: list[str] = []
    for item in items[:limit]:
        text = _label_line(item)
        if not text:
            continue
        if item.get("looping"):
            text += " [循环]"
        lines.append(f"- {text}")
    return lines


def build_psb_response_tags_section() -> str:
    """构建 PSB 桌宠标签 prompt；未启用或无可用模型时返回空字符串。"""
    try:
        from nanobot.config.loader import load_config
        from nanobot.webui.psb_store import PsbStoreError, get_model
    except Exception:
        return ""

    try:
        psb_config = load_config().desk_pet.psb
    except Exception:
        return ""

    if not psb_config.enabled_response_tags:
        return ""
    model_id = (psb_config.selected_model_id or "").strip()
    if not model_id:
        return ""

    try:
        model = get_model(model_id)
    except PsbStoreError:
        return ""

    if not model.get("compatible"):
        return ""

    timelines = _bullet_lines(model.get("timelines") or [], limit=_MAX_TIMELINES)
    expressions = _bullet_lines(model.get("expressions") or [], limit=_MAX_EXPRESSIONS)
    face_vars = _bullet_lines(model.get("faceVariables") or [], limit=_MAX_FACE)
    fade_vars = _bullet_lines(model.get("fadeVariables") or [], limit=_MAX_FADE)

    parts = [
        "# PSB Desk Pet 动作标签",
        "",
        "你可以在回复中插入 PSB 标签来驱动当前 3D 桌宠模型。",
        "标签名请使用下方列出的原始名称或中文名称，不要使用自定义别名。",
        "",
        "标签格式（自闭合）：",
        '- `<psb:timeline name="名称" />` 播放 timeline',
        '- `<psb:expression name="名称" />` 应用表情预设',
        '- `<psb:face var="变量名" value="0.5" />` 设置 face 变量（0~1）',
        '- `<psb:fade var="变量名" value="0.5" />` 设置 fade 变量（0~1）',
    ]

    if timelines:
        parts.extend(["", "可用 timeline：", *timelines])
    if expressions:
        parts.extend(["", "可用 expression：", *expressions])
    if face_vars:
        parts.extend(["", "可用 face 变量：", *face_vars])
    if fade_vars:
        parts.extend(["", "可用 fade 变量：", *fade_vars])

    parts.extend(
        [
            "",
            "规则：非循环 timeline 播放结束后会自动回到初始循环 timeline；"
            "expression/face/fade 在本轮回复结束或 TTS 播放结束后恢复初始状态。",
            "示例：`<psb:timeline name=\"待机\" /><psb:expression name=\"微笑\" />你好！`",
        ]
    )
    return "\n".join(parts)
