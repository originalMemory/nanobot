"""Fork-specific HTTP route handler for WebSocketChannel.

Encapsulates all HTTP route handling that was previously inlined inside
WebSocketChannel, including fork-exclusive endpoints (Unified Inbox, avatar,
CLI Apps management) and in-house HMAC-based media signing.

The handler holds a shared :class:`GatewayTokenStore` with
``WebSocketChannel`` so that tokens minted via ``/webui/bootstrap`` are
consumed by the WebSocket handshake (and vice-versa).

有意未实现的 upstream 路由：

- ``GET /api/workspaces`` — 上游用于 WebUI 工作区选择器（默认项目路径、
  restricted/full 模式、localhost 控件权限）。本 fork 生产环境运行在 Docker
  容器内，文件系统边界由镜像/挂载决定，不需要 WebUI 侧的工作区沙箱限制；
  故不在 ``ForkGatewayHTTPHandler`` 中实现该端点。合并上游 WebUI 时若
  ``fetchWorkspaces`` 请求 404，前端会静默降级（``workspaces = null``）。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import mimetypes
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import unquote, urlparse

from loguru import logger
from websockets.http11 import Request as WsRequest
from websockets.http11 import Response

from nanobot.agent.tools.mcp import request_mcp_reload
from nanobot.command.builtin import builtin_command_palette
from nanobot.config.paths import get_media_dir, get_workspace_path
from nanobot.session import UNIFIED_SESSION_KEY
from nanobot.session.webui_turns import websocket_turn_wall_started_at
from nanobot.utils.media_staging import is_remote_media_url, stage_media_file
from nanobot.utils.subagent_channel_display import scrub_subagent_messages_for_channel
from nanobot.webui.cli_apps_api import cli_apps_action, cli_apps_payload
from nanobot.webui.gateway_tokens import GatewayTokenStore
from nanobot.webui.http_utils import (
    http_error as _http_error,
)
from nanobot.webui.http_utils import (
    http_json_response as _http_json_response,
)
from nanobot.webui.http_utils import (
    http_response as _http_response,
)
from nanobot.webui.http_utils import (
    is_localhost as _is_localhost,
)
from nanobot.webui.http_utils import (
    issue_route_secret_matches as _issue_route_secret_matches,
)
from nanobot.webui.http_utils import (
    normalize_config_path as _normalize_config_path,
)
from nanobot.webui.http_utils import (
    parse_query as _parse_query,
)
from nanobot.webui.http_utils import (
    parse_request_path as _parse_request_path,
)
from nanobot.webui.http_utils import (
    query_first as _query_first,
)
from nanobot.webui.mcp_presets_api import mcp_presets_settings_action
from nanobot.webui.settings_api import (
    WebUISettingsError,
    create_model_configuration,
    runtime_capabilities,
    settings_payload,
    update_agent_settings,
    update_image_generation_settings,
    update_model_configuration,
    update_network_safety_settings,
    update_desk_pet_psb_settings,
    update_desk_pet_tha_settings,
    update_provider_settings,
    update_tha_settings,
    update_web_search_settings,
)
from nanobot.webui.psb_api import (
    PSB_STATIC_DIR,
    PsbApiError,
    psb_delete_payload,
    psb_manifest_payload,
    psb_model_detail_payload,
    psb_models_list_payload,
    psb_resolve_file,
    psb_retry_translation_payload,
    psb_rescan_payload,
    psb_save_initial_state_payload,
    psb_runtime_metadata_payload,
)
from nanobot.webui.sidebar_state import read_webui_sidebar_state, write_webui_sidebar_state
from nanobot.webui.tha_api import (
    THA_STATIC_DIR,
    THAApiError,
    tha_models_payload,
    tha_payload,
    update_tha_config,
)
from nanobot.webui.thread_disk import delete_webui_thread
from nanobot.webui.transcript import (
    build_inbox_thread_from_session,
    build_webui_thread_response,
    rewrite_local_markdown_images,
)
from nanobot.webui.workspace_files import (
    WorkspaceFilesError,
    list_workspace_dir,
    read_workspace_file,
)

if TYPE_CHECKING:
    from nanobot.bus.queue import MessageBus
    from nanobot.session.manager import SessionManager
    from nanobot.webui.workspaces import WebUIWorkspaceController


# ---------------------------------------------------------------------------
# MCP settings header constants
# ---------------------------------------------------------------------------

_MCP_VALUES_HEADER = "X-Nanobot-MCP-Values"
_MCP_VALUES_HEADER_MAX_BYTES = 64 * 1024

# ---------------------------------------------------------------------------
# MCP preset action path map (mirrors websocket._MCP_PRESET_ACTIONS_BY_PATH)
# ---------------------------------------------------------------------------

_MCP_PRESET_ACTIONS_BY_PATH: dict[str, str] = {
    "/api/settings/mcp-presets/enable": "enable",
    "/api/settings/mcp-presets/remove": "remove",
    "/api/settings/mcp-presets/test": "test",
    "/api/settings/mcp-presets/custom": "custom",
    "/api/settings/mcp-presets/import": "import",
    "/api/settings/mcp-presets/import-cursor": "import-cursor",
    "/api/settings/mcp-presets/tools": "tools",
}

# ---------------------------------------------------------------------------
# Media MIME helpers
# ---------------------------------------------------------------------------

_MEDIA_ALLOWED_MIMES: frozenset[str] = frozenset({
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/ogg",
    "audio/aac",
    "audio/webm",
})

_MIME_FALLBACK: dict[str, str] = {
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".weba": "audio/webm",
}

_MIME_NORMALIZE: dict[str, str] = {
    "audio/mp4a-latm": "audio/mp4",
    "audio/x-wav": "audio/wav",
}


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _decode_api_key(raw_key: str) -> str | None:
    from urllib.parse import unquote as _unquote
    key = _unquote(raw_key)
    if re.fullmatch(r"[A-Za-z0-9_:.-]{1,128}", key) is None:
        return None
    return key


def _resolve_bootstrap_model_name(
    runtime_name: Callable[[], str | None] | None,
) -> str | None:
    if runtime_name is not None:
        try:
            raw = runtime_name()
        except Exception as e:
            logger.debug("bootstrap runtime model resolver failed: {}", e)
        else:
            if isinstance(raw, str):
                stripped = raw.strip()
                if stripped:
                    return stripped
    try:
        from nanobot.config.loader import load_config
        model = load_config().resolve_preset().model.strip()
        return model or None
    except Exception as e:
        logger.debug("bootstrap model_name could not load from config: {}", e)
        return None


def _is_websocket_channel_session_key(key: str) -> bool:
    return key.startswith("websocket:")


# ---------------------------------------------------------------------------
# ForkGatewayHTTPHandler
# ---------------------------------------------------------------------------


class ForkGatewayHTTPHandler:
    """HTTP route handler for the fork's WebSocketChannel.

    Handles all non-WebSocket HTTP traffic, including fork-exclusive endpoints:

    - ``GET /api/inbox/thread`` — Unified Inbox session replay
    - ``GET /api/avatar`` — bot avatar image from media root
    - ``GET /api/settings/cli-apps`` and ``/api/settings/cli-apps/*`` — CLI app management
    - ``/api/media/<sig>/<payload>`` — HMAC-signed media file serving

    Also exposes signing helpers so ``WebSocketChannel.send()`` can mint
    signed URLs for outbound media without reaching into this class's internals.
    """

    def __init__(
        self,
        *,
        config: Any,
        session_manager: SessionManager | None,
        static_dist_path: Path | None,
        workspace_path: Path | None,
        runtime_model_name: Callable[[], str | None] | None,
        runtime_model_setter: Callable[[str | None], None] | None,
        runtime_surface: str = "browser",
        runtime_capabilities_overrides: dict[str, Any] | None = None,
        workspaces: "WebUIWorkspaceController | None" = None,
        bus: MessageBus,
        tokens: GatewayTokenStore,
        media_secret: bytes,
        log: Any = logger,
    ) -> None:
        self.config = config
        self._session_manager = session_manager
        self._static_dist_path = (
            static_dist_path.resolve() if static_dist_path is not None else None
        )
        self._workspace_path = (
            Path(workspace_path).expanduser()
            if workspace_path is not None
            else get_workspace_path()
        ).resolve(strict=False)
        self._runtime_model_name = runtime_model_name
        self._runtime_model_setter = runtime_model_setter
        self._runtime_surface = runtime_surface
        self._runtime_capabilities_overrides = runtime_capabilities_overrides
        self._workspaces = workspaces
        self.bus = bus
        self._tokens = tokens
        self._media_secret = media_secret
        self._log = log
        self._settings_restart_sections: set[str] = set()
        self._broadcast_tha_event: Callable[[dict[str, Any]], Awaitable[int]] | None = None

    # -- Token management ---------------------------------------------------

    def check_api_token(self, request: WsRequest) -> bool:
        """Validate *request* against the multi-use API token pool."""
        return self._tokens.check_api_token(request)

    # -- Media signing (also called by WebSocketChannel.send) ---------------

    def sign_media_path(self, abs_path: Path) -> str | None:
        """Return a signed ``/api/media/<sig>/<payload>`` URL, or ``None``
        when *abs_path* resolves outside the media root."""
        try:
            media_root = get_media_dir().resolve()
            rel = abs_path.resolve().relative_to(media_root)
        except (OSError, ValueError):
            return None
        payload = _b64url_encode(rel.as_posix().encode("utf-8"))
        mac = hmac.new(
            self._media_secret, payload.encode("ascii"), hashlib.sha256
        ).digest()[:16]
        return f"/api/media/{_b64url_encode(mac)}/{payload}"

    def sign_or_stage_media_path(self, path: Path) -> dict[str, str] | None:
        """Stage *path* into the websocket media bucket if needed, then sign it.

        Outbound bot-generated files may live anywhere on disk; staging copies
        them under the media root so the signed URL can resolve later.
        """
        staged = stage_media_file(path, channel="websocket")
        if staged is None:
            return None
        signed = self.sign_media_path(staged)
        if signed is None:
            return None
        return {"url": signed, "name": path.name}

    def rewrite_local_markdown_images(self, text: str) -> str:
        """Rewrite ``![alt](local_file)`` links in *text* to signed media URLs."""
        return rewrite_local_markdown_images(
            text,
            workspace_path=self._workspace_path,
            sign_path=self.sign_or_stage_media_path,
        )

    @staticmethod
    def remote_media_payload(url: str) -> dict[str, str]:
        """Build a ``{"url": ..., "name": ...}`` dict for a remote URL."""
        parsed = urlparse(url)
        name = Path(unquote(parsed.path)).name or "attachment"
        return {"url": url, "name": name}

    def augment_media_urls(self, payload: dict[str, Any]) -> None:
        """Mutate *payload* in-place: replace each message's ``media`` path
        list with a ``media_urls`` list of signed fetch URLs."""
        messages = payload.get("messages")
        if not isinstance(messages, list):
            return
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            media = msg.get("media")
            if not isinstance(media, list) or not media:
                continue
            urls: list[dict[str, str]] = []
            for entry in media:
                if not isinstance(entry, str) or not entry:
                    continue
                if is_remote_media_url(entry):
                    urls.append(self.remote_media_payload(entry))
                    continue
                signed = self.sign_media_path(Path(entry))
                if signed is None:
                    continue
                urls.append({"url": signed, "name": Path(entry).name})
            if urls:
                msg["media_urls"] = urls
            msg.pop("media", None)

    def augment_transcript_media_paths(self, paths: list[str]) -> list[dict[str, Any]]:
        """Convert a list of local media paths to signed URL attachment dicts."""
        out: list[dict[str, Any]] = []
        for pstr in paths:
            path = Path(pstr)
            att = self.sign_or_stage_media_path(path)
            if att is None:
                continue
            mime, _ = mimetypes.guess_type(path.name)
            if mime and mime.startswith("audio/"):
                kind = "audio"
            elif mime and mime.startswith("video/"):
                kind = "video"
            else:
                kind = "image"
            out.append({"kind": kind, "url": att["url"], "name": att.get("name", path.name)})
        return out

    # -- HTTP dispatch ------------------------------------------------------

    async def dispatch(self, connection: Any, request: WsRequest) -> Any:
        """Route an HTTP request. Returns a ``Response`` or ``None``."""
        got, _ = _parse_request_path(request.path)

        # Token issue endpoint (legacy, optional)
        if self.config.token_issue_path:
            issue_expected = _normalize_config_path(self.config.token_issue_path)
            if got == issue_expected:
                return self._handle_token_issue(connection, request)

        # Bootstrap
        if got == "/webui/bootstrap":
            return self._handle_bootstrap(connection, request)

        # Sessions list
        if got == "/api/sessions":
            return self._handle_sessions_list(request)

        # Settings
        if got == "/api/settings":
            return self._handle_settings(request)
        if got == "/api/settings/update":
            return self._handle_settings_update(request)
        if got == "/api/settings/model-configurations/create":
            return self._handle_settings_model_configuration_create(request)
        if got == "/api/settings/model-configurations/update":
            return self._handle_settings_model_configuration_update(request)
        if got == "/api/settings/provider/update":
            return self._handle_settings_provider_update(request)
        if got == "/api/settings/web-search/update":
            return self._handle_settings_web_search_update(request)
        if got == "/api/settings/image-generation/update":
            return self._handle_settings_image_generation_update(request)
        if got == "/api/settings/tha/update":
            return self._handle_settings_tha_update(request)
        if got == "/api/settings/desk-pet/tha/update":
            return self._handle_settings_desk_pet_tha_update(request)
        if got == "/api/settings/desk-pet/psb/update":
            return self._handle_settings_desk_pet_psb_update(request)
        if got == "/api/settings/network-safety/update":
            return self._handle_settings_network_safety_update(request)
        if got == "/api/settings/cli-apps":
            return self._handle_settings_cli_apps(request)
        if got == "/api/settings/cli-apps/install":
            return await self._handle_settings_cli_apps_action(request, "install")
        if got == "/api/settings/cli-apps/update":
            return await self._handle_settings_cli_apps_action(request, "update")
        if got == "/api/settings/cli-apps/uninstall":
            return await self._handle_settings_cli_apps_action(request, "uninstall")
        if got == "/api/settings/cli-apps/test":
            return await self._handle_settings_cli_apps_action(request, "test")
        if got == "/api/settings/mcp-presets":
            return await self._handle_settings_mcp_presets(request)
        mcp_action = _MCP_PRESET_ACTIONS_BY_PATH.get(got)
        if mcp_action is not None:
            return await self._handle_settings_mcp_presets(request, mcp_action)

        # Misc
        # 上游 GET /api/workspaces 供 WebUI 工作区选择器读取默认 scope 与控件权限。
        # fork 生产跑 Docker，容器已隔离文件系统，不需要 WebUI 工作区限制，故不实现。
        if got == "/api/avatar":
            return self._handle_avatar_fetch()
        if got == "/api/commands":
            return self._handle_commands(request)
        if got == "/api/inbox/thread":
            return self._handle_inbox_thread(request)
        if got == "/api/webui/sidebar-state":
            return self._handle_webui_sidebar_state(request)
        if got == "/api/webui/sidebar-state/update":
            return self._handle_webui_sidebar_state_update(request)
        if got == "/api/workspace/list":
            return self._handle_workspace_list(request)
        if got == "/api/workspace/read":
            return self._handle_workspace_read(request)
        if got == "/api/tha":
            return self._handle_tha_payload(request)
        if got == "/api/tha/config/update":
            return self._handle_tha_config_update(request)
        if got == "/api/tha/model":
            return self._handle_tha_models(request, "fixed")
        if got == "/api/tha/play":
            return await self._handle_tha_play(request)

        psb_route = await self._dispatch_psb_routes(request, got)
        if psb_route is not None:
            return psb_route

        if got == "/tha.html":
            return self._serve_tha_asset("tha.html")
        if got == "/tha/tha.js":
            return self._serve_tha_asset("tha.js")

        if got == "/psb.html":
            return self._serve_psb_asset("psb.html")

        if got.startswith("/psb/"):
            rel = got[len("/psb/") :]
            return self._serve_psb_asset(rel)

        # Session sub-routes
        m = re.match(r"^/api/sessions/([^/]+)/messages$", got)
        if m:
            return self._handle_session_messages(request, m.group(1))
        m = re.match(r"^/api/sessions/([^/]+)/webui-thread$", got)
        if m:
            return self._handle_webui_thread_get(request, m.group(1))
        # NOTE: websockets' HTTP parser only accepts GET; DELETE is folded into path.
        # 大 payload 待改进见仓库根目录 todo.md（PSB 现用分块 GET）。
        m = re.match(r"^/api/sessions/([^/]+)/delete$", got)
        if m:
            return self._handle_session_delete(request, m.group(1))

        # Signed media
        m = re.match(r"^/api/media/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)$", got)
        if m:
            return self._handle_media_fetch(m.group(1), m.group(2), request=request)

        # API 404 (never fall through to SPA for /api/ routes)
        if got.startswith("/api/"):
            return _http_error(404, "API route not found")

        # Static SPA
        if self._static_dist_path is not None:
            response = self._serve_static(got)
            if response is not None:
                return response

        return connection.respond(404, "Not Found")

    # -- Token issue --------------------------------------------------------

    def _handle_token_issue(self, connection: Any, request: WsRequest) -> Any:
        secret = self.config.token_issue_secret.strip() or self.config.token.strip()
        if secret:
            if not _issue_route_secret_matches(request.headers, secret):
                return connection.respond(401, "Unauthorized")
        else:
            self._log.warning(
                "token_issue_path is set but token_issue_secret is empty; "
                "any client can obtain connection tokens — set token_issue_secret for production."
            )
        if not self._tokens.can_issue():
            return _http_json_response({"error": "too many outstanding tokens"}, status=429)
        token_value = self._tokens.issue_token(self.config.token_ttl_s)
        return _http_json_response({"token": token_value, "expires_in": self.config.token_ttl_s})

    # -- Bootstrap ----------------------------------------------------------

    def _handle_bootstrap(self, connection: Any, request: WsRequest) -> Response:
        secret = self.config.token_issue_secret.strip() or self.config.token.strip()
        if secret:
            if not _issue_route_secret_matches(request.headers, secret):
                return _http_error(401, "Unauthorized")
        elif not _is_localhost(connection):
            return _http_error(403, "bootstrap is localhost-only")
        if not self._tokens.can_issue(include_api_token=True):
            return _http_response(
                json.dumps({"error": "too many outstanding tokens"}).encode("utf-8"),
                status=429,
                content_type="application/json; charset=utf-8",
            )
        token = self._tokens.issue_token(self.config.token_ttl_s, api_token=True)
        caps = runtime_capabilities(self._runtime_surface, self._runtime_capabilities_overrides)
        return _http_json_response({
            "token": token,
            "ws_path": _normalize_config_path(self.config.path),
            "expires_in": self.config.token_ttl_s,
            "model_name": _resolve_bootstrap_model_name(self._runtime_model_name),
            "runtime_surface": self._runtime_surface,
            "runtime_capabilities": caps,
        })

    # -- Session routes -----------------------------------------------------

    def _handle_sessions_list(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        if self._session_manager is None:
            return _http_error(503, "session manager unavailable")
        sessions = self._session_manager.list_sessions()
        cleaned = []
        for s in sessions:
            key = s.get("key")
            if not (isinstance(key, str) and key.startswith("websocket:")):
                continue
            row = {k: v for k, v in s.items() if k != "path"}
            chat_id = key.split(":", 1)[1]
            started_at = websocket_turn_wall_started_at(chat_id)
            if started_at is not None:
                row["run_started_at"] = started_at
            if self._workspaces is not None:
                scope = self._workspaces.scope_for_session_key(key)
                row["workspace_scope"] = scope.payload()
            cleaned.append(row)
        return _http_json_response({"sessions": cleaned})

    def _handle_session_messages(self, request: WsRequest, key: str) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        if self._session_manager is None:
            return _http_error(503, "session manager unavailable")
        decoded_key = _decode_api_key(key)
        if decoded_key is None:
            return _http_error(400, "invalid session key")
        if not _is_websocket_channel_session_key(decoded_key):
            return _http_error(404, "session not found")
        data = self._session_manager.read_session_file(decoded_key)
        if data is None:
            return _http_error(404, "session not found")
        messages = data.get("messages")
        if isinstance(messages, list):
            scrub_subagent_messages_for_channel(messages)
        self.augment_media_urls(data)
        return _http_json_response(data)

    def _handle_webui_thread_get(self, request: WsRequest, key: str) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        decoded_key = _decode_api_key(key)
        if decoded_key is None:
            return _http_error(400, "invalid session key")
        if not _is_websocket_channel_session_key(decoded_key):
            return _http_error(404, "session not found")
        scope = (
            self._workspaces.scope_for_session_key(decoded_key)
            if self._workspaces is not None
            else None
        )
        data = build_webui_thread_response(
            decoded_key,
            augment_media_paths=self.augment_transcript_media_paths,
            augment_assistant_text=(
                lambda text: rewrite_local_markdown_images(
                    text,
                    workspace_path=scope.project_path if scope is not None else self._workspace_path,
                    sign_path=self.sign_or_stage_media_path,
                )
                if scope is not None
                else self.rewrite_local_markdown_images
            ),
        )
        if data is None:
            return _http_error(404, "webui thread not found")
        if scope is not None:
            data["workspace_scope"] = scope.payload()
        return _http_json_response(data)

    def _handle_inbox_thread(self, request: WsRequest) -> Response:
        """返回统一 session 转换后的 UI 消息列表（``GET /api/inbox/thread``）。"""
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        empty: dict[str, Any] = {
            "messages": [],
            "schemaVersion": 3,
            "sessionKey": UNIFIED_SESSION_KEY,
            "unreadCount": 0,
        }
        if self._session_manager is None:
            return _http_json_response(empty)
        session = self._session_manager.get_or_create(UNIFIED_SESSION_KEY)
        if not session.messages:
            return _http_json_response(empty)
        data = build_inbox_thread_from_session(
            session,
            session_manager=self._session_manager,
            augment_media_paths=self.augment_transcript_media_paths,
            augment_assistant_text=self.rewrite_local_markdown_images,
        )
        return _http_json_response(data)

    def _handle_session_delete(self, request: WsRequest, key: str) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        if self._session_manager is None:
            return _http_error(503, "session manager unavailable")
        decoded_key = _decode_api_key(key)
        if decoded_key is None:
            return _http_error(400, "invalid session key")
        if not _is_websocket_channel_session_key(decoded_key):
            return _http_error(404, "session not found")
        deleted = self._session_manager.delete_session(decoded_key)
        delete_webui_thread(decoded_key)
        return _http_json_response({"deleted": bool(deleted)})

    # -- Settings routes ----------------------------------------------------

    def _handle_settings(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        return _http_json_response(self._with_settings_restart_state(settings_payload()))

    def _with_settings_restart_state(
        self,
        payload: dict[str, Any],
        *,
        section: str | None = None,
    ) -> dict[str, Any]:
        """Annotate *payload* with per-process restart-required state."""
        if section and payload.get("requires_restart"):
            self._settings_restart_sections.add(section)
        payload = dict(payload)
        if self._settings_restart_sections:
            payload["requires_restart"] = True
            payload["restart_required_sections"] = sorted(self._settings_restart_sections)
        else:
            payload["restart_required_sections"] = []
        return payload

    def _handle_settings_update(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_agent_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        model_keys = {
            "model_preset", "modelPreset", "model", "provider",
            "max_tokens", "maxTokens", "context_window_tokens", "contextWindowTokens",
            "vision_model", "visionModel", "vision_provider", "visionProvider",
            "reasoning_effort", "reasoningEffort",
        }
        if self._runtime_model_setter is not None and any(key in query for key in model_keys):
            try:
                self._runtime_model_setter(payload.get("agent", {}).get("model_preset"))
            except (KeyError, ValueError) as e:
                return _http_error(400, str(e))
        return _http_json_response(
            self._with_settings_restart_state(payload, section="runtime")
        )

    def _handle_settings_model_configuration_create(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = create_model_configuration(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        if self._runtime_model_setter is not None:
            try:
                self._runtime_model_setter(payload.get("agent", {}).get("model_preset"))
            except (KeyError, ValueError) as e:
                return _http_error(400, str(e))
        return _http_json_response(self._with_settings_restart_state(payload))

    def _handle_settings_model_configuration_update(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_model_configuration(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        if self._runtime_model_setter is not None:
            try:
                self._runtime_model_setter(payload.get("agent", {}).get("model_preset"))
            except (KeyError, ValueError) as e:
                return _http_error(400, str(e))
        return _http_json_response(self._with_settings_restart_state(payload))

    def _handle_settings_provider_update(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_provider_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(
            self._with_settings_restart_state(payload, section="image")
        )

    def _handle_settings_web_search_update(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_web_search_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(
            self._with_settings_restart_state(payload, section="browser")
        )

    def _handle_settings_image_generation_update(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_image_generation_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(
            self._with_settings_restart_state(payload, section="image")
        )

    def _handle_settings_tha_update(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_tha_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(self._with_settings_restart_state(payload))

    def _handle_settings_desk_pet_tha_update(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_desk_pet_tha_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(self._with_settings_restart_state(payload))

    def _handle_settings_desk_pet_psb_update(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_desk_pet_psb_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(self._with_settings_restart_state(payload))

    async def _dispatch_psb_routes(self, request: WsRequest, got: str) -> Response | None:
        if not got.startswith("/api/desk-pet/psb/"):
            return None
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            if got == "/api/desk-pet/psb/models":
                return _http_json_response(psb_models_list_payload())
            m = re.match(r"^/api/desk-pet/psb/models/([^/]+)$", got)
            if m:
                return _http_json_response(psb_model_detail_payload(m.group(1)))
            m = re.match(r"^/api/desk-pet/psb/models/([^/]+)/delete$", got)
            if m:
                return _http_json_response(psb_delete_payload(m.group(1)))
            m = re.match(r"^/api/desk-pet/psb/models/([^/]+)/rescan$", got)
            if m:
                return await self._run_async_json(psb_rescan_payload(m.group(1)))
            m = re.match(r"^/api/desk-pet/psb/models/([^/]+)/retry-translation$", got)
            if m:
                return await self._run_async_json(psb_retry_translation_payload(m.group(1)))
            m = re.match(r"^/api/desk-pet/psb/models/([^/]+)/initial-state/update$", got)
            if m:
                return _http_json_response(psb_save_initial_state_payload(m.group(1), query))
            m = re.match(r"^/api/desk-pet/psb/models/([^/]+)/runtime-metadata/update$", got)
            if m:
                return await self._run_async_json(psb_runtime_metadata_payload(m.group(1), query))
            m = re.match(r"^/api/desk-pet/psb/models/([^/]+)/manifest$", got)
            if m:
                return _http_json_response(psb_manifest_payload(m.group(1)))
            m = re.match(r"^/api/desk-pet/psb/models/([^/]+)/files/(.+)$", got)
            if m:
                return self._serve_psb_model_file(m.group(1), m.group(2))
        except PsbApiError as exc:
            return _http_error(exc.status, exc.message)
        return _http_error(404, "API route not found")

    async def _run_async_json(self, coro) -> Response:
        payload = await coro
        return _http_json_response(payload)

    def _serve_psb_model_file(self, model_id: str, rel_path: str) -> Response:
        try:
            path = psb_resolve_file(model_id, rel_path)
        except PsbApiError as exc:
            return _http_error(exc.status, exc.message)
        mime, _ = mimetypes.guess_type(path.name)
        if not mime:
            mime = "application/octet-stream"
        body = path.read_bytes()
        return _http_response(body, content_type=mime)

    def _handle_settings_network_safety_update(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = update_network_safety_settings(query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(
            self._with_settings_restart_state(payload, section="runtime")
        )

    def _handle_tha_payload(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        return _http_json_response(tha_payload())

    def _handle_tha_config_update(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            payload = update_tha_config(_parse_query(request.path))
        except THAApiError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(payload)

    def _handle_tha_models(self, request: WsRequest, kind: str) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            payload = tha_models_payload(kind)
        except THAApiError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(payload)

    async def _handle_tha_play(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        url_values = query.get("url") or query.get("mediaUrl") or []
        if not url_values or not url_values[0].strip():
            return _http_error(400, "url is required")
        url = url_values[0].strip()
        text_values = query.get("text") or []
        name_values = query.get("name") or []
        event = {
            "type": "audio",
            "text": text_values[0] if text_values else "",
            "media": [{"url": url, "name": name_values[0] if name_values else ""}],
        }
        subscribers = 0
        if self._broadcast_tha_event is not None:
            subscribers = await self._broadcast_tha_event(event)
        return _http_json_response({"ok": True, "subscribers": subscribers})

    def _handle_settings_cli_apps(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            payload = cli_apps_payload()
        except Exception:
            self._log.exception("failed to load CLI Apps payload")
            return _http_error(500, "failed to load CLI Apps")
        return _http_json_response(payload)

    async def _handle_settings_cli_apps_action(
        self, request: WsRequest, action: str
    ) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        try:
            payload = await asyncio.to_thread(cli_apps_action, action, query)
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        except Exception as e:
            status = getattr(e, "status", 500)
            message = getattr(e, "message", str(e))
            if status >= 500:
                self._log.exception("CLI Apps action '{}' failed", action)
            return _http_error(status, message)
        return _http_json_response(payload)

    async def _handle_settings_mcp_presets(
        self,
        request: WsRequest,
        action: str | None = None,
    ) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            payload = await mcp_presets_settings_action(
                action,
                self._parse_mcp_settings_query(request),
                reload_mcp=lambda: request_mcp_reload(self.bus),
            )
        except WebUISettingsError as e:
            return _http_error(e.status, e.message)
        except Exception as e:
            status = getattr(e, "status", 500)
            message = getattr(e, "message", str(e))
            if status >= 500:
                self._log.exception("MCP preset action '{}' failed", action or "list")
            return _http_error(status, message)
        if action is None:
            return _http_json_response(payload)
        return _http_json_response(
            self._with_settings_restart_state(payload, section="runtime")
        )

    def _parse_mcp_settings_query(
        self, request: WsRequest
    ) -> dict[str, list[str]]:
        """Merge URL query params with the JSON payload in X-Nanobot-MCP-Values."""
        query = _parse_query(request.path)
        raw = request.headers.get(_MCP_VALUES_HEADER)
        if not raw:
            return query
        if len(raw.encode("utf-8")) > _MCP_VALUES_HEADER_MAX_BYTES:
            raise WebUISettingsError("MCP settings payload is too large")
        try:
            payload_data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise WebUISettingsError("invalid MCP settings payload") from exc
        if not isinstance(payload_data, dict):
            raise WebUISettingsError("MCP settings payload must be a JSON object")
        merged = {key: list(values) for key, values in query.items()}
        for key, value in payload_data.items():
            if not isinstance(key, str) or not key:
                raise WebUISettingsError("MCP settings payload contains an invalid key")
            if value is None:
                continue
            if isinstance(value, str):
                text = value.strip()
            else:
                text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            if text:
                merged[key] = [text]
        return merged

    # -- Misc routes --------------------------------------------------------

    def _handle_commands(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        return _http_json_response({"commands": builtin_command_palette()})

    def _handle_webui_sidebar_state(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        return _http_json_response(read_webui_sidebar_state())

    def _handle_webui_sidebar_state_update(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        raw_state = _query_first(query, "state")
        if raw_state is None:
            return _http_error(400, "missing state")
        try:
            decoded = json.loads(raw_state)
        except json.JSONDecodeError:
            return _http_error(400, "state must be JSON")
        if not isinstance(decoded, dict):
            return _http_error(400, "state must be an object")
        try:
            state = write_webui_sidebar_state(decoded)
        except ValueError as e:
            return _http_error(400, str(e))
        except OSError:
            self._log.exception("failed to write webui sidebar state")
            return _http_error(500, "failed to write sidebar state")
        return _http_json_response(state)

    def _handle_workspace_list(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        rel_path = _query_first(query, "path") or ""
        try:
            payload = list_workspace_dir(self._workspace_path, rel_path)
        except WorkspaceFilesError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(payload)

    def _handle_workspace_read(self, request: WsRequest) -> Response:
        if not self.check_api_token(request):
            return _http_error(401, "Unauthorized")
        query = _parse_query(request.path)
        rel_path = _query_first(query, "path")
        if rel_path is None:
            return _http_error(400, "missing path")
        try:
            payload = read_workspace_file(self._workspace_path, rel_path)
        except WorkspaceFilesError as e:
            return _http_error(e.status, e.message)
        return _http_json_response(payload)

    # -- Media routes -------------------------------------------------------

    def _handle_avatar_fetch(self) -> Response:
        """Serve the bot avatar image (``GET /api/avatar``). No auth required."""
        media_root = get_media_dir()
        for name, mime in (
            ("avatar.jpg", "image/jpeg"),
            ("avatar.png", "image/png"),
            ("avatar.webp", "image/webp"),
        ):
            candidate = media_root / name
            if candidate.is_file():
                try:
                    body = candidate.read_bytes()
                except OSError:
                    return _http_error(500, "read error")
                return _http_response(
                    body,
                    content_type=mime,
                    extra_headers=[
                        ("Cache-Control", "public, max-age=300, must-revalidate"),
                        ("X-Content-Type-Options", "nosniff"),
                    ],
                )
        return _http_error(404, "not found")

    def _handle_media_fetch(
        self, sig: str, payload: str, request: WsRequest | None = None
    ) -> Response:
        """Serve a media file previously signed via :meth:`sign_media_path`.

        Supports HTTP byte-range requests (``206 Partial Content``) for video
        seeking, and serves SVG with a sandboxed Content-Security-Policy to
        allow image preview while blocking embedded script execution.
        """
        try:
            provided_mac = _b64url_decode(sig)
        except (ValueError, binascii.Error):
            return _http_error(401, "invalid signature")
        expected_mac = hmac.new(
            self._media_secret, payload.encode("ascii"), hashlib.sha256
        ).digest()[:16]
        if not hmac.compare_digest(expected_mac, provided_mac):
            return _http_error(401, "invalid signature")
        try:
            rel_bytes = _b64url_decode(payload)
            rel_str = rel_bytes.decode("utf-8")
        except (ValueError, binascii.Error, UnicodeDecodeError):
            return _http_error(400, "invalid payload")
        try:
            media_root = get_media_dir().resolve()
            candidate = (media_root / rel_str).resolve()
            candidate.relative_to(media_root)
        except (OSError, ValueError):
            return _http_error(404, "not found")
        if not candidate.is_file():
            return _http_error(404, "not found")
        try:
            body = candidate.read_bytes()
        except OSError:
            return _http_error(500, "read error")
        mime, _ = mimetypes.guess_type(candidate.name)
        if mime is None:
            mime = _MIME_FALLBACK.get(Path(candidate.name).suffix.lower())
        if mime is not None:
            mime = _MIME_NORMALIZE.get(mime, mime)

        # SVG: serve with sandboxed CSP instead of downgrading to octet-stream.
        if mime == "image/svg+xml":
            return _http_response(
                body,
                content_type="image/svg+xml",
                extra_headers=[
                    ("Cache-Control", "private, max-age=31536000, immutable"),
                    ("X-Content-Type-Options", "nosniff"),
                    ("Content-Security-Policy",
                     "default-src 'none'; style-src 'unsafe-inline'; sandbox"),
                ],
            )

        if mime not in _MEDIA_ALLOWED_MIMES:
            mime = "application/octet-stream"

        base_headers: list[tuple[str, str]] = [
            ("Cache-Control", "private, max-age=31536000, immutable"),
            ("X-Content-Type-Options", "nosniff"),
            ("Accept-Ranges", "bytes"),
        ]

        # HTTP byte-range support (required for video seeking).
        total = len(body)
        range_header = None
        if request is not None:
            range_header = (
                request.headers.get("Range") or request.headers.get("range")
            )
        if range_header and range_header.startswith("bytes="):
            range_spec = range_header[6:]
            dash = range_spec.find("-")
            start_str = range_spec[:dash].strip()
            end_str = range_spec[dash + 1:].strip()
            try:
                if not start_str:
                    # Suffix range: bytes=-N
                    suffix_len = int(end_str)
                    start = max(0, total - suffix_len)
                    end = total - 1
                else:
                    start = int(start_str)
                    end = int(end_str) if end_str else total - 1
            except ValueError:
                return _http_error(400, "invalid Range header")

            if start >= total:
                return _http_response(
                    b"",
                    status=416,
                    content_type=mime,
                    extra_headers=base_headers + [
                        ("Content-Range", f"bytes */{total}"),
                    ],
                )
            end = min(end, total - 1)
            chunk = body[start : end + 1]
            return _http_response(
                chunk,
                status=206,
                content_type=mime,
                extra_headers=base_headers + [
                    ("Content-Range", f"bytes {start}-{end}/{total}"),
                    ("Content-Length", str(len(chunk))),
                ],
            )

        return _http_response(body, content_type=mime, extra_headers=base_headers)

    # -- Static file serving ------------------------------------------------

    def _serve_psb_asset(self, rel_path: str) -> Response:
        safe = rel_path.lstrip("/").replace("\\", "/")
        if not safe or ".." in safe.split("/"):
            return _http_error(403, "Forbidden")
        path = (PSB_STATIC_DIR / safe).resolve(strict=False)
        root = PSB_STATIC_DIR.resolve(strict=False)
        if root not in path.parents or not path.is_file():
            return _http_error(404, "PSB asset not found")
        mime, _ = mimetypes.guess_type(path.name)
        if mime is None:
            if path.suffix == ".js":
                mime = "application/javascript; charset=utf-8"
            elif path.suffix == ".html":
                mime = "text/html; charset=utf-8"
            else:
                mime = "application/octet-stream"
        try:
            body = path.read_bytes()
        except OSError:
            return _http_error(500, "failed to read PSB asset")
        return _http_response(
            body,
            content_type=mime,
            extra_headers=[("Cache-Control", "no-cache")],
        )

    def _serve_tha_asset(self, filename: str) -> Response:
        safe_names = {
            "tha.html": "text/html; charset=utf-8",
            "tha.js": "application/javascript; charset=utf-8",
        }
        content_type = safe_names.get(filename)
        if content_type is None:
            return _http_error(404, "THA asset not found")
        path = (THA_STATIC_DIR / filename).resolve(strict=False)
        root = THA_STATIC_DIR.resolve(strict=False)
        if root not in path.parents or not path.is_file():
            return _http_error(404, "THA asset not found")
        try:
            body = path.read_bytes()
        except OSError:
            return _http_error(500, "failed to read THA asset")
        return _http_response(
            body,
            content_type=content_type,
            extra_headers=[("Cache-Control", "no-cache")],
        )

    def _serve_static(self, request_path: str) -> Response | None:
        """Resolve *request_path* against the SPA build directory; fallback to index.html."""
        assert self._static_dist_path is not None
        rel = request_path.lstrip("/")
        if not rel:
            rel = "index.html"
        if ".." in rel.split("/") or rel.startswith("/"):
            return _http_error(403, "Forbidden")
        candidate = (self._static_dist_path / rel).resolve()
        try:
            candidate.relative_to(self._static_dist_path)
        except ValueError:
            return _http_error(403, "Forbidden")
        if not candidate.is_file():
            index = self._static_dist_path / "index.html"
            if index.is_file():
                candidate = index
            else:
                return None
        try:
            body = candidate.read_bytes()
        except OSError as e:
            self._log.warning("static: failed to read {}: {}", candidate, e)
            return _http_error(500, "Internal Server Error")
        ctype, _ = mimetypes.guess_type(candidate.name)
        if ctype is None:
            ctype = "application/octet-stream"
        if ctype.startswith("text/") or ctype in {"application/javascript", "application/json"}:
            ctype = f"{ctype}; charset=utf-8"
        cache = (
            "no-cache"
            if candidate.name == "index.html"
            else "public, max-age=31536000, immutable"
        )
        return _http_response(
            body,
            status=200,
            content_type=ctype,
            extra_headers=[("Cache-Control", cache)],
        )
