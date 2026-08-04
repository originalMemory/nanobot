from __future__ import annotations

from nanobot.agent.playback_segments import (
    parse_segment_controls,
    to_display_text,
    to_speech_text,
)


def test_segmenter_parses_consecutive_leading_tags() -> None:
    raw = '<psb:expression name="笑" /><psb:fade var="fade_body" value="0.5" />你好！'

    content, controls, debug = parse_segment_controls(raw)

    assert content == "你好！"
    assert controls == [
        {"kind": "psb", "type": "expression", "payload": {"name": "笑"}},
        {"kind": "psb", "type": "fade", "payload": {"var": "fade_body", "value": "0.5"}},
    ]
    assert debug == {}


def test_mid_sentence_tag_is_stripped_and_recorded_as_debug() -> None:
    raw = '你好<psb:expression name="怒" />别插队。'

    content, controls, debug = parse_segment_controls(raw)

    assert content == raw
    assert controls == []
    assert to_display_text(raw) == "你好别插队。"
    assert to_speech_text(raw) == "你好别插队。"
    assert debug["invalidControls"][0]["control"] == {
        "kind": "psb",
        "type": "expression",
        "payload": {"name": "怒"},
    }


def test_empty_speech_text_after_controls() -> None:
    raw = '<psb:timeline name="待機" />'

    assert to_display_text(raw) == ""
    assert to_speech_text(raw) == ""
