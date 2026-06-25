from __future__ import annotations

import asyncio

import pytest

from nanobot.config.loader import load_config, save_config
from nanobot.config.schema import Config
from nanobot.webui.psb_store import (
    PsbStoreError,
    delete_model,
    get_model,
    list_models,
    merge_runtime_metadata,
    resolve_model_file,
    scan_psb_models,
)
from nanobot.webui.settings_api import update_desk_pet_psb_settings


def make_psb_v3_stub(size: int = 64) -> bytes:
    data = bytearray(size)
    data[0:3] = b"PSB"
    data[4] = 3
    data[5] = 0
    return bytes(data)


@pytest.fixture
def psb_runtime(tmp_path, monkeypatch: pytest.MonkeyPatch):
    config_path = tmp_path / "config.json"
    save_config(Config(), config_path)
    monkeypatch.setattr("nanobot.config.loader._current_config_path", config_path)

    async def fake_translate(labels: list[str]) -> tuple[dict[str, str], str]:
        return {label: f"{label}-zh" for label in labels}, "done"

    monkeypatch.setattr("nanobot.webui.psb_store.translate_psb_labels", fake_translate)
    return tmp_path


def place_psb_file(
    psb_runtime,
    filename: str = "demo.psb",
    *,
    body: bytes | None = None,
) -> None:
    psb_dir = psb_runtime / "desk_pets" / "psb"
    psb_dir.mkdir(parents=True)
    (psb_dir / filename).write_bytes(body if body is not None else make_psb_v3_stub())


@pytest.mark.asyncio
async def test_scan_psb_models_registers_flat_psb_file(psb_runtime) -> None:
    place_psb_file(psb_runtime)
    assert list_models() == []

    discovered = await scan_psb_models()
    assert discovered == ["demo"]
    assert len(list_models()) == 1
    assert list_models()[0]["modelId"] == "demo"
    assert list_models()[0]["compatible"] is True

    meta_path = psb_runtime / "desk_pets" / "psb" / "demo.psb.meta.json"
    metadata = meta_path.read_text(encoding="utf-8")
    assert '"format": "psb"' in metadata
    assert '"psbFile": "demo.psb"' in metadata
    assert '"translationStatus": "skipped"' in metadata


@pytest.mark.asyncio
async def test_scan_psb_models_skips_existing_sidecar(psb_runtime) -> None:
    place_psb_file(psb_runtime)
    await scan_psb_models()
    assert await scan_psb_models() == []


@pytest.mark.asyncio
async def test_delete_model_clears_selection(psb_runtime) -> None:
    place_psb_file(psb_runtime)
    await scan_psb_models()
    model_id = "demo"

    config = load_config()
    config.desk_pet.psb.selected_model_id = model_id
    save_config(config)

    result = delete_model(model_id)
    assert result["clearedSelection"] is True
    assert list_models() == []
    saved = load_config()
    assert saved.desk_pet.psb.selected_model_id is None
    assert not (psb_runtime / "desk_pets" / "psb" / "demo.psb").exists()


def test_resolve_model_file_blocks_escape(psb_runtime) -> None:
    place_psb_file(psb_runtime)
    meta_path = psb_runtime / "desk_pets" / "psb" / "demo.psb.meta.json"
    meta_path.write_text(
        '{"modelId":"demo","psbFile":"demo.psb","compatible":true}',
        encoding="utf-8",
    )

    path = resolve_model_file("demo", "demo.psb")
    assert path.name == "demo.psb"
    with pytest.raises(PsbStoreError, match="file not found"):
        resolve_model_file("demo", "../demo.psb")


def test_resolve_model_file_accepts_url_encoded_filename(psb_runtime) -> None:
    filename = "茑町千岁-热带风情泳装.psb"
    place_psb_file(psb_runtime, filename)
    meta_path = psb_runtime / "desk_pets" / "psb" / f"{filename}.meta.json"
    meta_path.write_text(
        f'{{"modelId":"psb-model","psbFile":"{filename}","compatible":true}}',
        encoding="utf-8",
    )
    from urllib.parse import quote

    encoded = quote(filename, safe="")
    path = resolve_model_file("psb-model", encoded)
    assert path.name == filename


def test_parse_psb_v4_header_is_compatible(tmp_path) -> None:
    from nanobot.webui.psb_parser import parse_psb_file

    psb_path = tmp_path / "v4.psb"
    body = make_psb_v3_stub()
    data = bytearray(body)
    data[4] = 4
    psb_path.write_bytes(bytes(data))

    result = parse_psb_file(psb_path)
    assert result.compatible is True
    assert result.web_sdk_likely is False
    assert result.psb_version == 4
    assert result.error is None


