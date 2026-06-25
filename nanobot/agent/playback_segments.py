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
_SEGMENT_END_CHARS = frozenset("\n\u3002\uff01\uff1f!?\uff1b;")
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


class AssistantPlaybackSegmenter:
    """Incrementally split assistant deltas into playback segments."""

    def __init__(self, *, chat_id: str, message_id: str) -> None:
        self.chat_id = chat_id
        self.message_id = message_id
        self._buffer = ""
        self._next_index = 0

    def feed(self, delta: str) -> list[AssistantPlaybackSegment]:
        if delta:
            self._buffer += delta
        return self._flush_completed()

    def finish(self, delta: str = "") -> list[AssistantPlaybackSegment]:
        if delta:
            self._buffer += delta
        if not self._buffer.strip():
            self._buffer = ""
            return []
        segment = self._make_segment(self._take_buffer())
        return [segment] if segment is not None else []

    def _flush_completed(self) -> list[AssistantPlaybackSegment]:
        segments: list[AssistantPlaybackSegment] = []
        while True:
            end = _find_segment_end(self._buffer)
            if end is None:
                break
            raw = self._buffer[:end]
            self._buffer = self._buffer[end:]
            if raw.strip():
                segment = self._make_segment(raw)
                if segment is not None:
                    segments.append(segment)
        return segments

    def _take_buffer(self) -> str:
        raw = self._buffer
        self._buffer = ""
        return raw

    def _make_segment(self, raw_text: str) -> AssistantPlaybackSegment | None:
        _, controls, debug = parse_segment_controls(raw_text)
        segment = AssistantPlaybackSegment(
            chat_id=self.chat_id,
            message_id=self.message_id,
            segment_index=self._next_index,
            raw_text=raw_text,
            controls=controls,
            debug=debug,
        )
        if not segment.speech_text:
            return None
        self._next_index += 1
        return segment


def _find_segment_end(text: str) -> int | None:
    index = 0
    while index < len(text):
        char = text[index]
        if char == "<":
            tag_end = text.find(">", index + 1)
            if tag_end != -1:
                index = tag_end + 1
                continue
        if char in _SEGMENT_END_CHARS:
            return index + 1
        if char == ".":
            prev_char = text[index - 1] if index > 0 else ""
            next_char = text[index + 1] if index + 1 < len(text) else ""
            if prev_char != "." and next_char != "." and not (prev_char.isdigit() and next_char.isdigit()):
                return index + 1
        index += 1
    return None
