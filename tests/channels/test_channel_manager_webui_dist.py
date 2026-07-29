from pathlib import Path

import nanobot.web
from nanobot.channels.manager import _default_webui_dist


def test_default_webui_dist_prefers_source_bundle(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_package = tmp_path / "source" / "nanobot" / "web"
    source_dist = source_package / "dist"
    fallback_dist = tmp_path / "image-dist"
    source_dist.mkdir(parents=True)
    fallback_dist.mkdir()

    monkeypatch.setattr(nanobot.web, "__file__", str(source_package / "__init__.py"))
    monkeypatch.setenv("NANOBOT_WEBUI_DIST", str(fallback_dist))

    assert _default_webui_dist() == source_dist


def test_default_webui_dist_falls_back_to_image_bundle(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_package = tmp_path / "source" / "nanobot" / "web"
    fallback_dist = tmp_path / "image-dist"
    source_package.mkdir(parents=True)
    fallback_dist.mkdir()

    monkeypatch.setattr(nanobot.web, "__file__", str(source_package / "__init__.py"))
    monkeypatch.setenv("NANOBOT_WEBUI_DIST", str(fallback_dist))

    assert _default_webui_dist() == fallback_dist