@pytest.mark.asyncio
async def test_update_desk_pet_psb_settings_persists_flags(psb_runtime) -> None:
    place_psb_file(psb_runtime)
    await scan_psb_models()
    model_id = "demo"

    payload = update_desk_pet_psb_settings(
        {
            "autoShow": ["true"],
            "followMouse": ["false"],
            "enabledResponseTags": ["true"],
            "selectedModelId": [model_id],
        }
    )

    psb = payload["deskPet"]["psb"]
    assert psb["autoShow"] is True
    assert psb["followMouse"] is False
    assert psb["enabledResponseTags"] is True
    assert psb["selectedModelId"] == model_id
    assert "modelsDir" not in psb

    saved = load_config()
    assert saved.desk_pet.psb.auto_show is True
    assert saved.desk_pet.psb.follow_mouse is False
    assert saved.desk_pet.psb.selected_model_id == model_id


@pytest.mark.asyncio
async def test_merge_runtime_metadata_persists_capabilities(psb_runtime) -> None:
    place_psb_file(psb_runtime)
    await scan_psb_models()

    runtime = {
        "timelines": [
            {"label": "待機", "looping": True},
            {"label": "走る", "looping": False},
        ],
        "expressions": [{"label": "通常"}],
        "faceVariables": [
            {
                "label": "face_mouth",
                "minValue": 0,
                "maxValue": 1,
                "frames": [{"label": "閉じ", "value": 0}],
            }
        ],
        "fadeVariables": [],
        "hasFaceTalk": True,
    }

    metadata = await merge_runtime_metadata("demo", runtime)
    assert len(metadata["timelines"]) == 2
    assert metadata["timelines"][0]["label"] == "待機"
    assert metadata["timelines"][0]["looping"] is True
    assert metadata["expressions"][0]["label"] == "通常"
    assert metadata["faceVariables"][0]["label"] == "face_mouth"
    assert metadata["hasFaceTalk"] is True

    stored = get_model("demo")
    assert len(stored["timelines"]) == 2
    assert stored["initialState"]["timeline"] == ""


@pytest.mark.asyncio
async def test_merge_runtime_metadata_writes_compact_timeline_fields(psb_runtime) -> None:
    place_psb_file(psb_runtime)
    await scan_psb_models()

    metadata = await merge_runtime_metadata(
        "demo",
        {
            "timelines": [
                {"label": "待機", "looping": True},
                {"label": "走る", "looping": False},
            ],
        },
    )

    idle = next(item for item in metadata["timelines"] if item["label"] == "待機")
    once = next(item for item in metadata["timelines"] if item["label"] == "走る")
    assert idle["looping"] is True
    assert once["looping"] is False
    assert "loopBegin" not in idle
    assert "diff" not in idle

    stored = get_model("demo")
    assert stored["timelines"][0] == {"label": "待機", "looping": True}
    assert stored["timelines"][1] == {"label": "走る", "looping": False}
    assert "psbVersion" not in stored
    assert "parseError" not in stored


@pytest.mark.asyncio
async def test_compact_metadata_omits_duplicate_label_zh(psb_runtime) -> None:
    from nanobot.webui.psb_store import _compact_metadata

    compact = _compact_metadata(
        {
            "modelId": "demo",
            "name": "Demo",
            "format": "psb",
            "compatible": True,
            "psbFile": "demo.psb",
            "hasFaceTalk": True,
            "translationStatus": "done",
            "parseError": None,
            "psbVersion": 4,
            "webSdkLikely": False,
            "timelines": [{"label": "待機", "labelZh": "待机", "looping": True}],
            "expressions": [{"label": "通常", "labelZh": "通常"}],
            "faceVariables": [
                {
                    "label": "face_mouth",
                    "labelZh": "face_mouth",
                    "hint": "",
                    "hintZh": "",
                    "minValue": 0,
                    "maxValue": 1,
                    "frames": [{"label": "閉じ", "labelZh": "闭上", "value": 0}],
                }
            ],
            "fadeVariables": [],
            "initialState": {"timeline": "", "expression": "", "face": {}, "fade": {}},
        }
    )
    assert compact["timelines"] == [{"label": "待機", "labelZh": "待机", "looping": True}]
    assert compact["expressions"] == [{"label": "通常"}]
    assert compact["faceVariables"][0]["label"] == "face_mouth"
    assert "labelZh" not in compact["faceVariables"][0]
    assert compact["faceVariables"][0]["frames"] == [{"label": "閉じ", "labelZh": "闭上", "value": 0}]
    assert "hint" not in compact["faceVariables"][0]
    assert "psbVersion" not in compact


