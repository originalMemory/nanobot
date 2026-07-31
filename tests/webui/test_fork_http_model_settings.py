from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from nanobot.config.loader import load_config, save_config
from nanobot.config.schema import Config, ModelPresetConfig
from nanobot.webui.fork_http import ForkGatewayHTTPHandler


def _handler(runtime_model_setter) -> ForkGatewayHTTPHandler:
    handler = object.__new__(ForkGatewayHTTPHandler)
    handler.check_api_token = lambda _request: True
    handler._runtime_model_setter = runtime_model_setter
    handler._settings_restart_sections = set()
    handler._log = MagicMock()
    return handler


def test_model_configuration_migration_rolls_back_when_runtime_refresh_fails(
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

    calls: list[str | None] = []

    def set_runtime_model(preset: str | None) -> None:
        calls.append(preset)
        if len(calls) == 1:
            raise RuntimeError("runtime refresh failed")

    response = _handler(set_runtime_model)._handle_settings_model_configurations_migrate(
        MagicMock(path="/api/settings/model-configurations/migrate")
    )

    assert response.status_code == 400
    saved = load_config(config_path)
    assert saved.agents.defaults.model_preset is None
    assert saved.model_presets == {}
    assert calls[1] is None


def test_model_call_order_rolls_back_when_runtime_refresh_fails(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.providers.openai.api_key = "sk-test"
    config.model_presets = {
        "primary": ModelPresetConfig(
            model="openai/gpt-4o",
            provider="openai",
        ),
        "fallback": ModelPresetConfig(
            model="openai/gpt-4.1-mini",
            provider="openai",
        ),
    }
    config.agents.defaults.model_preset = "primary"
    config.agents.defaults.fallback_models = ["fallback"]
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    calls: list[str | None] = []

    def set_runtime_model(preset: str | None) -> None:
        calls.append(preset)
        if len(calls) == 1:
            raise RuntimeError("runtime refresh failed")

    order = json.dumps(["fallback", "primary"])
    response = _handler(set_runtime_model)._handle_settings_model_call_order_update(
        MagicMock(path=f"/api/settings/model-call-order/update?order={order}")
    )

    assert response.status_code == 400
    saved = load_config(config_path)
    assert saved.agents.defaults.model_preset == "primary"
    assert saved.agents.defaults.fallback_models == ["fallback"]
    assert calls == ["fallback", "primary"]
