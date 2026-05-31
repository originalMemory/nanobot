"""Tests for outbound media staging helpers."""

from __future__ import annotations

from pathlib import Path

from nanobot.utils.media_staging import (
    _staging_prefix,
    is_remote_media_url,
    normalize_outbound_media,
    stage_media_file,
)


def test_stage_media_file_copies_workspace_artifact_once(tmp_path, monkeypatch) -> None:
    media_root = tmp_path / "media"
    monkeypatch.setattr(
        "nanobot.utils.media_staging.get_media_dir",
        lambda channel=None: media_root / (channel or ""),
    )
    source = tmp_path / "outputs" / "comfy" / "photo.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"png-bytes")

    first = stage_media_file(source, channel="websocket")
    second = stage_media_file(source, channel="websocket")

    assert first is not None
    assert second == first
    assert first.is_file()
    assert first.read_bytes() == b"png-bytes"
    assert list((media_root / "websocket").iterdir()) == [first]


def test_stage_media_file_keeps_existing_media_path(tmp_path, monkeypatch) -> None:
    media_root = tmp_path / "media"
    monkeypatch.setattr(
        "nanobot.utils.media_staging.get_media_dir",
        lambda channel=None: media_root,
    )
    existing = media_root / "websocket" / "already.png"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"cached")

    staged = stage_media_file(existing, channel="websocket")

    assert staged == existing.resolve()
    assert list((media_root / "websocket").iterdir()) == [existing]


def test_normalize_outbound_media_preserves_urls_and_stages_locals(
    tmp_path,
    monkeypatch,
) -> None:
    media_root = tmp_path / "media"
    monkeypatch.setattr(
        "nanobot.utils.media_staging.get_media_dir",
        lambda channel=None: media_root / (channel or ""),
    )
    source = tmp_path / "artifact.jpg"
    source.write_bytes(b"jpeg")

    out = normalize_outbound_media(
        ["https://example.test/a.jpg", str(source)],
        channel="websocket",
    )

    assert out[0] == "https://example.test/a.jpg"
    assert Path(out[1]).is_file()
    assert Path(out[1]).read_bytes() == b"jpeg"


def test_is_remote_media_url_only_accepts_http_urls() -> None:
    assert is_remote_media_url("https://example.test/a.jpg")
    assert is_remote_media_url("http://example.test/a.jpg")
    assert not is_remote_media_url("/tmp/a.jpg")
    assert not is_remote_media_url("file:///tmp/a.jpg")


def test_staging_prefix_large_file_skips_content_read(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("nanobot.utils.media_staging._FULL_HASH_MAX_BYTES", 1024)
    source = tmp_path / "large.bin"
    source.write_bytes(b"x" * 2048)

    def fail_open(self, *args, **kwargs):
        if self.resolve() == source.resolve():
            raise AssertionError("大文件 staging 不应读取文件内容")
        return open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", fail_open)

    prefix = _staging_prefix(source.resolve())
    assert prefix is not None
    assert len(prefix) == 16
    assert prefix == _staging_prefix(source.resolve())


def test_stage_media_file_large_file_dedups_by_stat_fingerprint(tmp_path, monkeypatch) -> None:
    media_root = tmp_path / "media"
    monkeypatch.setattr(
        "nanobot.utils.media_staging.get_media_dir",
        lambda channel=None: media_root / (channel or ""),
    )
    monkeypatch.setattr("nanobot.utils.media_staging._FULL_HASH_MAX_BYTES", 1024)
    source = tmp_path / "large.bin"
    source.write_bytes(b"x" * 2048)

    first = stage_media_file(source, channel="websocket")
    second = stage_media_file(source, channel="websocket")

    assert first is not None
    assert second == first
    assert first.is_file()
    assert list((media_root / "websocket").iterdir()) == [first]