@pytest.mark.asyncio
async def test_merge_runtime_metadata_keeps_fade_machine_names(psb_runtime) -> None:
    place_psb_file(psb_runtime)
    await scan_psb_models()

    metadata = await merge_runtime_metadata(
        "demo",
        {
            "timelines": [],
            "expressions": [],
            "faceVariables": [],
            "fadeVariables": [{"label": "fade_w", "minValue": 0, "maxValue": 1}],
            "hasFaceTalk": False,
        },
    )

    fade = metadata["fadeVariables"][0]
    assert fade["label"] == "fade_w"
    assert fade["labelZh"] == "fade_w"
    assert "hint" not in fade
    assert "hintZh" not in fade


@pytest.mark.asyncio
async def test_merge_runtime_metadata_partial_patch_preserves_other_sections(psb_runtime) -> None:
    place_psb_file(psb_runtime)
    await scan_psb_models()

    await merge_runtime_metadata(
        "demo",
        {
            "timelines": [{"label": "待機", "looping": True}],
            "expressions": [{"label": "通常"}],
            "hasFaceTalk": True,
        },
    )

    metadata = await merge_runtime_metadata(
        "demo",
        {
            "fadeVariables": [
                {"label": "fade_w", "minValue": 0, "maxValue": 1},
                {"label": "fade_x", "minValue": 0, "maxValue": 1},
            ],
        },
    )

    assert len(metadata["timelines"]) == 1
    assert metadata["timelines"][0]["label"] == "待機"
    assert metadata["expressions"][0]["label"] == "通常"
    assert metadata["hasFaceTalk"] is True
    assert {item["label"] for item in metadata["fadeVariables"]} == {"fade_w", "fade_x"}


@pytest.mark.asyncio
async def test_merge_runtime_metadata_fade_chunks_accumulate(psb_runtime) -> None:
    place_psb_file(psb_runtime)
    await scan_psb_models()

    await merge_runtime_metadata(
        "demo",
        {"fadeVariables": [{"label": "fade_a", "minValue": 0, "maxValue": 1}]},
    )
    metadata = await merge_runtime_metadata(
        "demo",
        {"fadeVariables": [{"label": "fade_b", "minValue": 0, "maxValue": 1}]},
    )

    labels = {item["label"] for item in metadata["fadeVariables"]}
    assert labels == {"fade_a", "fade_b"}


@pytest.mark.asyncio
async def test_merge_runtime_metadata_timeline_chunks_accumulate(psb_runtime) -> None:
    place_psb_file(psb_runtime)
    await scan_psb_models()

    await merge_runtime_metadata(
        "demo",
        {"timelines": [{"label": "待機", "looping": True}]},
    )
    metadata = await merge_runtime_metadata(
        "demo",
        {"timelines": [{"label": "走る", "looping": False}]},
    )

    labels = {item["label"] for item in metadata["timelines"]}
    assert labels == {"待機", "走る"}


@pytest.mark.asyncio
async def test_merge_runtime_metadata_schedules_background_translation(psb_runtime, monkeypatch) -> None:
    place_psb_file(psb_runtime)
    await scan_psb_models()

    called = False

    async def _spy_translate(labels: list[str]) -> tuple[dict[str, str], str]:
        nonlocal called
        called = True
        return {"待機": "待机"}, "done"

    monkeypatch.setattr("nanobot.webui.psb_store.translate_psb_labels", _spy_translate)

    metadata = await merge_runtime_metadata(
        "demo",
        {"timelines": [{"label": "待機", "looping": True}]},
    )

    assert called is False
    assert metadata["translationStatus"] == "translating"
    assert metadata["timelines"][0]["labelZh"] == "待機"

    await asyncio.sleep(0.6)
    for _ in range(20):
        if called:
            break
        await asyncio.sleep(0.1)
    assert called is True

    refreshed = get_model("demo")
    assert refreshed["translationStatus"] == "done"
    assert refreshed["timelines"][0]["labelZh"] == "待机"


@pytest.mark.asyncio
async def test_merge_runtime_metadata_retries_after_failed_translation(psb_runtime, monkeypatch) -> None:
    place_psb_file(psb_runtime)
    await scan_psb_models()
    metadata = get_model("demo")
    metadata["translationStatus"] = "failed"
    from nanobot.webui.psb_store import _write_metadata

    _write_metadata(metadata["psbFile"], metadata)

    called = False

    async def _spy_translate(labels: list[str]) -> tuple[dict[str, str], str]:
        nonlocal called
        called = True
        return {"待機": "待机"}, "done"

    monkeypatch.setattr("nanobot.webui.psb_store.translate_psb_labels", _spy_translate)

    updated = await merge_runtime_metadata(
        "demo",
        {"timelines": [{"label": "待機", "looping": True}]},
    )
    assert updated["translationStatus"] == "translating"

    await asyncio.sleep(0.6)
    for _ in range(20):
        if called:
            break
        await asyncio.sleep(0.1)
    assert called is True
    assert get_model("demo")["translationStatus"] == "done"
