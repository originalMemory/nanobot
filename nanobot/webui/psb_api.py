"""PSB 模型 HTTP API 处理函数。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

PSB_STATIC_DIR = Path(__file__).resolve().parents[1] / "web" / "psb"

from nanobot.config.schema import PSBInitialState
from nanobot.webui.http_utils import query_first as _query_first
from nanobot.webui.psb_store import (
    PsbStoreError,
    build_resource_manifest,
    delete_model,
    get_model,
    list_models,
    rescan_model,
    resolve_model_file,
    retry_translation,
    save_initial_state,
    merge_runtime_metadata,
)


class PsbApiError(ValueError):
    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _wrap_store_error(exc: PsbStoreError) -> PsbApiError:
    return PsbApiError(exc.message, status=exc.status)


def psb_models_list_payload() -> dict[str, Any]:
    return {"models": list_models()}


def psb_model_detail_payload(model_id: str) -> dict[str, Any]:
    try:
        return {"model": get_model(model_id)}
    except PsbStoreError as exc:
        raise _wrap_store_error(exc) from exc


def psb_delete_payload(model_id: str) -> dict[str, Any]:
    try:
        return delete_model(model_id)
    except PsbStoreError as exc:
        raise _wrap_store_error(exc) from exc


async def psb_rescan_payload(model_id: str) -> dict[str, Any]:
    try:
        metadata = await rescan_model(model_id)
    except PsbStoreError as exc:
        raise _wrap_store_error(exc) from exc
    return {"model": metadata}


async def psb_retry_translation_payload(model_id: str) -> dict[str, Any]:
    try:
        metadata = await retry_translation(model_id)
    except PsbStoreError as exc:
        raise _wrap_store_error(exc) from exc
    return {"model": metadata}


def psb_save_initial_state_payload(model_id: str, query: dict[str, list[str]]) -> dict[str, Any]:
    raw = _query_first(query, "state")
    if raw is None:
        raise PsbApiError("state is required")
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PsbApiError("state must be JSON") from exc
    if not isinstance(decoded, dict):
        raise PsbApiError("state must be a JSON object")
    state = PSBInitialState(
        timeline=str(decoded.get("timeline") or ""),
        expression=str(decoded.get("expression") or ""),
        face={k: float(v) for k, v in (decoded.get("face") or {}).items()},
        fade={k: float(v) for k, v in (decoded.get("fade") or {}).items()},
    )
    try:
        metadata = save_initial_state(model_id, state)
    except PsbStoreError as exc:
        raise _wrap_store_error(exc) from exc
    return {"model": metadata}


async def psb_runtime_metadata_payload(model_id: str, query: dict[str, list[str]]) -> dict[str, Any]:
    raw = _query_first(query, "payload")
    if raw is None:
        raise PsbApiError("payload is required")
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PsbApiError("payload must be JSON") from exc
    if not isinstance(decoded, dict):
        raise PsbApiError("payload must be a JSON object")
    try:
        metadata = await merge_runtime_metadata(model_id, decoded)
    except PsbStoreError as exc:
        raise _wrap_store_error(exc) from exc
    return {"model": metadata}


def psb_manifest_payload(model_id: str) -> dict[str, Any]:
    try:
        return build_resource_manifest(model_id)
    except PsbStoreError as exc:
        raise _wrap_store_error(exc) from exc


def psb_resolve_file(model_id: str, rel_path: str):
    try:
        return resolve_model_file(model_id, rel_path)
    except PsbStoreError as exc:
        raise _wrap_store_error(exc) from exc
