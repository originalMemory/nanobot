"""Assistant playback segment parsing and text derivation."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from nanobot.agent.psb_tags import strip_psb_tags

AudioStatus = Literal["idle", "pending", "ready", "playing", "done", "failed", "skipped"]

_PSB_TAG_RE = re.compile(
    r'<psb:(timeline|expression|face|fade)\b([^>]*?)/?>',
    re.IGNORECASE,
)
_ATTR_RE = re.compile(r"""(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")
_THA_TAG_RE = re.compile(r"<[^>]+>")


@dataclass(slots=True)
class SegmentAudio:
    status: AudioStatus = "idle"
    path: str | None = None
    url: str | None = None
    mime_type: str | None = None
    error: str | None = None

    def to_dict(self, *, include_path: bool = False, include_url: bool = True) -> dict[str, Any]:
        data: dict[str, Any] = {"status": self.status}
        if include_path and self.path:
            data["path"] = self.path
        if include_url and self.url:
            data["url"] = self.url
        if self.mime_type:
            data["mimeType"] = self.mime_type
        if self.error:
            data["error"] = self.error
        return data


@dataclass(slots=True)
class AssistantPlaybackSegment:
    chat_id: str
    message_id: str
    segment_index: int
    raw_text: str
    controls: list[dict[str, Any]] = field(default_factory=list)
    debug: dict[str, Any] = field(default_factory=dict)
    audio: SegmentAudio = field(default_factory=SegmentAudio)

    @property
    def display_text(self) -> str:
        return to_display_text(self)

    @property
    def speech_text(self) -> str:
        return to_speech_text(self)

    def to_dict(
        self,
        *,
        include_audio_path: bool = False,
        include_audio_url: bool = True,
    ) -> dict[str, Any]:
        data: dict[str, Any] = {
            "messageId": self.message_id,
            "segmentIndex": self.segment_index,
            "rawText": self.raw_text,
            "controls": self.controls,
            "audio": self.audio.to_dict(
                include_path=include_audio_path,
                include_url=include_audio_url,
            ),
        }
        if self.debug:
            data["debug"] = self.debug
        return data


def _parse_attrs(attr_text: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for match in _ATTR_RE.finditer(attr_text):
        key = match.group(1)
        value = match.group(2) if match.group(2) is not None else match.group(3)
        attrs[key] = value or ""
    return attrs


def _psb_control(tag_type: str, attrs: dict[str, str]) -> dict[str, Any] | None:
    normalized = tag_type.lower()
    if normalized in {"timeline", "expression"}:
        name = attrs.get("name") or attrs.get("label") or ""
        if not name:
            return None
        return {"kind": "psb", "type": normalized, "payload": {"name": name}}
    if normalized in {"face", "fade"}:
        var_name = attrs.get("var") or attrs.get("name") or ""
        raw_value = attrs.get("value")
        if not var_name or raw_value is None or raw_value == "":
            return None
        return {
            "kind": "psb",
            "type": normalized,
            "payload": {"var": var_name, "value": raw_value},
        }
    return None


def parse_segment_controls(raw_text: str) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    """Parse leading PSB tags into controls and record non-leading tags for debug."""
    source = raw_text or ""
    cursor = 0
    controls: list[dict[str, Any]] = []
    invalid: list[dict[str, Any]] = []

    while True:
        leading_ws = re.match(r"\s*", source[cursor:])
        if leading_ws:
            cursor += leading_ws.end()
        match = _PSB_TAG_RE.match(source, cursor)
        if not match:
            break
        control = _psb_control(match.group(1), _parse_attrs(match.group(2)))
        if control:
            controls.append(control)
        cursor = match.end()

    content = source[cursor:]
    for match in _PSB_TAG_RE.finditer(content):
        control = _psb_control(match.group(1), _parse_attrs(match.group(2)))
        invalid.append(
            {
                "raw": match.group(0),
                "offset": cursor + match.start(),
                **({"control": control} if control else {}),
            }
        )

    debug = {"invalidControls": invalid} if invalid else {}
    return content, controls, debug


def to_display_text(segment: AssistantPlaybackSegment | str) -> str:
    raw = segment.raw_text if isinstance(segment, AssistantPlaybackSegment) else segment
    content, _, _ = parse_segment_controls(raw)
    return strip_psb_tags(content)


def to_speech_text(segment: AssistantPlaybackSegment | str) -> str:
    display = to_display_text(segment)
    return _THA_TAG_RE.sub("", display).strip()
