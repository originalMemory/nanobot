from __future__ import annotations

import pytest

from nanobot.webui.workspace_files import (
    WorkspaceFilesError,
    list_workspace_dir,
    read_workspace_file,
    resolve_workspace_relative_path,
)


@pytest.fixture
def workspace(tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    (root / "README.md").write_text("# hello\n", encoding="utf-8")
    (root / "config.json").write_text('{"a":1}', encoding="utf-8")
    memory = root / "memory"
    memory.mkdir()
    (memory / "MEMORY.md").write_text("memory content", encoding="utf-8")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "pkg").mkdir()
    (root / "script.py").write_text("print('ok')\n", encoding="utf-8")
    (root / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    return root


def test_list_root(workspace) -> None:
    payload = list_workspace_dir(workspace, "")
    names = {entry["name"] for entry in payload["entries"]}
    assert payload["path"] == ""
    assert "README.md" in names
    assert "memory" in names
    assert "node_modules" not in names


def test_list_nested_dir(workspace) -> None:
    payload = list_workspace_dir(workspace, "memory")
    assert payload["path"] == "memory"
    assert payload["entries"] == [{"name": "MEMORY.md", "kind": "file"}]


def test_read_markdown(workspace) -> None:
    payload = read_workspace_file(workspace, "memory/MEMORY.md")
    assert payload["kind"] == "text"
    assert payload["content"] == "memory content"
    assert payload["encoding"] == "utf-8"
    assert payload["truncated"] is False


def test_read_json(workspace) -> None:
    payload = read_workspace_file(workspace, "config.json")
    assert payload["kind"] == "text"
    assert payload["content"] == '{"a":1}'


def test_read_image_as_base64(workspace) -> None:
    payload = read_workspace_file(workspace, "image.png")
    assert payload["kind"] == "image"
    assert payload["mime_type"] == "image/png"
    assert payload["content_base64"]
    assert payload["truncated"] is False


def test_read_rejects_svg(workspace) -> None:
    (workspace / "icon.svg").write_text("<svg></svg>", encoding="utf-8")
    with pytest.raises(WorkspaceFilesError) as exc:
        read_workspace_file(workspace, "icon.svg")
    assert exc.value.status == 415


def test_read_rejects_oversized_image(workspace, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("nanobot.webui.workspace_files.MAX_READ_BYTES", 4)
    with pytest.raises(WorkspaceFilesError) as exc:
        read_workspace_file(workspace, "image.png")
    assert exc.value.status == 413


def test_read_rejects_path_traversal(workspace) -> None:
    with pytest.raises(WorkspaceFilesError) as exc:
        resolve_workspace_relative_path(workspace, "../outside")
    assert exc.value.status == 403


def test_read_rejects_missing_file(workspace) -> None:
    with pytest.raises(WorkspaceFilesError) as exc:
        read_workspace_file(workspace, "missing.md")
    assert exc.value.status == 404


def test_read_truncates_large_file(workspace, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("nanobot.webui.workspace_files.MAX_READ_BYTES", 16)
    big = workspace / "big.txt"
    big.write_text("x" * 64, encoding="utf-8")
    payload = read_workspace_file(workspace, "big.txt")
    assert len(payload["content"]) == 16
    assert payload["truncated"] is True
    assert payload["size_bytes"] == 64


def test_list_rejects_file_path(workspace) -> None:
    with pytest.raises(WorkspaceFilesError) as exc:
        list_workspace_dir(workspace, "README.md")
    assert exc.value.status == 400
