from __future__ import annotations

import pytest

from nanobot.config.schema import Config


def _config_data() -> dict:
    return {
        "tools": {"tts": {"mode": "agent", "preset": "index", "voice": "candice-glm"}},
        "ttsPresets": {
            "minimax": {
                "label": "MiniMax",
                "config": {"provider": "minimax", "model": "speech-2.8-hd"},
                "voices": [{
                    "id": "candice-source",
                    "label": "坎蒂丝（原声）",
                    "languageVoices": {"default": "cn-voice", "ja": "ja-voice"},
                }],
            },
            "index": {
                "label": "IndexTTS",
                "config": {"provider": "index-tts-2.5", "model": "index-tts-2.5"},
                "voices": [{
                    "id": "candice-glm",
                    "label": "坎蒂丝（GLM）",
                    "languageVoices": {"default": "candice-glm"},
                }],
                "fallback": {"preset": "minimax", "voice": "candice-source"},
            },
        },
    }


def test_resolve_tts_preset_uses_language_voice_and_fallback() -> None:
    config = Config.model_validate(_config_data())
    resolved = config.resolve_tts_config()

    assert resolved.config.provider == "index-tts-2.5"
    assert resolved.voice == "candice-glm"
    assert resolved.config.japanese_voice == "candice-glm"
    assert resolved.fallback_config is not None
    assert resolved.fallback_config.provider == "minimax"
    assert resolved.fallback_config.japanese_voice == "ja-voice"
    assert resolved.fallback_voice == "cn-voice"


def test_tts_rejects_legacy_direct_provider_fields() -> None:
    data = _config_data()
    data["tools"]["tts"]["provider"] = "minimax"

    with pytest.raises(ValueError, match="Extra inputs are not permitted"):
        Config.model_validate(data)


def test_language_voice_prefers_zh_override_and_falls_back_for_ja() -> None:
    data = _config_data()
    voice = data["ttsPresets"]["index"]["voices"][0]
    voice["languageVoices"]["zh"] = "zh-specific"

    resolved = Config.model_validate(data).resolve_tts_config()

    assert resolved.voice == "zh-specific"
    assert resolved.config.japanese_voice == "candice-glm"


@pytest.mark.parametrize(("field", "value"), [("id", " "), ("label", " ")])
def test_tts_voice_rejects_blank_id_or_label(field: str, value: str) -> None:
    data = _config_data()
    data["ttsPresets"]["index"]["voices"][0][field] = value

    with pytest.raises(ValueError, match="id 和 label 不能为空"):
        Config.model_validate(data)
