from __future__ import annotations

from nanobot.agent.playback_segments import (
    AssistantPlaybackSegmenter,
    parse_segment_controls,
    to_display_text,
    to_speech_text,
)


def test_segmenter_flushes_japanese_sentence_and_cross_delta_boundary() -> None:
    segmenter = AssistantPlaybackSegmenter(chat_id="chat", message_id="m1")

    assert segmenter.feed('<psb:timeline name="うん') == []
    segments = segmenter.feed('うん" />嗯嗯。下一句')
    segments += segmenter.finish("来了")

    assert [s.segment_index for s in segments] == [0, 1]
    assert segments[0].message_id == "m1"
    assert segments[0].controls == [
        {"kind": "psb", "type": "timeline", "payload": {"name": "うんうん"}}
    ]
    assert segments[0].display_text == "嗯嗯。"
    assert segments[1].display_text == "下一句来了"


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


def test_newline_flushes_segment() -> None:
    segmenter = AssistantPlaybackSegmenter(chat_id="chat", message_id="m2")

    segments = segmenter.feed('<psb:face var="face_mouth" value="0.8" />第一行\n第二')
    segments += segmenter.finish("行")

    assert len(segments) == 2
    assert segments[0].controls[0]["type"] == "face"
    assert segments[0].speech_text == "第一行"
    assert segments[1].speech_text == "第二行"
