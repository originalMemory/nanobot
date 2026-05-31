from __future__ import annotations

import pytest

from nanobot.config.loader import load_config, save_config
from nanobot.config.schema import Config, ModelPresetConfig
from nanobot.webui.settings_api import WebUISettingsError, create_model_configuration, update_agent_settings


def test_create_model_configuration_writes_label_and_selects(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.agents.defaults.model = "openai/gpt-4o"
    config.agents.defaults.provider = "openai"
    config.providers.openai.api_key = "sk-test"
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = create_model_configuration(
        {
            "label": ["Fast writing"],
            "provider": ["openai"],
            "model": ["openai/gpt-4.1-mini"],
        }
    )

    assert payload["agent"]["model_preset"] == "fast-writing"
    assert payload["agent"]["model"] == "openai/gpt-4.1-mini"
    rows = {row["name"]: row for row in payload["model_presets"]}
    assert rows["fast-writing"]["label"] == "Fast writing"

    saved = load_config(config_path)
    assert saved.agents.defaults.model_preset == "fast-writing"
    assert saved.model_presets["fast-writing"].label == "Fast writing"
    assert saved.model_presets["fast-writing"].model == "openai/gpt-4.1-mini"
    assert saved.model_presets["fast-writing"].provider == "openai"

    with pytest.raises(WebUISettingsError) as duplicate:
        create_model_configuration(
            {
                "label": ["Fast writing"],
                "provider": ["openai"],
                "model": ["openai/gpt-4.1-mini"],
            }
        )
    assert duplicate.value.status == 409


def test_create_model_configuration_rejects_unconfigured_provider(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    with pytest.raises(WebUISettingsError, match="provider is not configured"):
        create_model_configuration(
            {
                "label": ["Deep"],
                "provider": ["openai"],
                "model": ["openai/gpt-4.1"],
            }
        )


def test_update_agent_settings_writes_generation_fields_to_active_preset(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.providers.deepseek.api_key = "sk-test"
    config.agents.defaults.context_window_tokens = 10_000_000
    config.agents.defaults.max_tokens = 8192
    config.model_presets["ds4pro"] = ModelPresetConfig(
        label="ds4pro",
        model="deepseek-v4-pro",
        provider="deepseek",
        context_window_tokens=200_000,
        max_tokens=20_000,
    )
    config.agents.defaults.model_preset = "ds4pro"
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = update_agent_settings({"context_window_tokens": ["300000"], "max_tokens": ["16000"]})

    assert payload["agent"]["context_window_tokens"] == 300_000
    assert payload["agent"]["max_tokens"] == 16_000
    saved = load_config(config_path)
    assert saved.model_presets["ds4pro"].context_window_tokens == 300_000
    assert saved.model_presets["ds4pro"].max_tokens == 16_000
    assert saved.agents.defaults.context_window_tokens == 10_000_000
    assert saved.agents.defaults.max_tokens == 8192


def test_update_agent_settings_writes_generation_fields_to_defaults_without_preset(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.providers.openai.api_key = "sk-test"
    config.agents.defaults.context_window_tokens = 65_536
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = update_agent_settings({"context_window_tokens": ["128000"]})

    assert payload["agent"]["context_window_tokens"] == 128_000
    saved = load_config(config_path)
    assert saved.agents.defaults.context_window_tokens == 128_000
