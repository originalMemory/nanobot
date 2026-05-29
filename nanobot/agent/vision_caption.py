"""辅助视觉模型 caption 模块。

调用具备视觉能力的 LLM 将图片转述为文字描述，
使不支持 vision 的主模型也能理解图片内容。
"""
from __future__ import annotations

import asyncio
import base64
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from nanobot.utils.helpers import detect_image_mime

if TYPE_CHECKING:
    from nanobot.providers.base import LLMProvider

# TODO: 后续考虑根据对话语言自动选择 prompt（中/英文自适应）
_CAPTION_PROMPT = (
    "请详细描述这张图片的内容。包括：主体对象、文字信息、布局结构、颜色、数据、"
    "关键细节等所有可识别的视觉元素。尽可能完整，不要遗漏重要信息。"
)


@dataclass
class CaptionResult:
    """单张图片的 caption 结果。"""

    index: int
    path: str
    text: str | None = None
    error: str | None = None

    @property
    def success(self) -> bool:
        return self.text is not None


def _build_image_message(path: str, prompt: str) -> list[dict[str, Any]] | None:
    """构建含 base64 内联图片块的视觉 LLM 消息；文件不可读时返回 None。"""
    p = Path(path)
    if not p.is_file():
        return None
    raw = p.read_bytes()
    mime = detect_image_mime(raw) or mimetypes.guess_type(path)[0]
    if not mime or not mime.startswith("image/"):
        return None
    b64 = base64.b64encode(raw).decode()
    return [
        {
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"},
                },
                {"type": "text", "text": prompt},
            ],
        }
    ]


async def _caption_single(
    index: int,
    path: str,
    provider: LLMProvider,
    model: str,
    prompt: str,
) -> CaptionResult:
    """对单张图片调用视觉模型；返回含描述文本或错误信息的 CaptionResult。"""
    messages = _build_image_message(path, prompt)
    if messages is None:
        return CaptionResult(index=index, path=path, error="文件不存在或不是有效图片")

    try:
        response = await provider.chat_with_retry(messages=messages, model=model)
    except Exception as exc:
        return CaptionResult(index=index, path=path, error=f"调用视觉模型异常: {exc}")
    text = response.content.strip() if response.content else ""
    if not text:
        return CaptionResult(index=index, path=path, error="模型未返回描述文本")
    return CaptionResult(index=index, path=path, text=text)


async def caption_images(
    image_paths: list[str],
    provider: LLMProvider,
    model: str,
) -> list[CaptionResult]:
    """并发调用视觉 provider 对每张图片生成文字描述。

    支持部分成功：单张失败不会中止其余调用。
    返回与 image_paths 等长且顺序一致的结果列表。
    """
    if not image_paths:
        return []

    tasks = [
        _caption_single(i, path, provider, model, _CAPTION_PROMPT)
        for i, path in enumerate(image_paths)
    ]
    raw_results = await asyncio.gather(*tasks, return_exceptions=True)

    results: list[CaptionResult] = []
    for i, (path, raw) in enumerate(zip(image_paths, raw_results)):
        if isinstance(raw, BaseException):
            results.append(CaptionResult(index=i, path=path, error=str(raw)))
        else:
            results.append(raw)

    return results


def format_captions(results: list[CaptionResult]) -> str:
    """将 caption 结果格式化为追加到用户消息的文本。

    单图：``[图片描述: <text>]``
    多图：``[图片 1 描述: <text>]`` 等
    失败：``[图片 N: 描述获取失败 - <原因>]``
    """
    if not results:
        return ""

    parts: list[str] = []
    multi = len(results) > 1

    for r in results:
        n = r.index + 1
        if r.success:
            if multi:
                parts.append(f"[图片 {n} 描述: {r.text}]")
            else:
                parts.append(f"[图片描述: {r.text}]")
        else:
            parts.append(f"[图片 {n}: 描述获取失败 - {r.error}]")

    return "\n".join(parts)
