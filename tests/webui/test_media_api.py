from pathlib import Path

from nanobot.webui.media_api import sign_or_stage_media_path, signed_media_attachments


def test_staging_media_carries_image_sidecar(tmp_path: Path) -> None:
    media = tmp_path / "media"
    media.mkdir()
    source = tmp_path / "workspace" / "image.png"
    source.parent.mkdir()
    source.write_bytes(b"png")
    source.with_suffix(".json").write_text('{"title":"title"}', encoding="utf-8")

    def media_dir(channel: str | None) -> Path:
        target = media if channel is None else media / channel
        target.mkdir(parents=True, exist_ok=True)
        return target

    staged = sign_or_stage_media_path(
        source,
        secret=b"secret",
        media_dir=media_dir,
    )

    assert staged is not None
    staged_dir = media / "websocket"
    assert any(path.suffix == ".json" and path.read_text(encoding="utf-8") == '{"title":"title"}' for path in staged_dir.glob("*.json"))


def test_signed_media_attachments_reads_dimensions_from_sidecar(tmp_path: Path) -> None:
    image = tmp_path / "image.png"
    image.write_bytes(b"png")
    image.with_suffix(".json").write_text(
        '{"width": 640, "height": 480}', encoding="utf-8"
    )

    attachments = signed_media_attachments(
        [str(image)],
        sign_path=lambda path: {"url": "/api/media/image", "name": path.name},
    )

    assert attachments == [{
        "kind": "image",
        "url": "/api/media/image",
        "name": "image.png",
        "width": 640,
        "height": 480,
    }]
