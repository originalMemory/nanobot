"""PSB 模型元数据解析（仅原始 .psb / .emtbytes，不含 FreeMote 反编译输出）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PSB_UPLOAD_SUFFIXES = frozenset({".psb", ".emtbytes"})


@dataclass
class PsbFrameOption:
    label: str
    value: float
    label_zh: str = ""


@dataclass
class PsbVariableInfo:
    label: str
    label_zh: str = ""
    hint: str = ""
    hint_zh: str = ""
    min_value: float = 0.0
    max_value: float = 1.0
    frames: list[PsbFrameOption] = field(default_factory=list)


@dataclass
class PsbTimelineInfo:
    label: str
    label_zh: str = ""
    diff: bool = False
    loop_begin: float = 0.0
    loop_end: float = -1.0
    last_time: float = -1.0

    @property
    def is_looping(self) -> bool:
        if self.loop_end < 0:
            return False
        if self.loop_begin < 0:
            return False
        return self.loop_end > self.loop_begin


@dataclass
class PsbParseResult:
    model_name: str
    format: str
    psb_version: int | None = None
    web_sdk_likely: bool = False
    compatible: bool = True
    error: str | None = None
    has_face_talk: bool = False
    timelines: list[PsbTimelineInfo] = field(default_factory=list)
    expressions: list[str] = field(default_factory=list)
    face_variables: list[PsbVariableInfo] = field(default_factory=list)
    fade_variables: list[PsbVariableInfo] = field(default_factory=list)
    labels_to_translate: list[str] = field(default_factory=list)
    psb_file: str | None = None


def inspect_psb_header(data: bytes) -> tuple[bool, int | None, str | None]:
    if len(data) < 8:
        return False, None, "文件过短，不是有效的 PSB"
    magic = bytes(data[0:3]).decode("latin-1", errors="replace")
    if magic != "PSB":
        return False, None, f"不是 PSB 文件（文件头：{magic}）"
    version = data[4] | (data[5] << 8)
    return True, version, None


def is_psb_upload_filename(name: str) -> bool:
    return Path(name).suffix.lower() in PSB_UPLOAD_SUFFIXES


def parse_psb_file(psb_path: Path, *, display_name: str | None = None) -> PsbParseResult:
    """解析单个 PSB / emtbytes 文件。"""
    model_name = display_name or psb_path.stem
    if not psb_path.is_file() or not is_psb_upload_filename(psb_path.name):
        return PsbParseResult(
            model_name=model_name,
            format="unknown",
            compatible=False,
            error="不是 .psb 或 .emtbytes 文件",
        )

    try:
        header_bytes = psb_path.read_bytes()[:16]
    except OSError as exc:
        return PsbParseResult(
            model_name=model_name,
            format="psb",
            compatible=False,
            error=str(exc),
            psb_file=psb_path.name,
        )

    if psb_path.suffix.lower() == ".emtbytes":
        return PsbParseResult(
            model_name=model_name,
            format="emtbytes",
            compatible=True,
            psb_file=psb_path.name,
        )

    ok, version, err = inspect_psb_header(header_bytes)
    if not ok:
        return PsbParseResult(
            model_name=model_name,
            format="psb",
            compatible=False,
            error=err,
            psb_file=psb_path.name,
        )
    # 与 gal-char-anim 一致：头信息合法即视为可尝试加载；v4 仅标记 webSdkLikely=false，
    # 是否在 WebGL SDK 中真正可用由运行时 loadData 决定，不在扫描阶段否决。
    web_sdk_likely = version is not None and version <= 3
    return PsbParseResult(
        model_name=model_name,
        format="psb",
        psb_version=version,
        web_sdk_likely=web_sdk_likely,
        compatible=True,
        error=None,
        psb_file=psb_path.name,
    )


def parse_model_directory(model_dir: Path, *, display_name: str | None = None) -> PsbParseResult:
    """解析模型目录中的原始 PSB / emtbytes 文件。"""
    model_name = display_name or model_dir.name
    psb_files = sorted(
        path
        for path in list(model_dir.glob("*.psb")) + list(model_dir.glob("*.emtbytes"))
        if path.is_file()
    )

    if not psb_files:
        return PsbParseResult(
            model_name=model_name,
            format="unknown",
            compatible=False,
            error="目录中未找到 .psb 或 .emtbytes 文件",
        )

    return parse_psb_file(psb_files[0], display_name=model_name)


def parse_result_to_metadata_dict(
    result: PsbParseResult,
    *,
    model_id: str,
    translation_map: dict[str, str] | None = None,
    translation_status: str = "pending",
) -> dict[str, Any]:
    """将解析结果转为可持久化的 metadata.json 结构。"""
    translation_map = translation_map or {}

    def zh(label: str) -> str:
        return translation_map.get(label, label)

    timelines = [
        {
            "label": item.label,
            "labelZh": zh(item.label),
            "diff": item.diff,
            "loopBegin": item.loop_begin,
            "loopEnd": item.loop_end,
            "lastTime": item.last_time,
            "looping": item.is_looping,
        }
        for item in result.timelines
    ]
    face_variables = [
        {
            "label": item.label,
            "labelZh": zh(item.label),
            "hint": item.hint,
            "hintZh": zh(item.hint) if item.hint else "",
            "minValue": item.min_value,
            "maxValue": item.max_value,
            "frames": [
                {"label": frame.label, "labelZh": zh(frame.label), "value": frame.value}
                for frame in item.frames
            ],
        }
        for item in result.face_variables
    ]
    fade_variables = [
        {
            "label": item.label,
            "labelZh": zh(item.label),
            "hint": item.hint,
            "hintZh": zh(item.hint) if item.hint else "",
            "minValue": item.min_value,
            "maxValue": item.max_value,
            "frames": [
                {"label": frame.label, "labelZh": zh(frame.label), "value": frame.value}
                for frame in item.frames
            ],
        }
        for item in result.fade_variables
    ]
    return {
        "modelId": model_id,
        "name": result.model_name,
        "format": result.format,
        "psbVersion": result.psb_version,
        "webSdkLikely": result.web_sdk_likely,
        "compatible": result.compatible,
        "parseError": result.error,
        "psbFile": result.psb_file,
        "hasFaceTalk": result.has_face_talk,
        "timelines": timelines,
        "expressions": [{"label": label, "labelZh": zh(label)} for label in result.expressions],
        "faceVariables": face_variables,
        "fadeVariables": fade_variables,
        "translationStatus": translation_status,
        "initialState": {
            "timeline": "",
            "expression": "",
            "face": {},
            "fade": {},
        },
    }
