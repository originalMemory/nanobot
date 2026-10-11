import base64
import json
from pathlib import Path

from nanobot.webui.image_favorites import collect_image

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


def test_collect_image_uses_sidecar_and_is_idempotent(tmp_path: Path) -> None:
    source = tmp_path / "media" / "generated" / "img_1.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(PNG)
    source.with_suffix(".json").write_text(json.dumps({
        "title": "阳台秋日",
        "model": "White_Marble",
        "prompt": "a prompt",
    }), encoding="utf-8")

    first = collect_image(source, workspace=tmp_path, timezone="Asia/Shanghai")
    second = collect_image(source, workspace=tmp_path, timezone="Asia/Shanghai")

    assert first["title"] == "阳台秋日"
    metadata = json.loads(source.with_suffix(".json").read_text(encoding="utf-8"))
    assert metadata["favorited"] is True
    assert metadata["favorite_file"] == first["file"]
    assert second["already"] is True
    records = (tmp_path / "data/image-sharing/prompt-gallery.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(records) == 1
