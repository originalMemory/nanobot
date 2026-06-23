"""PSB 标签 prompt 与解析测试。"""

from __future__ import annotations

from unittest.mock import patch

from nanobot.agent.psb_prompt import build_psb_response_tags_section
from nanobot.agent.psb_tags import parse_psb_tag_actions, strip_psb_tags
from nanobot.config.schema import DeskPetConfig, PSBConfig


def test_build_psb_response_tags_section_disabled() -> None:
  with patch("nanobot.config.loader.load_config") as load_config:
    load_config.return_value.desk_pet = DeskPetConfig(
      psb=PSBConfig(enabled_response_tags=False, selected_model_id="demo"),
    )
    assert build_psb_response_tags_section() == ""


def test_build_psb_response_tags_section_with_model() -> None:
  model = {
    "compatible": True,
    "timelines": [{"label": "待機", "labelZh": "待机", "looping": True}],
    "expressions": [{"label": "微笑", "labelZh": "微笑"}],
    "faceVariables": [{"label": "face_mouth", "labelZh": "嘴"}],
    "fadeVariables": [],
  }
  with (
    patch("nanobot.config.loader.load_config") as load_config,
    patch("nanobot.webui.psb_store.get_model", return_value=model),
  ):
    load_config.return_value.desk_pet = DeskPetConfig(
      psb=PSBConfig(enabled_response_tags=True, selected_model_id="demo"),
    )
    section = build_psb_response_tags_section()
  assert "PSB Desk Pet" in section
  assert "<psb:timeline" in section
  assert "待机" in section
  assert "face_mouth" in section


def test_parse_psb_tag_actions() -> None:
  text = (
    '<psb:timeline name="待机" />'
    '<psb:expression name="微笑" />'
    '<psb:face var="face_mouth" value="0.8" />'
    '<psb:fade var="fade_body" value="1" />'
    "你好"
  )
  actions = parse_psb_tag_actions(text)
  assert len(actions) == 4
  assert actions[0] == {"type": "timeline", "payload": {"name": "待机"}}
  assert actions[2]["payload"]["var"] == "face_mouth"


def test_strip_psb_tags_keeps_plain_text() -> None:
  raw = '<psb:timeline name="待机" />你好'
  assert strip_psb_tags(raw) == "你好"


def test_strip_psb_tags_leaves_unknown_psb_tags() -> None:
  raw = '<psb:unknown name="x" />保留'
  assert strip_psb_tags(raw) == raw
