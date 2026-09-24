from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from websockets.datastructures import Headers
from websockets.http11 import Request

from nanobot.config.schema import Config
from nanobot.webui.library import LibraryError, library_payload
from nanobot.webui.ws_http import GatewayHTTPHandler


def fixture(tmp_path):
    workspace = tmp_path / "workspace"
    diary = tmp_path / "note" / "日记"
    workspace.mkdir()
    diary.mkdir(parents=True)
    config = Config(agents={"defaults": {"workspace": str(workspace), "timezoneMode": "manual", "timezone": "Asia/Shanghai"}}, diaryRoot=str(diary))
    return config, workspace, diary


def read(config, source="workspace", action="read", path="", **kwargs):
    return library_payload(config, source=source, action=action, path=path, sign_image=lambda p: {"url": "/api/media/signed/" + p.name}, **kwargs)


def test_workspace_list_text_and_literal_filename(tmp_path):
    config, root, _ = fixture(tmp_path)
    (root / ".git").mkdir()
    (root / "folder").mkdir()
    (root / "a#b.md").write_text("# hello", encoding="utf-8")
    result = read(config, action="list")
    assert result["entries"] == [{"name": "folder", "kind": "dir"}, {"name": "a#b.md", "kind": "file"}]
    assert read(config, path="a#b.md")["content"] == "# hello"


def test_library_index_returns_documents_and_ignores_hidden_directories(tmp_path):
    config, root, _ = fixture(tmp_path)
    (root / "visible.md").write_text("", encoding="utf-8")
    (root / "folder").mkdir()
    (root / "folder" / "nested.markdown").write_text("", encoding="utf-8")
    (root / "folder" / "clip.mp4").write_bytes(b"video")
    (root / ".stversions").mkdir()
    (root / ".stversions" / "old.md").write_text("", encoding="utf-8")
    result = read(config, action="index")
    assert result["kind"] == "index"
    assert result["documents"] == ["folder/nested.markdown", "visible.md"]


@pytest.mark.parametrize("path", ["../private.txt", "/etc/passwd", "C:\\private.txt", "escape.txt"])
def test_library_rejects_traversal_and_symlinks(tmp_path, path):
    config, root, _ = fixture(tmp_path)
    private = tmp_path / "private.txt"
    private.write_text("private")
    (root / "escape.txt").symlink_to(private)
    with pytest.raises(LibraryError) as exc:
        read(config, path=path)
    assert exc.value.status == 403
    assert read(config, action="list")["entries"] == []


def test_today_diary_frontmatter_and_safe_image_mapping(tmp_path):
    config, _, diary = fixture(tmp_path)
    month = diary / "2026" / "09"
    month.mkdir(parents=True)
    note = month / "2026-09-18 周五.md"
    original = "---\nmood: good\n---\n# Today\n![[photo.png|200]]\n![private](../../../../private.png)"
    note.write_text(original, encoding="utf-8", newline="")
    assets = diary.parent / "assets" / "images" / "2026" / "09"
    assets.mkdir(parents=True)
    (assets / "photo.png").write_bytes(b"image")
    (tmp_path / "private.png").write_bytes(b"private")
    result = read(config, source="notes", action="today", now=datetime(2026, 9, 17, 16, 30, tzinfo=timezone.utc))
    assert result["path"] == "日记/2026/09/2026-09-18 周五.md"
    assert result["frontmatter"] == "mood: good"
    assert result["image_sources"]["photo.png"] == "/api/media/signed/photo.png"
    assert "../../../../private.png" not in result["image_sources"]
    assert result["images_omitted"] == 1
    assert result["raw_content"] == original
    assert note.read_text() == original


def test_binary_truncation_and_missing_diary(tmp_path):
    config, root, _ = fixture(tmp_path)
    (root / "binary").write_bytes(b"\x00binary")
    with pytest.raises(LibraryError) as exc:
        read(config, path="binary")
    assert exc.value.status == 415
    (root / "large.txt").write_text("a" * (400 * 1024))
    assert read(config, path="large.txt")["truncated"]
    config.diary_root = ""
    with pytest.raises(LibraryError) as exc:
        read(config, source="notes", action="list")
    assert exc.value.status == 404


