from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

from nanobot.webui.fork_http import ForkGatewayHTTPHandler


def _handler(diary_path: Path | None) -> ForkGatewayHTTPHandler:
    handler = object.__new__(ForkGatewayHTTPHandler)
    handler.check_api_token = lambda _request: True
    handler._diary_path = diary_path
    return handler


def test_diary_routes_list_and_read_configured_root(tmp_path: Path) -> None:
    diary = tmp_path / "diary"
    target = diary / "2026" / "07"
    target.mkdir(parents=True)
    note = target / "2026-07-12 周日.md"
    note.write_text(
        "---\n概要: 测试\n心情:\n  - 开心\nbanner: '[[banner.jpg]]'\n"
        "created: 2026-07-12T08:00\n---\n# 今天\n![[moon.jpg|500]]\n",
        encoding="utf-8",
    )
    assets = tmp_path / "assets" / "images" / "2026" / "07"
    assets.mkdir(parents=True)
    (assets / "moon.jpg").write_bytes(b"jpeg")
    handler = _handler(diary)

    listed = handler._handle_diary_list(MagicMock(path="/api/diary/list?path=2026/07"))
    read = handler._handle_diary_read(
        MagicMock(path="/api/diary/read?path=2026/07/2026-07-12%20%E5%91%A8%E6%97%A5.md")
    )

    assert listed.status_code == 200
    assert json.loads(listed.body)["entries"] == [
        {"name": "2026-07-12 周日.md", "kind": "file"},
    ]
    assert read.status_code == 200
    body = json.loads(read.body)
    assert body["content"] == "# 今天\n![[moon.jpg|500]]\n"
    assert body["frontmatter"] == {
        "概要": "测试",
        "心情": ["开心"],
        "banner": "[[banner.jpg]]",
        "created": "2026-07-12T08:00",
    }

    image = handler._handle_diary_image(
        MagicMock(path="/api/diary/image?note=2026/07/2026-07-12%20%E5%91%A8%E6%97%A5.md&name=moon.jpg")
    )
    assert image.status_code == 200
    assert json.loads(image.body)["kind"] == "image"


def test_diary_routes_report_unconfigured_root() -> None:
    response = _handler(None)._handle_diary_list(MagicMock(path="/api/diary/list"))

    assert response.status_code == 404
    assert response.body.decode() == "diary root is not configured"


def test_diary_image_rejects_path_escape(tmp_path: Path) -> None:
    diary = tmp_path / "diary"
    note = diary / "2026" / "07" / "2026-07-12 周日.md"
    note.parent.mkdir(parents=True)
    note.write_text("ok", encoding="utf-8")

    response = _handler(diary)._handle_diary_image(
        MagicMock(path="/api/diary/image?note=2026/07/2026-07-12%20%E5%91%A8%E6%97%A5.md&name=../secret.png")
    )

    assert response.status_code == 400
