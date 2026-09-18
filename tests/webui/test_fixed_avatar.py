from unittest.mock import Mock

from websockets.datastructures import Headers
from websockets.http11 import Request

from nanobot.webui.media_gateway import WebUIMediaGateway
from nanobot.webui.ws_http import GatewayHTTPHandler


def test_fixed_avatar_priority_and_missing_file(tmp_path):
    media = WebUIMediaGateway(workspace_path=tmp_path, logger=Mock(), media_dir=lambda _: tmp_path)
    assert media.serve_avatar().status_code == 404
    for name, content in (("avatar.webp", b"webp"), ("avatar.png", b"png"), ("avatar.jpg", b"jpg")):
        (tmp_path / name).write_bytes(content)
        response = media.serve_avatar()
        assert response.status_code == 200
        assert response.body == content
    assert response.headers["Content-Type"] == "image/jpeg"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_avatar_route_is_fixed_and_does_not_follow_outside_symlink(tmp_path):
    root = tmp_path / "media"
    root.mkdir()
    private = tmp_path / "private.png"
    private.write_bytes(b"private")
    (root / "avatar.jpg").symlink_to(private)
    (root / "avatar.png").write_bytes(b"fixed-avatar")
    handler = object.__new__(GatewayHTTPHandler)
    handler.media = WebUIMediaGateway(workspace_path=tmp_path, logger=Mock(), media_dir=lambda _: root)
    request = Request("/api/avatar", Headers())
    response = handler._dispatch_media_routes(request, "/api/avatar")
    assert response is not None and response.body == b"fixed-avatar"
    assert handler._dispatch_media_routes(request, "/api/avatar/private.png") is None