@pytest.mark.asyncio
async def test_library_route_requires_auth_and_uses_configured_root(tmp_path):
    config, root, _ = fixture(tmp_path)
    (root / "hello.md").write_text("hello")
    handler = object.__new__(GatewayHTTPHandler)
    handler.check_api_token = lambda _: False
    request = Request("/api/library?source=workspace&action=list", Headers())
    response = await handler._dispatch_misc_routes(None, request, "/api/library")
    assert response.status_code == 401
    handler.check_api_token = lambda _: True
    handler.settings = SimpleNamespace(config=SimpleNamespace(load=lambda: config))
    handler.media = SimpleNamespace(sign_or_stage_media_path=Mock())
    response = await handler._dispatch_misc_routes(None, request, "/api/library")
    assert response.status_code == 200 and b"hello.md" in response.body


def test_markdown_images_preserve_code_titles_parentheses_and_references(tmp_path):
    config, root, _ = fixture(tmp_path)
    for name in ("photo.png", "photo(1).png", "code.png"):
        (root / name).write_bytes(b"image")
    text = '```md\n![example](code.png)\n```\n`![[code.png]]`\n![title](photo.png "Caption")\n![paren](photo(1).png)\n![ref][pic]\n\n[pic]: photo.png\n'
    (root / "note.md").write_text(text, encoding="utf-8", newline="")
    result = read(config, path="note.md")
    assert result["content"] == text
    assert result["raw_content"] == text
    assert set(result["image_sources"]) == {"photo.png", "photo(1).png"}
    assert result["images_omitted"] == 0


def test_image_limit_reports_omissions_without_charging_missing_or_repeated_images(tmp_path):
    config, root, _ = fixture(tmp_path)
    for i in range(9):
        (root / f"{i}.png").write_bytes(b"image")
    text = '![[missing.png]]\n![invalid](bad%00.png)\n' + '\n'.join(f'![photo]({i}.png)' for i in range(9)) + '\n![again](0.png)'
    (root / "note.md").write_text(text, encoding="utf-8", newline="")
    result = read(config, path="note.md")
    assert len(result["image_sources"]) == 8
    assert "7.png" in result["image_sources"]
    assert "8.png" not in result["image_sources"]
    assert result["images_omitted"] == 3
    assert result["content"] == text and result["raw_content"] == text
    assert result["truncated"] is False  # Byte truncation is distinct from omitted images.


def test_diary_webp_banner_properties_and_legacy_jpeg_references(tmp_path):
    config, _, diary = fixture(tmp_path)
    month = diary / "2026" / "09"
    month.mkdir(parents=True)
    assets = diary.parent / "assets" / "images" / "2026" / "09"
    assets.mkdir(parents=True)
    for name in ("cover.webp", "photo.webp", "original.jpg", "original.webp"):
        (assets / name).write_bytes(b"image")
    text = '---\nbanner: "[[cover.webp]]"\nbanner_y: 0.3\ntags: [日记, 生活]\ndate: 2026-09-18\n---\n![[photo.jpg|320x200]]\n![photo](photo.webp)\n![original](original.jpg)\n'
    (month / "note.md").write_text(text, encoding="utf-8", newline="")
    result = read(config, source="notes", path="日记/2026/09/note.md")
    assert result["properties"]["tags"] == ["日记", "生活"]
    assert result["properties"]["date"] == "2026-09-18"
    assert result["image_sources"] == {
        "cover.webp": "/api/media/signed/cover.webp",
        "photo.jpg": "/api/media/signed/photo.webp",
        "photo.webp": "/api/media/signed/photo.webp",
        "original.jpg": "/api/media/signed/original.jpg",
    }
    assert result["images_omitted"] == 0
    assert result["raw_content"] == text


def test_banner_webp_fallback_cannot_escape_library_and_yaml_aliases_stay_raw(tmp_path):
    config, root, _ = fixture(tmp_path)
    outside = tmp_path / "secret.webp"
    outside.write_bytes(b"private")
    (root / "cover.webp").symlink_to(outside)
    (root / "note.md").write_text('---\nbanner: "[[cover.jpg]]"\n---\nbody')
    result = read(config, path="note.md")
    assert result["image_sources"] == {} and result["images_omitted"] == 1
    (root / "note.md").write_text('---\nloop: &loop [*loop]\n---\nbody')
    result = read(config, path="note.md")
    assert result["properties"] == {} and "&loop" in result["raw_content"]
