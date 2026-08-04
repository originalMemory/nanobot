from __future__ import annotations

import json

import httpx
import pytest

from nanobot.config.loader import load_config, save_config
from nanobot.config.schema import Config, ModelPresetConfig
from nanobot.providers.registry import find_by_name
from nanobot.webui.settings_api import (
    WebUISettingsError,
    _oauth_provider_status,
    create_model_configuration,
    migrate_model_configurations,
    provider_models_payload,
    settings_payload,
    update_agent_settings,
    update_model_call_order,
    update_model_configuration,
    update_network_safety_settings,
    update_tha_settings,
    update_tts_settings,
)


def test_model_call_order_migrates_and_updates_named_presets(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.agents.defaults.model = "openai/gpt-4o"
    config.agents.defaults.provider = "openai"
    config.providers.openai.api_key = "sk-test"
    config.model_presets["fast"] = ModelPresetConfig(
        label="Fast",
        model="openai/gpt-4.1-mini",
        provider="openai",
    )
    config.agents.defaults.fallback_models = ["fast"]
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    before = settings_payload()
    assert before["model_call_order"] == []
    assert before["model_call_order_editable"] is False

    migrated = migrate_model_configurations()
    primary = migrated["model_call_order"][0]
    assert migrated["model_call_order"] == [primary, "fast"]
    assert migrated["model_call_order_editable"] is True

    payload = update_model_call_order({"order": [json.dumps(["fast", primary])]})
    assert payload["model_call_order"] == ["fast", primary]
    saved = load_config(config_path)
    assert saved.agents.defaults.model_preset == "fast"
    assert saved.agents.defaults.fallback_models == [primary]

    switched = update_agent_settings({"model_preset": [primary]})
    assert switched["model_call_order"] == [primary, "fast"]
    saved = load_config(config_path)
    assert saved.agents.defaults.fallback_models == ["fast"]

    edited = update_model_configuration({"name": ["fast"], "label": ["Fast edited"]})
    assert edited["model_call_order"] == ["fast", primary]
    saved = load_config(config_path)
    assert saved.agents.defaults.fallback_models == [primary]


def test_model_call_order_rejects_unconfigured_inactive_provider(
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
        "inactive": ModelPresetConfig(
            model="anthropic/claude-sonnet-4",
            provider="anthropic",
        ),
    }
    config.agents.defaults.model_preset = "primary"
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    with pytest.raises(WebUISettingsError, match="provider is not configured"):
        update_model_call_order(
            {"order": [json.dumps(["primary", "inactive"])]}
        )

    saved = load_config(config_path)
    assert saved.agents.defaults.model_preset == "primary"
    assert saved.agents.defaults.fallback_models == []


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
    assert saved.model_presets["fast-writing"].vision_enabled is False

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


def test_settings_payload_includes_desk_pet_defaults(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = settings_payload()

    tha = payload["deskPet"]["tha"]
    psb = payload["deskPet"]["psb"]
    assert tha["config"]["audioDelayMs"] == 150
    assert tha["model"]["available"] is False
    assert tha["model"]["path"].endswith("tha_model/model.onnx")
    assert psb["autoShow"] is False
    assert psb["selectedModelId"] is None
    assert psb["models"] == []


def test_update_tha_settings_writes_desk_pet_config_and_reports_fixed_model(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)
    model_dir = tmp_path / "tha_model"
    model_dir.mkdir(parents=True)
    (model_dir / "model.onnx").write_bytes(b"onnx")

    payload = update_tha_settings(
        {
            "enabledEmotions": ["true"],
            "enabledMouthSync": ["true"],
            "windowWidth": ["640"],
            "windowHeight": ["512"],
            "audioDelayMs": ["260"],
        }
    )

    tha = payload["deskPet"]["tha"]
    assert tha["config"] == {
        "enabledEmotions": True,
        "enabledMouthSync": True,
        "windowWidth": 640,
        "windowHeight": 512,
        "audioDelayMs": 260,
    }
    assert tha["model"]["available"] is True
    assert tha["model"]["format"] == "onnx"
    assert tha["model"]["path"] == str(model_dir / "model.onnx")
    saved = load_config(config_path)
    assert saved.desk_pet.tha.audio_delay_ms == 260


def test_update_tts_settings_writes_mode_and_legacy_flags(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = update_tts_settings({"mode": ["always"]})

    assert payload["tts"]["mode"] == "always"
    saved = load_config(config_path)
    assert saved.tools.tts.mode == "always"
    assert saved.tools.tts.enabled is False
    assert saved.tools.tts.message_playback_enabled is True


def test_update_model_configuration_edits_named_preset_and_selects(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.providers.openai.api_key = "sk-test"
    config.model_presets["codex"] = ModelPresetConfig(
        label="Old Codex",
        provider="openai",
        model="openai/gpt-4.1",
    )
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)
    monkeypatch.setattr(
        "nanobot.webui.settings_api._oauth_provider_status",
        lambda spec: {
            "configured": spec.name == "openai_codex",
            "account": "acct-test",
            "expires_at": 123,
            "login_supported": True,
        },
    )

    payload = update_model_configuration(
        {
            "name": ["codex"],
            "label": ["Codex"],
            "provider": ["openai_codex"],
            "model": ["openai-codex/gpt-5.5"],
        }
    )

    assert payload["agent"]["model_preset"] == "codex"
    assert payload["agent"]["model"] == "openai-codex/gpt-5.5"
    saved = load_config(config_path)
    assert saved.agents.defaults.model_preset == "codex"
    assert saved.model_presets["codex"].label == "Codex"
    assert saved.model_presets["codex"].provider == "openai_codex"
    assert saved.model_presets["codex"].model == "openai-codex/gpt-5.5"


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


def test_update_agent_settings_accepts_context_window_options(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = update_agent_settings({"context_window_tokens": ["262144"]})

    assert payload["agent"]["context_window_tokens"] == 262144
    saved = load_config(config_path)
    assert saved.agents.defaults.context_window_tokens == 262144


def test_update_model_configuration_accepts_context_window_options(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.model_presets["codex"] = ModelPresetConfig(
        label="Codex",
        provider="openai",
        model="openai/gpt-4.1",
    )
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = update_model_configuration(
        {
            "name": ["codex"],
            "context_window_tokens": ["262144"],
        }
    )

    assert payload["agent"]["context_window_tokens"] == 262144
    saved = load_config(config_path)
    assert saved.model_presets["codex"].context_window_tokens == 262144


def test_update_context_window_rejects_values_below_minimum(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    with pytest.raises(WebUISettingsError, match="context_window_tokens must be >= 4096"):
        update_agent_settings({"context_window_tokens": ["1024"]})


def test_update_model_configuration_rejects_default_preset(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    with pytest.raises(WebUISettingsError, match="model configuration is required"):
        update_model_configuration({"name": ["default"], "model": ["openai/gpt-4.1"]})


def test_settings_payload_includes_oauth_provider_status(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    def fake_oauth_status(spec):
        if spec.name == "openai_codex":
            return {
                "configured": True,
                "account": "acct-test",
                "expires_at": 123,
                "login_supported": True,
            }
        return {
            "configured": False,
            "account": None,
            "expires_at": None,
            "login_supported": True,
        }

    monkeypatch.setattr("nanobot.webui.settings_api._oauth_provider_status", fake_oauth_status)

    payload = settings_payload()
    providers = {row["name"]: row for row in payload["providers"]}

    assert providers["openai_codex"]["auth_type"] == "oauth"
    assert providers["openai_codex"]["configured"] is True
    assert providers["openai_codex"]["oauth_account"] == "acct-test"


def test_settings_payload_includes_network_safety_fields(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.tools.webui_allow_local_service_access = False
    config.tools.ssrf_whitelist = ["100.64.0.0/10"]
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)
    monkeypatch.setattr("nanobot.webui.workspaces.get_webui_dir", lambda: tmp_path / "webui")

    payload = settings_payload()

    assert payload["advanced"]["webui_allow_local_service_access"] is False
    assert payload["advanced"]["allow_local_preview_access"] is False
    assert payload["advanced"]["webui_default_access_mode"] == "default"
    assert payload["advanced"]["private_service_protection_enabled"] is True
    assert payload["advanced"]["ssrf_whitelist_count"] == 1


def test_update_network_safety_settings_writes_local_service_flag(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)
    monkeypatch.setattr("nanobot.webui.workspaces.get_webui_dir", lambda: tmp_path / "webui")

    payload = update_network_safety_settings(
        {
            "webui_allow_local_service_access": ["false"],
            "webui_default_access_mode": ["full"],
        }
    )

    saved = load_config(config_path)
    saved_raw = json.loads(config_path.read_text(encoding="utf-8"))
    assert saved.tools.webui_allow_local_service_access is False
    assert saved_raw["tools"]["webuiAllowLocalServiceAccess"] is False
    assert "allowLocalPreviewAccess" not in saved_raw["tools"]
    assert payload["advanced"]["webui_allow_local_service_access"] is False
    assert payload["advanced"]["webui_default_access_mode"] == "full"
    assert payload["requires_restart"] is True


def test_update_network_safety_settings_accepts_legacy_restricted_default_access(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)
    monkeypatch.setattr("nanobot.webui.workspaces.get_webui_dir", lambda: tmp_path / "webui")

    payload = update_network_safety_settings({"webui_default_access_mode": ["restricted"]})

    assert payload["advanced"]["webui_default_access_mode"] == "default"


def test_update_network_safety_settings_default_access_is_webui_only(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    before = config_path.read_text(encoding="utf-8")
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)
    monkeypatch.setattr("nanobot.webui.workspaces.get_webui_dir", lambda: tmp_path / "webui")

    payload = update_network_safety_settings({"webui_default_access_mode": ["full"]})

    saved = load_config(config_path)
    assert config_path.read_text(encoding="utf-8") == before
    assert saved.tools.restrict_to_workspace is False
    assert payload["advanced"]["webui_default_access_mode"] == "full"
    assert payload["requires_restart"] is False


def test_openai_codex_oauth_status_uses_available_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_get_token():
        return type(
            "Token",
            (),
            {
                "access": "access-token",
                "refresh": "refresh-token",
                "expires": 2_000_000_000_000,
                "account_id": "acct-codex",
            },
        )()

    monkeypatch.setattr("oauth_cli_kit.get_token", fake_get_token)

    status = _oauth_provider_status(find_by_name("openai_codex"))

    assert status["configured"] is True
    assert status["account"] == "acct-codex"


def test_openai_codex_oauth_status_rejects_unavailable_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_get_token():
        raise RuntimeError("refresh failed")

    monkeypatch.setattr("oauth_cli_kit.get_token", fake_get_token)

    status = _oauth_provider_status(find_by_name("openai_codex"))

    assert status["configured"] is False
    assert status["account"] is None


def test_update_agent_settings_writes_reasoning_effort_to_active_preset(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.providers.deepseek.api_key = "sk-test"
    config.model_presets["think"] = ModelPresetConfig(
        label="think",
        model="deepseek-v4-pro",
        provider="deepseek",
        reasoning_effort=None,
    )
    config.agents.defaults.model_preset = "think"
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = update_agent_settings({"reasoning_effort": ["high"]})

    assert payload["agent"]["reasoning_effort"] == "high"
    saved = load_config(config_path)
    assert saved.model_presets["think"].reasoning_effort == "high"


def test_settings_payload_exposes_global_vision_with_preset_switch(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.agents.defaults.vision_model = "gemini-2.5-flash"
    config.agents.defaults.vision_provider = "gemini"
    config.model_presets["vision"] = ModelPresetConfig(
        model="openai/gpt-4.1",
        provider="openai",
        vision_model="gemini-2.5-pro",
        vision_enabled=True,
    )
    config.model_presets["direct"] = ModelPresetConfig(
        model="openai/gpt-4.1",
        provider="openai",
    )
    config.agents.defaults.model_preset = "vision"
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = settings_payload()
    rows = {row["name"]: row for row in payload["model_presets"]}

    assert payload["agent"]["vision_model"] == "gemini-2.5-flash"
    assert payload["agent"]["vision_provider"] == "gemini"
    assert payload["agent"]["vision_enabled"] is True
    assert rows["default"]["vision_model"] == "gemini-2.5-flash"
    assert rows["vision"]["vision_model"] == "gemini-2.5-flash"
    assert rows["vision"]["vision_provider"] == "gemini"
    assert rows["vision"]["vision_enabled"] is True
    assert rows["direct"]["vision_model"] == "gemini-2.5-flash"
    assert rows["direct"]["vision_enabled"] is False


def test_update_agent_settings_writes_global_vision_and_preset_switch(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.agents.defaults.vision_model = "gemini-2.5-flash"
    config.agents.defaults.vision_provider = "gemini"
    config.model_presets["vision"] = ModelPresetConfig(
        model="openai/gpt-4.1",
        provider="openai",
        vision_enabled=True,
    )
    config.agents.defaults.model_preset = "vision"
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    direct = update_agent_settings({
        "vision_model": [""],
        "vision_provider": [""],
    })
    assert direct["agent"]["vision_model"] is None
    assert direct["agent"]["vision_provider"] is None

    auxiliary = update_agent_settings({
        "vision_model": ["gemini-2.5-pro"],
        "vision_provider": [""],
        "vision_enabled": ["false"],
    })
    assert auxiliary["agent"]["vision_model"] == "gemini-2.5-pro"
    assert auxiliary["agent"]["vision_provider"] is None
    assert auxiliary["agent"]["vision_enabled"] is False
    saved = load_config(config_path)
    assert saved.agents.defaults.vision_model == "gemini-2.5-pro"
    assert saved.agents.defaults.vision_provider is None
    assert saved.model_presets["vision"].vision_enabled is False
    assert saved.model_presets["vision"].vision_model is None


def test_legacy_preset_vision_is_promoted_to_global_config() -> None:
    config = Config.model_validate({
        "agents": {"defaults": {"modelPreset": "vision"}},
        "modelPresets": {
            "vision": {
                "model": "openai/gpt-4.1",
                "visionModel": "gemini-2.5-pro",
                "visionProvider": "gemini",
            },
            "direct": {"model": "openai/gpt-4.1"},
        },
    })

    assert config.agents.defaults.vision_model == "gemini-2.5-pro"
    assert config.agents.defaults.vision_provider == "gemini"
    assert config.model_presets["vision"].vision_enabled is True
    assert config.model_presets["direct"].vision_enabled is False
    dumped = config.model_dump(by_alias=True)
    assert "visionModel" not in dumped["model_presets"]["vision"]
    assert "visionProvider" not in dumped["model_presets"]["vision"]


def test_provider_models_payload_fetches_openai_compatible_models(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.providers.deepseek.api_key = "sk-test"
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    def fake_get(url: str, **kwargs):
        assert url == "https://api.deepseek.com/models"
        assert kwargs["headers"]["Authorization"] == "Bearer sk-test"
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "deepseek-chat", "owned_by": "deepseek"},
                    {"id": "deepseek-reasoner", "context_window": 65536},
                ]
            },
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr("nanobot.webui.settings_api.httpx.get", fake_get)

    payload = provider_models_payload({"provider": ["deepseek"]})

    assert payload["status"] == "available"
    assert payload["catalog_kind"] == "official"
    assert payload["model_count"] == 2
    assert payload["models"][0]["id"] == "deepseek-chat"
    assert payload["models"][1]["context_window"] == 65536


@pytest.mark.parametrize(
    ("api_base", "expected_url"),
    [
        ("https://api.minimaxi.com/anthropic", "https://api.minimaxi.com/anthropic/v1/models"),
        ("https://api.minimaxi.com/anthropic/v1", "https://api.minimaxi.com/anthropic/v1/models"),
    ],
)
def test_provider_models_payload_fetches_minimax_anthropic_models(
    api_base: str,
    expected_url: str,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.providers.minimax_anthropic.api_key = "sk-test"
    config.providers.minimax_anthropic.api_base = api_base
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    def fake_get(url: str, **kwargs):
        assert url == expected_url
        assert kwargs["headers"]["X-Api-Key"] == "sk-test"
        assert "Authorization" not in kwargs["headers"]
        return httpx.Response(
            200,
            json={"data": [{"id": "MiniMax-M2.7-highspeed"}]},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr("nanobot.webui.settings_api.httpx.get", fake_get)

    payload = provider_models_payload({"provider": ["minimax_anthropic"]})

    assert payload["status"] == "available"
    assert payload["catalog_kind"] == "official"
    assert payload["models"] == [
        {
            "id": "MiniMax-M2.7-highspeed",
            "label": None,
            "owned_by": None,
            "context_window": None,
        }
    ]


def test_provider_models_payload_requires_gateway_key(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = provider_models_payload({"provider": ["openrouter"]})

    assert payload["status"] == "not_configured"
    assert payload["models"] == []


def test_create_model_configuration_accepts_configured_oauth_provider(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)
    monkeypatch.setattr(
        "nanobot.webui.settings_api._oauth_provider_status",
        lambda spec: {
            "configured": spec.name == "openai_codex",
            "account": "acct-test",
            "expires_at": 123,
            "login_supported": True,
        },
    )

    payload = create_model_configuration(
        {
            "label": ["Codex"],
            "provider": ["openai_codex"],
            "model": ["openai-codex/gpt-5.1-codex"],
        }
    )

    assert payload["agent"]["model_preset"] == "codex"
    saved = load_config(config_path)
    assert saved.model_presets["codex"].provider == "openai_codex"


# ---------------------------------------------------------------------------
# Azure OpenAI: settings contract for static-key vs AAD (DefaultAzureCredential)
# ---------------------------------------------------------------------------


def test_settings_payload_azure_openai_with_api_key_is_configured(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Static-key mode: api_key + api_base both set -> configured."""
    config_path = tmp_path / "config.json"
    config = Config()
    config.providers.azure_openai.api_key = "k"
    config.providers.azure_openai.api_base = "https://r.openai.azure.com"
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = settings_payload()
    azure = next(row for row in payload["providers"] if row["name"] == "azure_openai")

    assert azure["configured"] is True
    assert azure["api_key_required"] is False
    assert azure["auth_type"] == "api_key"
    assert azure["api_base"] == "https://r.openai.azure.com"


def test_settings_payload_azure_openai_aad_mode_is_configured(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AAD mode: only api_base set (no api_key) -> still configured."""
    config_path = tmp_path / "config.json"
    config = Config()
    config.providers.azure_openai.api_base = "https://r.openai.azure.com"
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = settings_payload()
    azure = next(row for row in payload["providers"] if row["name"] == "azure_openai")

    assert azure["configured"] is True
    assert azure["api_key_required"] is False
    assert azure["api_base"] == "https://r.openai.azure.com"
    assert azure["api_key_hint"] is None


def test_settings_payload_azure_openai_missing_base_not_configured(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """api_key alone (no api_base) is NOT a working config -> not configured."""
    config_path = tmp_path / "config.json"
    config = Config()
    config.providers.azure_openai.api_key = "k"
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = settings_payload()
    azure = next(row for row in payload["providers"] if row["name"] == "azure_openai")

    assert azure["configured"] is False


def test_create_model_configuration_accepts_azure_openai_aad_mode(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Provider-validation accepts azure_openai with only api_base (AAD mode)."""
    config_path = tmp_path / "config.json"
    config = Config()
    config.providers.azure_openai.api_base = "https://r.openai.azure.com"
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = create_model_configuration(
        {
            "label": ["Azure AAD"],
            "provider": ["azure_openai"],
            "model": ["my-deployment"],
        }
    )

    assert payload["agent"]["model_preset"] == "azure-aad"
    saved = load_config(config_path)
    assert saved.model_presets["azure-aad"].provider == "azure_openai"
    assert saved.model_presets["azure-aad"].model == "my-deployment"


def test_create_model_configuration_accepts_reasoning_effort(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.providers.openai.api_key = "sk-test"
    save_config(config, config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    payload = create_model_configuration(
        {
            "label": ["Think preset"],
            "provider": ["openai"],
            "model": ["openai/gpt-5"],
            "reasoning_effort": ["medium"],
        }
    )

    assert payload["agent"]["model_preset"] == "think-preset"
    rows = {row["name"]: row for row in payload["model_presets"]}
    assert rows["think-preset"]["reasoning_effort"] == "medium"
    saved = load_config(config_path)
    assert saved.model_presets["think-preset"].reasoning_effort == "medium"


def test_create_model_configuration_rejects_azure_openai_without_base(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """azure_openai without api_base must still be rejected as not configured."""
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    with pytest.raises(WebUISettingsError, match="provider is not configured"):
        create_model_configuration(
            {
                "label": ["Azure"],
                "provider": ["azure_openai"],
                "model": ["my-deployment"],
            }
        )


def test_azure_openai_spec_no_longer_requires_api_key() -> None:
    """Contract guard: api_key is optional for azure_openai (AAD fallback)."""
    from nanobot.webui.settings_api import _provider_requires_api_key

    spec = find_by_name("azure_openai")
    assert spec is not None
    assert _provider_requires_api_key(spec) is False
