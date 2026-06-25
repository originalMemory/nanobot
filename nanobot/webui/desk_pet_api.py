"""统一桌宠（deskPet）设置 API。"""

from __future__ import annotations

from typing import Any

from nanobot.config.loader import load_config, save_config
from nanobot.webui.psb_store import list_models
from nanobot.webui.tha_api import THAApiError, tha_payload, update_tha_config


class DeskPetApiError(ValueError):
    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def psb_config_payload() -> dict[str, Any]:
    config = load_config().desk_pet.psb
    return {
        "autoShow": config.auto_show,
        "selectedModelId": config.selected_model_id,
        "followMouse": config.follow_mouse,
        "enabledResponseTags": config.enabled_response_tags,
        "models": list_models(),
    }


def desk_pet_payload() -> dict[str, Any]:
    return {
        "tha": tha_payload(),
        "psb": psb_config_payload(),
    }


def update_desk_pet_tha_config(query: dict[str, list[str]]) -> dict[str, Any]:
    try:
        update_tha_config(query)
    except THAApiError as exc:
        raise DeskPetApiError(exc.message, status=exc.status) from exc
    return desk_pet_payload()


def update_desk_pet_psb_config(query: dict[str, list[str]]) -> dict[str, Any]:
    config = load_config()
    psb = config.desk_pet.psb
    bool_changed = False

    def first(*keys: str) -> str | None:
        for key in keys:
            values = query.get(key)
            if values:
                return values[0]
        return None

    def parse_bool(value: str, name: str) -> bool:
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        raise DeskPetApiError(f"{name} must be a boolean")

    bool_fields = [
        ("autoShow", "auto_show"),
        ("followMouse", "follow_mouse"),
        ("enabledResponseTags", "enabled_response_tags"),
    ]
    for query_key, attr in bool_fields:
        value = first(query_key, attr)
        if value is None:
            continue
        parsed = parse_bool(value, query_key)
        if getattr(psb, attr) != parsed:
            setattr(psb, attr, parsed)
            bool_changed = True

    if bool_changed:
        save_config(config)

    selected = first("selectedModelId", "selected_model_id")
    if selected is not None:
        model_id = selected.strip() or None
        from nanobot.webui.psb_store import PsbStoreError, select_model

        try:
            select_model(model_id)
        except PsbStoreError as exc:
            raise DeskPetApiError(exc.message, status=exc.status) from exc

    return desk_pet_payload()
