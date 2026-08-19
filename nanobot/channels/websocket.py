"""WebSocket server channel: nanobot acts as a WebSocket server and serves connected clients."""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import mimetypes
import re
import secrets
import ssl
import uuid
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING, Any, Self

from pydantic import Field, field_validator, model_validator
from websockets.asyncio.server import ServerConnection, serve, unix_serve
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request as WsRequest

from nanobot.bus.events import OUTBOUND_META_AGENT_UI, OutboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.channels.base import BaseChannel
from nanobot.config.paths import get_media_dir
from nanobot.config.schema import Base
from nanobot.security.workspace_access import (
    WORKSPACE_SCOPE_METADATA_KEY,
    WorkspaceScopeError,
)
from nanobot.session.goal_state import goal_state_ws_blob
from nanobot.session.webui_turns import websocket_turn_wall_started_at
from nanobot.utils.document import SUPPORTED_EXTENSIONS
from nanobot.utils.media_decode import (
    FileSizeExceeded,
    save_base64_data_url,
)
from nanobot.utils.media_staging import is_remote_media_url
from nanobot.webui.cli_apps_api import normalize_cli_app_mentions
from nanobot.webui.fork_http import ForkGatewayHTTPHandler
from nanobot.webui.gateway_tokens import GatewayTokenStore
from nanobot.webui.http_utils import (
    is_localhost as _is_localhost,
)
from nanobot.webui.http_utils import (
    parse_request_path as _parse_request_path,
)
from nanobot.webui.http_utils import (
    query_first as _query_first,
)
from nanobot.webui.mcp_presets_api import normalize_mcp_preset_mentions
from nanobot.webui.tha_api import tha_websocket_loop
from nanobot.webui.transcript import WebUITranscriptRecorder
from nanobot.webui.websocket_logging import websockets_server_logger
from nanobot.webui.workspaces import WebUIWorkspaceController

if TYPE_CHECKING:
    from nanobot.cron.service import CronService
    from nanobot.session.manager import SessionManager
    from nanobot.webui.gateway_services import GatewayServices


class _GatewayMediaProxy:
    """fork 内部的 workspace_path 代理，供测试通过 channel.gateway.media 访问。"""

    def __init__(self, workspace_path: Path | None) -> None:
        self.workspace_path = workspace_path or Path.cwd()


class _GatewayProxy:
    """将 fork 内部对象以上游 GatewayServices 兼容的接口暴露出来，供测试使用。"""

    def __init__(
        self,
        tokens: GatewayTokenStore,
        http: Any,
        workspace_path: Path | None,
        session_manager: Any,
    ) -> None:
        self.tokens = tokens
        self.http = http
        self.media = _GatewayMediaProxy(workspace_path)
        self.session_manager = session_manager


def _strip_trailing_slash(path: str) -> str:
    if len(path) > 1 and path.endswith("/"):
        return path.rstrip("/")
    return path or "/"


def _normalize_config_path(path: str) -> str:
    return _strip_trailing_slash(path)


class WebSocketConfig(Base):
    """WebSocket server channel configuration.

    Clients connect with URLs like ``ws://{host}:{port}{path}?client_id=...&token=...``.
    - ``client_id``: Used for ``allow_from`` authorization; if omitted, a value is generated and logged.
    - ``token``: If non-empty, the ``token`` query param may match this static secret; short-lived tokens
      from ``token_issue_path`` are also accepted.
    - ``token_issue_path``: If non-empty, **GET** (HTTP/1.1) to this path returns JSON
      ``{"token": "...", "expires_in": <seconds>}``; use ``?token=...`` when opening the WebSocket.
      Must differ from ``path`` (the WS upgrade path). If the client runs in the **same process** as
      nanobot and shares the asyncio loop, use a thread or async HTTP client for GET—do not call
      blocking ``urllib`` or synchronous ``httpx`` from inside a coroutine.
    - ``token_issue_secret``: If non-empty, token requests must send ``Authorization: Bearer <secret>`` or
      ``X-Nanobot-Auth: <secret>``.
    - ``websocket_requires_token``: If True, the handshake must include a valid token (static or issued and not expired).
    - Each connection has its own session: a unique ``chat_id`` maps to the agent session internally.
    - ``media`` field in outbound messages contains local filesystem paths; remote clients need a
      shared filesystem or an HTTP file server to access these files.
    """

    enabled: bool = False
    host: str = "127.0.0.1"
    port: int = 8765
    unix_socket_path: str = ""
    path: str = "/"
    token: str = ""
    token_issue_path: str = ""
    token_issue_secret: str = ""
    token_ttl_s: int = Field(default=300, ge=30, le=86_400)
    websocket_requires_token: bool = True
    allow_from: list[str] = Field(default_factory=lambda: ["*"])
    streaming: bool = True
    # Default 36 MB, upper 40 MB: supports up to 4 images at ~6 MB each after
    # client-side Worker normalization (see webui Composer). 4 × 6 MB × 1.37
    # (base64 overhead) + envelope framing stays under 36 MB; the 40 MB ceiling
    # leaves a small margin for sender slop without opening a DoS avenue.
    max_message_bytes: int = Field(default=37_748_736, ge=1024, le=41_943_040)
    ping_interval_s: float = Field(default=20.0, ge=5.0, le=300.0)
    ping_timeout_s: float = Field(default=20.0, ge=5.0, le=300.0)
    ssl_certfile: str = ""
    ssl_keyfile: str = ""

    @field_validator("unix_socket_path")
    @classmethod
    def unix_socket_path_format(cls, value: str) -> str:
        value = value.strip()
        if not value:
            return ""
        if "\x00" in value:
            raise ValueError("unix_socket_path must not contain NUL bytes")
        path = Path(value).expanduser()
        if not path.is_absolute():
            raise ValueError("unix_socket_path must be an absolute path")
        return str(path)

    @field_validator("path")
    @classmethod
    def path_must_start_with_slash(cls, value: str) -> str:
        if not value.startswith("/"):
            raise ValueError('path must start with "/"')
        return _normalize_config_path(value)

    @field_validator("token_issue_path")
    @classmethod
    def token_issue_path_format(cls, value: str) -> str:
        value = value.strip()
        if not value:
            return ""
        if not value.startswith("/"):
            raise ValueError('token_issue_path must start with "/"')
        return _normalize_config_path(value)

    @model_validator(mode="after")
    def token_issue_path_differs_from_ws_path(self) -> Self:
        if not self.token_issue_path:
            return self
        if _normalize_config_path(self.token_issue_path) == _normalize_config_path(self.path):
            raise ValueError("token_issue_path must differ from path (the WebSocket upgrade path)")
        return self

    @model_validator(mode="after")
    def wildcard_host_requires_auth(self) -> Self:
        if self.host not in ("0.0.0.0", "::"):
            return self
        if self.token.strip() or self.token_issue_secret.strip():
            return self
        raise ValueError(
            "host is 0.0.0.0 (all interfaces) but neither token nor "
            "token_issue_secret is set — set one to prevent unauthenticated access"
        )


def publish_runtime_model_update(
    bus: MessageBus,
    model: str,
    model_preset: str | None,
) -> None:
    """Enqueue a runtime model snapshot for websocket subscribers (fan-out in-channel)."""
    bus.outbound.put_nowait(OutboundMessage(
        channel="websocket",
        chat_id="*",
        content="",
        metadata={
            "_runtime_model_updated": True,
            "model": model,
            "model_preset": model_preset,
        },
    ))


def _parse_inbound_payload(raw: str) -> str | None:
    """Parse a client frame into text; return None for empty or unrecognized content."""
    text = raw.strip()
    if not text:
        return None
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return text
        if isinstance(data, dict):
            for key in ("content", "text", "message"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value
            return None
        return None
    return text


# Accept UUIDs and short scoped keys like "unified:default". Keeps the capability
# namespace small enough to rule out path traversal / quote injection tricks.
_CHAT_ID_RE = re.compile(r"^[A-Za-z0-9_:-]{1,64}$")

# Electron 客户端订阅此特殊频道以接收所有通道的实时消息推送（fan-out）。
# 不对应任何真实 session，仅作为路由键使用。
INBOX_UNIFIED_CHAT_ID = "inbox:unified"


def _is_valid_chat_id(value: Any) -> bool:
    return isinstance(value, str) and _CHAT_ID_RE.match(value) is not None


def _parse_envelope(raw: str) -> dict[str, Any] | None:
    """Return a typed envelope dict if the frame is a new-style JSON envelope, else None.

    A frame qualifies when it parses as a JSON object with a string ``type`` field.
    Legacy frames (plain text, or ``{"content": ...}`` without ``type``) return None;
    callers should fall back to :func:`_parse_inbound_payload` for those.
    """
    text = raw.strip()
    if not text.startswith("{"):
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    t = data.get("type")
    if not isinstance(t, str):
        return None
    return data


# Per-message media limits. The server-side guard is a touch looser than the
# client's ``Worker`` normalization target (6 MB) — tolerate client slop, but
# still cap total ingress at ``_MAX_IMAGES_PER_MESSAGE * _MAX_IMAGE_BYTES``
# which fits comfortably inside ``max_message_bytes``.
_MAX_ATTACHMENTS_PER_MESSAGE = 8
_MAX_IMAGES_PER_MESSAGE = 4
_MAX_IMAGE_BYTES = 8 * 1024 * 1024
_MAX_VIDEOS_PER_MESSAGE = 1
_MAX_VIDEO_BYTES = 20 * 1024 * 1024
_MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

# Image MIME whitelist — matches the Composer's ``accept`` list. SVG is
# explicitly excluded to avoid the XSS surface inside embedded scripts.
_IMAGE_MIME_ALLOWED: frozenset[str] = frozenset({
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
})

_IMAGE_EXTENSIONS: frozenset[str] = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
})

_DOCUMENT_EXTENSIONS: frozenset[str] = frozenset(
    ext for ext in SUPPORTED_EXTENSIONS if ext not in _IMAGE_EXTENSIONS
)

_VIDEO_MIME_ALLOWED: frozenset[str] = frozenset({
    "video/mp4",
    "video/webm",
    "video/quicktime",
})

_DOCUMENT_MIME_ALLOWED: frozenset[str] = frozenset({
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "text/xml",
    "application/xml",
    "text/html",
    "text/yaml",
    "application/x-yaml",
    "application/toml",
    "text/x-python",
    "text/x-script.python",
    "application/x-sh",
    "text/x-sh",
})

_UPLOAD_MIME_ALLOWED: frozenset[str] = (
    _IMAGE_MIME_ALLOWED | _VIDEO_MIME_ALLOWED | _DOCUMENT_MIME_ALLOWED
)

_BLOCKED_UPLOAD_EXTENSIONS: frozenset[str] = frozenset({".svg"})
_BLOCKED_UPLOAD_MIMES: frozenset[str] = frozenset({"image/svg+xml"})


def _upload_extension(name: Any) -> str | None:
    if not isinstance(name, str) or not name.strip():
        return None
    ext = Path(name).suffix.lower()
    if not ext or ext in _BLOCKED_UPLOAD_EXTENSIONS:
        return None
    if ext in SUPPORTED_EXTENSIONS:
        return ext
    return None


def _upload_allowed(mime: str | None, name: Any) -> bool:
    if mime in _BLOCKED_UPLOAD_MIMES:
        return False
    ext = _upload_extension(name)
    if mime in _UPLOAD_MIME_ALLOWED:
        if mime == "application/octet-stream":
            return ext is not None
        return True
    return ext is not None

_DATA_URL_MIME_RE = re.compile(r"^data:([^;]+);base64,", re.DOTALL)


def _extract_data_url_mime(url: str) -> str | None:
    """Return the MIME type of a ``data:<mime>;base64,...`` URL, else ``None``."""
    if not isinstance(url, str):
        return None
    m = _DATA_URL_MIME_RE.match(url)
    if not m:
        return None
    return m.group(1).strip().lower() or None


def _is_websocket_upgrade(request: WsRequest) -> bool:
    """Detect an actual WS upgrade; plain HTTP GETs to the same path should fall through."""
    upgrade = request.headers.get("Upgrade") or request.headers.get("upgrade")
    connection = request.headers.get("Connection") or request.headers.get("connection")
    if not upgrade or "websocket" not in upgrade.lower():
        return False
    if not connection or "upgrade" not in connection.lower():
        return False
    return True


def _b64url_encode(data: bytes) -> str:
    """URL-safe base64 without padding — compact + friendly in URL paths."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    """Reverse of :func:`_b64url_encode`; caller handles ``ValueError``."""
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


# Allowed MIME types we actually serve from the media endpoint. Anything
# outside this set is degraded to ``application/octet-stream`` so an
# attacker who somehow gets a signed URL for an unexpected file type can't
# trick the browser into sniffing executable content.
_MEDIA_ALLOWED_MIMES: frozenset[str] = frozenset({
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    # 音频格式：TTS 合成文件（mp3/wav）及主流编码。
    # Python mimetypes 对部分扩展名返回非标准值（如 .wav→audio/x-wav），两者均保留。
    "audio/mpeg",    # .mp3
    "audio/wav",     # .wav（RFC 2361）
    "audio/x-wav",   # .wav（Python mimetypes 返回值）
    "audio/mp4",     # .m4a / .mp4 容器内 AAC
    "audio/ogg",     # .ogg
    "audio/aac",     # .aac
    "audio/webm",    # .weba
})

# mimetypes.guess_type 无法识别的扩展名兜底映射（返回 None 时使用）。
_MIME_FALLBACK: dict[str, str] = {
    ".m4a":  "audio/mp4",
    ".aac":  "audio/aac",
    ".weba": "audio/webm",
}

# 非标准/废弃 MIME → 标准 MIME 正规化表（跨平台 mimetypes 返回值差异）。
_MIME_NORMALIZE: dict[str, str] = {
    "audio/mp4a-latm": "audio/mp4",   # macOS mimetypes 对 .m4a 返回此值
    "audio/x-wav":     "audio/wav",   # 部分平台对 .wav 返回此值；均放入白名单
}

# screenshot_result 专用体积上限（JPEG 80%，全屏约 1-3 MB，上限给足余量）。
# 高于普通图片单张 8 MB 是有意为之：截图一次只传一张，且不走消息管道。
_MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024


class WebSocketChannel(BaseChannel):
    """Run a local WebSocket server; forward text/JSON messages to the message bus."""

    name = "websocket"
    display_name = "WebSocket"

    def __init__(
        self,
        config: Any,
        bus: MessageBus,
        *,
        gateway: "GatewayServices | None" = None,
        session_manager: "SessionManager | None" = None,
        cron_service: "CronService | None" = None,
        static_dist_path: Path | None = None,
        workspace_path: Path | None = None,
        diary_path: Path | None = None,
        runtime_model_name: Callable[[], str | None] | None = None,
        runtime_model_setter: Callable[[str | None], None] | None = None,
        runtime_surface: str = "browser",
        runtime_capabilities_overrides: dict[str, Any] | None = None,
        default_restrict_to_workspace: bool = False,
        unified_session: bool = False,
    ):
        if isinstance(config, dict):
            config = WebSocketConfig.model_validate(config)
        # 兼容上游测试：从 GatewayServices 提取 session_manager / workspace_path / tokens。
        if gateway is not None:
            if session_manager is None:
                session_manager = gateway.session_manager
            if workspace_path is None:
                workspace_path = gateway.media.workspace_path
            # 从上游 GatewayHTTPHandler 提取 runtime_surface 和 capabilities overrides。
            _ghttp = gateway.http
            runtime_surface = getattr(_ghttp, "_runtime_surface", runtime_surface)
            runtime_capabilities_overrides = getattr(
                _ghttp, "_runtime_capabilities_overrides", runtime_capabilities_overrides
            )
        super().__init__(config, bus)
        self.config: WebSocketConfig = config
        # chat_id -> connections subscribed to it (fan-out target).
        self._subs: dict[str, set[Any]] = {}
        # connection -> chat_ids it is subscribed to (O(1) cleanup on disconnect).
        self._conn_chats: dict[Any, set[str]] = {}
        # connection -> default chat_id for legacy frames that omit routing.
        self._conn_default: dict[Any, str] = {}
        # connection -> 是否处于前台（获焦）；Electron 连接建立后立即上报初值，
        # 字段缺失时兜底 True 以避免误触主动推送。
        self._conn_focused: dict[Any, bool] = {}
        # connection -> 是否处于锁屏状态；锁屏时不允许桌面上下文截图。
        # 字段缺失时兜底 False（未锁屏），锁屏事件由 Electron powerMonitor 上报。
        self._conn_locked: dict[Any, bool] = {}
        # 最近一条 user 消息来源的连接（Electron）。桌面上下文只针对用户最后交互的窗口，
        # 且仅当该窗口当前失焦时才允许截图。连接断开时清空。
        self._last_user_conn: Any | None = None
        # request_id -> Future[Path | None]：等待 screenshot_result 的挂起请求。
        self._screenshot_futures: dict[str, asyncio.Future[Any]] = {}
        # connection -> 该连接上正在进行的截图 request_id 集合，用于断开时取消。
        self._conn_screenshot_requests: dict[Any, set[str]] = {}
        # THA 独立页事件订阅连接，用于转发音频附件和表情事件。
        self._tha_event_subs: set[Any] = set()
        # audio_id -> start 阶段已接管该流的 THA 连接。所有权必须贯穿整条流，
        # 不能因 THA 在中途连接或断开而让 Electron 本地播放器接手半条音频。
        self._tha_audio_streams: dict[str, set[Any]] = {}
        self._stop_event: asyncio.Event | None = None
        self._server_task: asyncio.Task[None] | None = None
        self._session_manager = session_manager
        self._unified_session = unified_session
        self._transcripts = WebUITranscriptRecorder(self.logger)
        self._stream_text_buffers: dict[tuple[str, str], list[str]] = {}
        # 重启完成后、客户端重连前暂存的待投递消息（chat_id -> 消息列表）。
        # _hydrate_after_subscribe 会在订阅时统一投递并清空。
        self._pending_reconnect_messages: dict[str, list[Any]] = {}
        # Shared token store: WS handshake consumes issued tokens;
        # REST routes check (but don't consume) API tokens.
        self._tokens = gateway.tokens if gateway is not None else GatewayTokenStore()
        # 从 gateway 提取 workspaces，或按需创建。
        if gateway is not None and hasattr(gateway, "workspaces"):
            self._workspaces = gateway.workspaces
        else:
            _default_workspace = (
                Path(workspace_path).expanduser()
                if workspace_path is not None
                else Path.cwd()
            ).resolve(strict=False)
            self._workspaces = WebUIWorkspaceController(
                session_manager=session_manager,
                default_workspace=_default_workspace,
                default_restrict_to_workspace=default_restrict_to_workspace,
            )
        # HTTP route handler (all non-WS HTTP traffic delegates here).
        self._http_router = ForkGatewayHTTPHandler(
            config=config,
            session_manager=session_manager,
            cron_service=cron_service,
            static_dist_path=static_dist_path,
            workspace_path=workspace_path,
            diary_path=diary_path,
            runtime_model_name=runtime_model_name,
            runtime_model_setter=runtime_model_setter,
            runtime_surface=runtime_surface,
            runtime_capabilities_overrides=runtime_capabilities_overrides,
            workspaces=self._workspaces,
            bus=bus,
            tokens=self._tokens,
            media_secret=secrets.token_bytes(32),
            log=self.logger,
        )
        self._http_router._broadcast_tha_event = self._broadcast_tha_event
        # 代理对象：以上游 GatewayServices 兼容接口暴露 fork 内部对象，供测试使用。
        self.gateway = _GatewayProxy(
            tokens=self._tokens,
            http=self._http_router,
            workspace_path=workspace_path,
            session_manager=session_manager,
        )

    # -- Subscription bookkeeping -------------------------------------------

    def _attach(self, connection: Any, chat_id: str) -> None:
        """Idempotently subscribe *connection* to *chat_id*."""
        self._subs.setdefault(chat_id, set()).add(connection)
        self._conn_chats.setdefault(connection, set()).add(chat_id)

    def _cleanup_connection(self, connection: Any) -> None:
        """Remove *connection* from every subscription set; safe to call multiple times."""
        chat_ids = self._conn_chats.pop(connection, set())
        for cid in chat_ids:
            subs = self._subs.get(cid)
            if subs is None:
                continue
            subs.discard(connection)
            if not subs:
                self._subs.pop(cid, None)
        self._conn_default.pop(connection, None)
        self._conn_focused.pop(connection, None)
        self._conn_locked.pop(connection, None)
        self._tha_event_subs.discard(connection)
        if self._last_user_conn is connection:
            self._last_user_conn = None
        # 断开时取消该连接上所有挂起的截图请求，防止调用方永久阻塞。
        for req_id in self._conn_screenshot_requests.pop(connection, set()):
            fut = self._screenshot_futures.pop(req_id, None)
            if fut is not None and not fut.done():
                fut.cancel()

    def queue_pending_reconnect_message(self, msg: "OutboundMessage") -> None:
        """将消息缓存，待客户端重连并订阅该 chat_id 后统一投递。

        用于进程重启后、客户端尚未重连期间发出的重要消息（如"重启完成"通知）。
        每个 chat_id 最多保留 10 条，防止无限堆积。
        """
        queue = self._pending_reconnect_messages.setdefault(msg.chat_id, [])
        if len(queue) < 10:
            queue.append(msg)

    async def _maybe_push_active_goal_state(self, chat_id: str) -> None:
        """Replay an active sustained goal from session metadata after *chat_id* is subscribed.

        Goal metadata lives on the session JSONL and survives gateway restarts, but
        connected clients normally see it via ``goal_state`` / ``turn_end`` frames.
        Pushing here makes refresh + reconnect restore the strip without a new model turn.
        """
        if self._session_manager is None:
            return
        row = self._session_manager.read_session_file(f"websocket:{chat_id}")
        meta = row.get("metadata", {}) if isinstance(row, dict) else {}
        if not isinstance(meta, dict):
            meta = {}
        blob = goal_state_ws_blob(meta)
        if not blob.get("active"):
            return
        await self.send_goal_state(chat_id, blob)

    async def _maybe_push_turn_run_wall_clock(self, chat_id: str) -> None:
        """Replay ``goal_status: running`` when a turn is still active (same-process refresh)."""
        t0 = websocket_turn_wall_started_at(chat_id)
        if t0 is None:
            return
        await self.send_goal_status(chat_id, "running", started_at=t0)

    async def _hydrate_after_subscribe(self, chat_id: str) -> None:
        """Replay goal/run strip state after subscribe (same-process refresh)."""
        pending = self._pending_reconnect_messages.pop(chat_id, [])
        for msg in pending:
            await self.send(msg)
        await self._maybe_push_active_goal_state(chat_id)
        await self._maybe_push_turn_run_wall_clock(chat_id)

    async def _send_event(self, connection: Any, event: str, **fields: Any) -> None:
        """Send a control event (attached, error, ...) to a single connection."""
        payload: dict[str, Any] = {"event": event}
        payload.update(fields)
        raw = json.dumps(payload, ensure_ascii=False)
        try:
            await connection.send(raw)
        except ConnectionClosed:
            self._cleanup_connection(connection)
        except Exception as e:
            self.logger.warning("failed to send {} event: {}", event, e)

    @classmethod
    def default_config(cls) -> dict[str, Any]:
        return WebSocketConfig().model_dump(by_alias=True)

    def _expected_path(self) -> str:
        return _normalize_config_path(self.config.path)

    def _build_ssl_context(self) -> ssl.SSLContext | None:
        cert = self.config.ssl_certfile.strip()
        key = self.config.ssl_keyfile.strip()
        if not cert and not key:
            return None
        if not cert or not key:
            raise ValueError(
                "ssl_certfile and ssl_keyfile must both be set for WSS, or both left empty"
            )
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(certfile=cert, keyfile=key)
        return ctx

    # -- HTTP dispatch ------------------------------------------------------

    async def _dispatch_http(self, connection: Any, request: WsRequest) -> Any:
        """Route an inbound HTTP request: WS upgrade or delegate to HTTP router."""
        got, query = _parse_request_path(request.path)

        # WebSocket upgrade (the channel's primary purpose). Only run the
        # handshake gate on requests that actually ask to upgrade; otherwise
        # a bare ``GET /`` from the browser would be rejected as an
        # unauthorized WS handshake instead of serving the SPA's index.html.
        expected_ws = self._expected_path()
        if got == expected_ws and _is_websocket_upgrade(request):
            client_id = _query_first(query, "client_id") or ""
            if len(client_id) > 128:
                client_id = client_id[:128]
            if not self.is_allowed(client_id):
                return connection.respond(403, "Forbidden")
            return self._authorize_websocket_handshake(connection, query)

        if got == "/ws/tha" and _is_websocket_upgrade(request):
            return self._authorize_auxiliary_websocket_handshake(connection, request, query)

        if got == "/ws/tha-events" and _is_websocket_upgrade(request):
            return self._authorize_auxiliary_websocket_handshake(connection, request, query)

        # All other HTTP routes delegate to the extracted handler.
        return await self._http_router.dispatch(connection, request)

    def _authorize_websocket_handshake(self, connection: Any, query: dict[str, list[str]]) -> Any:
        supplied = _query_first(query, "token")
        static_token = self.config.token.strip()

        if static_token:
            if supplied and hmac.compare_digest(supplied, static_token):
                return None
            if supplied and self._tokens.take_issued_token_if_valid(supplied):
                return None
            return connection.respond(401, "Unauthorized")

        if self.config.websocket_requires_token:
            if supplied and self._tokens.take_issued_token_if_valid(supplied):
                return None
            return connection.respond(401, "Unauthorized")

        if supplied:
            self._tokens.take_issued_token_if_valid(supplied)
        return None

    def _authorize_auxiliary_websocket_handshake(
        self,
        connection: Any,
        request: WsRequest,
        query: dict[str, list[str]],
    ) -> Any:
        supplied = _query_first(query, "token")
        static_token = self.config.token.strip()
        if static_token and supplied and hmac.compare_digest(supplied, static_token):
            return None
        if self._tokens.check_api_token(request):
            return None
        if self.config.websocket_requires_token or static_token:
            return connection.respond(401, "Unauthorized")
        return None

    # -- Server lifecycle and connection ingress ---------------------------
    # -- Server lifecycle and connection ingress ---------------------------

    async def start(self) -> None:
        # 允许 PSB runtime-metadata 等大 query GET；若进程启动后才设置环境变量则在此同步。
        import os

        import websockets.http11 as ws_http11

        from nanobot.utils.logging_bridge import redirect_lib_logging

        line_limit = int(os.environ.get("WEBSOCKETS_MAX_LINE_LENGTH", "8192"))
        if ws_http11.MAX_LINE_LENGTH < line_limit:
            ws_http11.MAX_LINE_LENGTH = line_limit

        redirect_lib_logging("websockets", level="WARNING")
        ws_logger = websockets_server_logger()

        self._running = True
        self._stop_event = asyncio.Event()

        ssl_context = self._build_ssl_context()
        scheme = "wss" if ssl_context else "ws"

        async def process_request(
            connection: ServerConnection,
            request: WsRequest,
        ) -> Any:
            return await self._dispatch_http(connection, request)

        async def handler(connection: ServerConnection) -> None:
            await self._connection_loop(connection)

        self.logger.info(
            "WebSocket server listening on {}",
            (
                f"unix:{self.config.unix_socket_path}{self.config.path}"
                if self.config.unix_socket_path
                else f"{scheme}://{self.config.host}:{self.config.port}{self.config.path}"
            ),
        )
        if self.config.token_issue_path:
            self.logger.info(
                "WebSocket token issue route: {}",
                (
                    f"unix:{self.config.unix_socket_path}{_normalize_config_path(self.config.token_issue_path)}"
                    if self.config.unix_socket_path
                    else (
                        f"{scheme}://{self.config.host}:{self.config.port}"
                        f"{_normalize_config_path(self.config.token_issue_path)}"
                    )
                ),
            )

        async def runner() -> None:
            socket_path = self.config.unix_socket_path
            if socket_path:
                path_obj = Path(socket_path)
                path_obj.parent.mkdir(parents=True, exist_ok=True)
                with suppress(FileNotFoundError):
                    path_obj.unlink()
                server = await unix_serve(
                    handler,
                    socket_path,
                    process_request=process_request,
                    max_size=self.config.max_message_bytes,
                    ping_interval=self.config.ping_interval_s,
                    ping_timeout=self.config.ping_timeout_s,
                    logger=ws_logger,
                )
                with suppress(OSError):
                    path_obj.chmod(0o600)
            else:
                server = await serve(
                    handler,
                    self.config.host,
                    self.config.port,
                    process_request=process_request,
                    max_size=self.config.max_message_bytes,
                    ping_interval=self.config.ping_interval_s,
                    ping_timeout=self.config.ping_timeout_s,
                    ssl=ssl_context,
                    logger=ws_logger,
                )
            try:
                assert self._stop_event is not None
                await self._stop_event.wait()
            finally:
                server.close()
                await server.wait_closed()
                if socket_path:
                    with suppress(FileNotFoundError):
                        Path(socket_path).unlink()

        self._server_task = asyncio.create_task(runner())
        await self._server_task

    async def _connection_loop(self, connection: Any) -> None:
        request = connection.request
        path_part = request.path if request else "/"
        got, query = _parse_request_path(path_part)
        if got == "/ws/tha":
            await tha_websocket_loop(connection)
            return
        if got == "/ws/tha-events":
            await self._tha_events_loop(connection)
            return
        client_id_raw = _query_first(query, "client_id")
        client_id = client_id_raw.strip() if client_id_raw else ""
        if not client_id:
            client_id = f"anon-{uuid.uuid4().hex[:12]}"
        elif len(client_id) > 128:
            self.logger.warning("client_id too long ({} chars), truncating", len(client_id))
            client_id = client_id[:128]

        # 允许客户端通过 URL 查询参数指定 chat_id，Electron 等稳定客户端
        # 可借此在重连后恢复同一个 session（稳定会话 ID）。
        url_chat_id = _query_first(query, "chat_id")
        if url_chat_id and _is_valid_chat_id(url_chat_id):
            default_chat_id = url_chat_id
        else:
            default_chat_id = str(uuid.uuid4())

        try:
            await connection.send(
                json.dumps(
                    {
                        "event": "ready",
                        "chat_id": default_chat_id,
                        "client_id": client_id,
                    },
                    ensure_ascii=False,
                )
            )
            # Register only after ready is successfully sent to avoid out-of-order sends
            self._conn_default[connection] = default_chat_id
            self._attach(connection, default_chat_id)
            await self._hydrate_after_subscribe(default_chat_id)

            async for raw in connection:
                if isinstance(raw, bytes):
                    try:
                        raw = raw.decode("utf-8")
                    except UnicodeDecodeError:
                        self.logger.warning("ignoring non-utf8 binary frame")
                        continue

                envelope = _parse_envelope(raw)
                if envelope is not None:
                    await self._dispatch_envelope(connection, client_id, envelope)
                    continue

                content = _parse_inbound_payload(raw)
                if content is None:
                    continue
                # WebSocket already authenticates at handshake time (token),
                # so pairing is not applicable. Treat as non-DM to avoid
                # sending pairing codes to an already-authenticated client.
                await self._handle_message(
                    sender_id=client_id,
                    chat_id=default_chat_id,
                    content=content,
                    metadata={"remote": getattr(connection, "remote_address", None)},
                    is_dm=False,
                )
        except Exception as e:
            self.logger.debug("connection ended: {}", e)
        finally:
            self._cleanup_connection(connection)

    async def _tha_events_loop(self, connection: Any) -> None:
        """保持 THA 事件 WebSocket 订阅。"""
        self._tha_event_subs.add(connection)
        try:
            await connection.send(json.dumps({"type": "ready"}, ensure_ascii=False))
            async for raw in connection:
                if not isinstance(raw, str):
                    continue
                with suppress(json.JSONDecodeError):
                    payload = json.loads(raw)
                    if isinstance(payload, dict) and payload.get("type") == "ping":
                        await connection.send(
                            json.dumps(
                                {
                                    "type": "pong",
                                    "sentAt": payload.get("sentAt"),
                                },
                                ensure_ascii=False,
                            )
                        )
        except ConnectionClosed:
            return
        except Exception as e:
            self.logger.debug("THA event connection ended: {}", e)
        finally:
            self._cleanup_connection(connection)

    # -- Inbound WebSocket envelopes ---------------------------------------

    def _save_envelope_media(
        self,
        media: list[Any],
    ) -> tuple[list[str], str | None]:
        """Decode and persist ``media`` items from a ``message`` envelope.

        Returns ``(paths, None)`` on success or ``([], reason)`` on the first
        failure — the caller is expected to surface ``reason`` to the client
        and skip publishing so no half-formed message ever reaches the agent.
        On failure, any files already written to disk earlier in the same
        call are unlinked so partial ingress doesn't leak orphan files.
        ``reason`` is a short, stable token suitable for UI localization.

        Shape: ``list[{"data_url": str, "name"?: str | None}]``.
        """
        image_count = 0
        video_count = 0
        document_count = 0
        for item in media:
            if not isinstance(item, dict):
                continue
            mime = _extract_data_url_mime(item.get("data_url", ""))
            name = item.get("name")
            ext = _upload_extension(name)
            if mime in _VIDEO_MIME_ALLOWED:
                video_count += 1
            elif mime in _IMAGE_MIME_ALLOWED or ext in _IMAGE_EXTENSIONS:
                image_count += 1
            elif _upload_allowed(mime, name):
                document_count += 1
        total = image_count + video_count + document_count
        if total > _MAX_ATTACHMENTS_PER_MESSAGE:
            return [], "too_many_attachments"
        if image_count > _MAX_IMAGES_PER_MESSAGE:
            return [], "too_many_images"
        if video_count > _MAX_VIDEOS_PER_MESSAGE:
            return [], "too_many_videos"

        media_dir = get_media_dir("websocket")
        paths: list[str] = []

        def _abort(reason: str) -> tuple[list[str], str]:
            for p in paths:
                try:
                    Path(p).unlink(missing_ok=True)
                except OSError as exc:
                    self.logger.warning(
                        "failed to unlink partial media {}: {}", p, exc
                    )
            return [], reason

        for item in media:
            if not isinstance(item, dict):
                return _abort("malformed")
            data_url = item.get("data_url")
            if not isinstance(data_url, str) or not data_url:
                return _abort("malformed")
            mime = _extract_data_url_mime(data_url)
            if mime is None:
                return _abort("decode")
            item_name = item.get("name")
            if not _upload_allowed(mime, item_name):
                return _abort("mime")
            ext = _upload_extension(item_name)
            is_video = mime in _VIDEO_MIME_ALLOWED
            is_image = mime in _IMAGE_MIME_ALLOWED or ext in _IMAGE_EXTENSIONS
            if is_video:
                max_bytes = _MAX_VIDEO_BYTES
            elif is_image:
                max_bytes = _MAX_IMAGE_BYTES
            else:
                max_bytes = _MAX_DOCUMENT_BYTES
            save_name = item_name if isinstance(item_name, str) else None
            try:
                saved = save_base64_data_url(
                    data_url, media_dir, max_bytes=max_bytes, name=save_name,
                )
            except FileSizeExceeded:
                return _abort("size")
            except Exception as exc:
                self.logger.warning("media decode failed: {}", exc)
                return _abort("decode")
            if saved is None:
                return _abort("decode")
            paths.append(saved)
        return paths, None

    async def _dispatch_envelope(
        self,
        connection: Any,
        client_id: str,
        envelope: dict[str, Any],
    ) -> None:
        """Route one typed inbound envelope (``new_chat`` / ``attach`` / ``message``)."""
        t = envelope.get("type")
        if t == "new_chat":
            new_id = str(uuid.uuid4())
            scope = await self._workspace_scope_or_error(
                connection,
                lambda: self._workspaces.scope_for_new_chat(
                    envelope,
                    controls_available=_is_localhost(connection),
                ),
            )
            if scope is None:
                return
            self._workspaces.persist_scope(new_id, scope)
            self._attach(connection, new_id)
            await self._send_event(connection, "attached", chat_id=new_id)
            await self._send_event(
                connection,
                "session_updated",
                chat_id=new_id,
                scope="metadata",
                workspace_scope=scope.payload(),
            )
            await self._hydrate_after_subscribe(new_id)
            return
        if t == "attach":
            cid = envelope.get("chat_id")
            # "inbox:unified" 是特殊的 fan-out 订阅目标，不映射到任何 session，
            # 直接允许订阅，无需经过普通 chat_id 格式校验。
            if cid == INBOX_UNIFIED_CHAT_ID:
                self._attach(connection, INBOX_UNIFIED_CHAT_ID)
                await self._send_event(connection, "attached", chat_id=INBOX_UNIFIED_CHAT_ID)
                await self._hydrate_after_subscribe(INBOX_UNIFIED_CHAT_ID)
                return
            if not _is_valid_chat_id(cid):
                await self._send_event(connection, "error", detail="invalid chat_id")
                return
            self._attach(connection, cid)
            # 确保 session 在 manager 中存在，以便 attach 后立即可访问历史记录。
            if self._session_manager is not None:
                self._session_manager.get_or_create(f"websocket:{cid}")
            await self._send_event(connection, "attached", chat_id=cid)
            await self._hydrate_after_subscribe(cid)
            return
        if t == "set_workspace_scope":
            cid = envelope.get("chat_id")
            if not _is_valid_chat_id(cid):
                await self._send_event(connection, "error", detail="invalid chat_id")
                return
            scope = await self._workspace_scope_or_error(
                connection,
                lambda: self._workspaces.scope_for_set_request(
                    envelope,
                    chat_id=cid,
                    chat_running=websocket_turn_wall_started_at(cid) is not None,
                    controls_available=_is_localhost(connection),
                ),
                chat_id=cid,
            )
            if scope is None:
                return
            self._workspaces.persist_scope(cid, scope)
            await self._send_event(
                connection,
                "session_updated",
                chat_id=cid,
                scope="metadata",
                workspace_scope=scope.payload(),
            )
            return
        if t == "message":
            cid = envelope.get("chat_id")
            content = envelope.get("content")
            if not _is_valid_chat_id(cid):
                await self._send_event(connection, "error", detail="invalid chat_id")
                return
            raw_turn_id = envelope.get("turn_id")
            turn_id = raw_turn_id if isinstance(raw_turn_id, str) and raw_turn_id else None
            error_context = {
                "chat_id": cid,
                **({"turn_id": turn_id} if turn_id else {}),
            }
            if not isinstance(content, str):
                await self._send_event(
                    connection, "error", detail="missing content", **error_context,
                )
                return

            raw_media = envelope.get("media")
            media_paths: list[str] = []
            if raw_media is not None:
                if not isinstance(raw_media, list):
                    await self._send_event(
                        connection, "error",
                        detail="image_rejected", reason="malformed", **error_context,
                    )
                    return
                media_paths, reason = self._save_envelope_media(raw_media)
                if reason is not None:
                    await self._send_event(
                        connection, "error",
                        detail="image_rejected", reason=reason, **error_context,
                    )
                    return

            # Allow image-only turns (content may be empty when media is attached).
            if not content.strip() and not media_paths:
                await self._send_event(
                    connection, "error", detail="missing content", **error_context,
                )
                return
            scope = await self._workspace_scope_or_error(
                connection,
                lambda: self._workspaces.scope_for_message(
                    envelope,
                    chat_id=cid,
                    chat_running=websocket_turn_wall_started_at(cid) is not None,
                    controls_available=_is_localhost(connection),
                ),
                chat_id=cid,
                turn_id=turn_id,
            )
            if scope is None:
                return

            # Auto-attach on first use so clients can one-shot without a separate attach.
            self._attach(connection, cid)
            # 记录最近一条 user 消息来源连接，供桌面上下文判断目标窗口。
            self._last_user_conn = connection
            await self._hydrate_after_subscribe(cid)
            metadata: dict[str, Any] = {"remote": getattr(connection, "remote_address", None)}
            if envelope.get("webui") is True:
                metadata["webui"] = True
                metadata.update(self._transcripts.client_turn_metadata(envelope.get("turn_id")))
            cli_apps = normalize_cli_app_mentions(envelope.get("cli_apps"))
            if cli_apps:
                metadata["cli_apps"] = cli_apps
            mcp_presets = normalize_mcp_preset_mentions(envelope.get("mcp_presets"))
            if mcp_presets:
                metadata["mcp_presets"] = mcp_presets
            metadata[WORKSPACE_SCOPE_METADATA_KEY] = scope.metadata()
            self._workspaces.persist_scope(cid, scope)
            image_generation = envelope.get("image_generation")
            if isinstance(image_generation, dict) and image_generation.get("enabled") is True:
                aspect_ratio = image_generation.get("aspect_ratio")
                metadata["image_generation"] = {
                    "enabled": True,
                    "aspect_ratio": aspect_ratio if isinstance(aspect_ratio, str) else None,
                }
            user_event: dict[str, Any] = {
                "event": "user",
                "chat_id": cid,
                "text": content,
            }
            if media_paths:
                user_event["media_paths"] = media_paths
            if cli_apps:
                user_event["cli_apps"] = cli_apps
            if mcp_presets:
                user_event["mcp_presets"] = mcp_presets
            self._transcripts.prepare_and_append(
                cid,
                user_event,
                metadata=metadata,
                phase="user",
            )
            await self._handle_message(
                sender_id=client_id,
                chat_id=cid,
                content=content,
                media=media_paths or None,
                metadata=metadata,
                is_dm=False,
            )
            return
        if t == "presence":
            # Electron 上报窗口焦点/锁屏状态。
            # focused 字段缺失时兜底 true，避免因协议疏漏误触主动推送。
            # locked 字段缺失时兜底 false（未锁屏）。
            focused = envelope.get("focused")
            self._conn_focused[connection] = bool(focused) if isinstance(focused, bool) else True
            locked = envelope.get("locked")
            if isinstance(locked, bool):
                self._conn_locked[connection] = locked
            return
        if t == "screenshot_result":
            req_id = envelope.get("request_id")
            data = envelope.get("data")
            if not isinstance(req_id, str) or not isinstance(data, str):
                return  # 格式错误，静默丢弃
            fut = self._screenshot_futures.get(req_id)
            if fut is None or fut.done():
                return  # 无对应等待者或已超时
            # 校验 data URL 为 JPEG 且体积在允许范围内
            mime = _extract_data_url_mime(data)
            if mime != "image/jpeg":
                self.logger.warning("screenshot_result: 期望 image/jpeg，收到 {}", mime)
                fut.set_result(None)
                return
            # base64 body 长度换算为字节：每 4 字符约 3 字节
            estimated_bytes = len(data) * 3 // 4
            if estimated_bytes > _MAX_SCREENSHOT_BYTES:
                self.logger.warning(
                    "screenshot_result: 体积 {} 字节超过上限 {}，丢弃",
                    estimated_bytes, _MAX_SCREENSHOT_BYTES,
                )
                fut.set_result(None)
                return
            try:
                b64_start = data.index(",") + 1
                raw = base64.b64decode(data[b64_start:])
            except Exception as e:
                self.logger.warning("screenshot_result: base64 解码失败: {}", e)
                fut.set_result(None)
                return
            try:
                out = get_media_dir("websocket") / "screenshots" / f"{req_id}.jpg"
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(raw)
            except OSError as e:
                self.logger.exception("screenshot_result: 写文件失败: {}", e)
                fut.set_result(None)
                return
            fut.set_result(out)
            return
        await self._send_event(connection, "error", detail=f"unknown type: {t!r}")

    async def _workspace_scope_or_error(
        self,
        connection: Any,
        resolver: Callable[[], Any],
        *,
        chat_id: str | None = None,
        turn_id: str | None = None,
    ) -> Any | None:
        try:
            return resolver()
        except WorkspaceScopeError as exc:
            await self._send_event(
                connection,
                "error",
                detail="workspace_scope_rejected",
                reason=exc.message,
                **({"chat_id": chat_id} if chat_id else {}),
                **({"turn_id": turn_id} if turn_id else {}),
            )
            return None

    # -- Outbound WebSocket events -----------------------------------------

    async def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        if self._stop_event:
            self._stop_event.set()
        if self._server_task:
            try:
                await self._server_task
            except Exception as e:
                self.logger.warning("server task error during shutdown: {}", e)
            self._server_task = None
        self._subs.clear()
        self._conn_chats.clear()
        self._conn_default.clear()
        self._conn_focused.clear()
        self._conn_locked.clear()
        self._last_user_conn = None
        for fut in self._screenshot_futures.values():
            if not fut.done():
                fut.cancel()
        self._screenshot_futures.clear()
        self._conn_screenshot_requests.clear()
        self._tha_event_subs.clear()
        self._tha_audio_streams.clear()
        self._tokens.clear()

    async def _safe_send_to(self, connection: Any, raw: str, *, label: str = "") -> None:
        """Send a raw frame to one connection, cleaning up on ConnectionClosed."""
        try:
            await connection.send(raw)
        except ConnectionClosed:
            self._cleanup_connection(connection)
            self.logger.warning("connection gone{}", label)
        except Exception:
            self.logger.exception("send failed{}", label)

    @staticmethod
    def _is_audio_media_ref(ref: str, signed: dict[str, str] | None = None) -> bool:
        candidates = [ref]
        if signed:
            candidates.extend(value for key, value in signed.items() if key in {"url", "name"})
        for candidate in candidates:
            mime, _ = mimetypes.guess_type(candidate)
            if mime and mime.startswith("audio/"):
                return True
            lower = candidate.lower().split("?", 1)[0]
            if lower.endswith((".mp3", ".wav", ".ogg", ".aac", ".m4a", ".weba", ".flac", ".opus")):
                return True
        return False

    async def _broadcast_tha_event(self, event: dict[str, Any]) -> int:
        conns = list(self._tha_event_subs)
        if not conns:
            return 0
        raw = json.dumps(event, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" tha_events ")
        return len(conns)

    async def send_assistant_audio(
        self,
        chat_id: str,
        audio: dict[str, Any],
        metadata: dict[str, Any] | None = None,
    ) -> None:
        phase = str(audio.get("phase") or "")
        if phase not in {"start", "chunk", "end", "error"}:
            return
        live_audio = dict(audio)
        persisted_audio = dict(audio)
        prepared_turn_fields: dict[str, Any] = {}
        audio_id = str(audio.get("audioId") or "")
        if phase == "start" and audio_id and self._tha_event_subs:
            self._tha_audio_streams[audio_id] = set(self._tha_event_subs)
        tha_owners = self._tha_audio_streams.get(audio_id, set())
        tha_owns_stream = bool(tha_owners)
        if phase == "start" and tha_owns_stream:
            live_audio["owner"] = "tha"
        if phase == "end":
            path = audio.get("path")
            if isinstance(path, str) and path:
                signed = self._http_router.sign_or_stage_media_path(Path(path))
                if signed is not None:
                    live_audio["url"] = signed.get("url")
                    live_audio.setdefault("name", signed.get("name"))
            live_audio.pop("path", None)
            transcript_event = {
                "event": "assistant_audio_end",
                "chat_id": chat_id,
                "audio": persisted_audio,
            }
            self._transcripts.prepare_and_append(
                chat_id,
                transcript_event,
                metadata=metadata,
                phase="answer",
            )
            prepared_turn_fields = {
                key: transcript_event[key]
                for key in ("turn_id", "turn_phase", "turn_seq")
                if key in transcript_event
            }

        payload = {
            "event": f"assistant_audio_{phase}",
            "chat_id": chat_id,
            "audio": live_audio,
            **prepared_turn_fields,
        }
        if phase != "end":
            self._transcripts.prepare_event(
                chat_id,
                payload,
                metadata=metadata,
                phase="answer",
            )
        if tha_owns_stream:
            tha_raw = json.dumps(
                {
                    "type": f"assistant_audio_{phase}",
                    "chatId": chat_id,
                    "audio": live_audio,
                },
                ensure_ascii=False,
            )
            for connection in list(tha_owners):
                await self._safe_send_to(connection, tha_raw, label=" tha_audio ")
            if phase in {"end", "error"}:
                self._tha_audio_streams.pop(audio_id, None)
        raw = json.dumps(payload, ensure_ascii=False)
        for connection in list(self._subs.get(chat_id, ())):
            await self._safe_send_to(connection, raw, label=" assistant_audio ")

    async def _fan_out_to_unified_inbox(
        self,
        payload: dict[str, Any],
        source_channel: str,
        source_chat_id: str,
    ) -> None:
        """将事件改写为统一收件箱路由后推送给其订阅者。"""
        inbox_conns = list(self._subs.get(INBOX_UNIFIED_CHAT_ID, ()))
        if not inbox_conns:
            return
        fan_payload = dict(payload)
        fan_payload["chat_id"] = INBOX_UNIFIED_CHAT_ID
        fan_payload["source_channel"] = source_channel
        fan_payload["source_chat_id"] = source_chat_id
        fan_raw = json.dumps(fan_payload, ensure_ascii=False)
        for connection in inbox_conns:
            await self._safe_send_to(connection, fan_raw, label=" inbox:unified ")

    async def fan_out_unified_inbox_event(
        self,
        payload: dict[str, Any],
        source_channel: str,
        source_chat_id: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """将任意 wire 事件推送给 ``inbox:unified`` 订阅者（供 ChannelManager 跨通道 fan-out）。"""
        if not self._unified_session:
            return
        event = payload.get("event")
        phase = (
            "user"
            if event in {"user", "vision_caption_delta", "vision_caption_end"}
            else "reasoning"
            if event in {"reasoning_delta", "reasoning_end"}
            else "activity"
            if event == "file_edit" or payload.get("kind") in {"tool_hint", "progress"}
            else "complete"
            if event == "turn_end"
            else "answer"
        )
        self._transcripts.prepare_event(
            INBOX_UNIFIED_CHAT_ID,
            payload,
            metadata=metadata,
            phase=phase,
        )
        await self._fan_out_to_unified_inbox(payload, source_channel, source_chat_id)

    async def send(self, msg: OutboundMessage) -> None:
        if msg.metadata.get("_runtime_model_updated"):
            await self.send_runtime_model_updated(
                model_name=msg.metadata.get("model"),
                model_preset=msg.metadata.get("model_preset"),
            )
            return

        # 非 WebSocket 通道的出站消息经 ChannelManager 路由至此，
        # 写入统一 transcript 并推送给 inbox:unified 订阅者。
        if msg.metadata.get("_unified_inbox_write"):
            source_ch = str(msg.metadata.get("source_channel") or "unknown")
            source_cid = str(msg.metadata.get("source_chat_id") or "")
            text = msg.content
            wire_text = self._http_router.rewrite_local_markdown_images(text)
            payload: dict[str, Any] = {
                "event": "message",
                "chat_id": INBOX_UNIFIED_CHAT_ID,
                "text": wire_text,
            }
            if msg.metadata.get("_channel_delivery"):
                payload["channel_delivery"] = True
            if msg.metadata.get("_user_initiated_channel_delivery"):
                payload["user_initiated_delivery"] = True
            delivery_channel = msg.metadata.get("source_channel")
            if isinstance(delivery_channel, str) and delivery_channel:
                payload["source_channel"] = delivery_channel
            delivery_chat = msg.metadata.get("source_chat_id")
            if isinstance(delivery_chat, str) and delivery_chat:
                payload["source_chat_id"] = delivery_chat
            cron_job_id = msg.metadata.get("_cron_job_id")
            if isinstance(cron_job_id, str) and cron_job_id:
                payload["cron_job_id"] = cron_job_id
            cron_job_name = msg.metadata.get("_cron_job_name")
            if isinstance(cron_job_name, str) and cron_job_name:
                payload["cron_job_name"] = cron_job_name
            fallback_models = msg.metadata.get("_fallback_models")
            if isinstance(fallback_models, list) and fallback_models:
                payload["fallback_models"] = fallback_models
            response_model = msg.metadata.get("_response_model")
            if isinstance(response_model, dict) and response_model.get("model"):
                payload["response_model"] = str(response_model["model"])
                response_provider = response_model.get("provider")
                if isinstance(response_provider, str) and response_provider:
                    payload["response_provider"] = response_provider
            fallback_used = msg.metadata.get("_fallback_used")
            if isinstance(fallback_used, bool):
                payload["fallback_used"] = fallback_used
            if msg.media:
                urls: list[dict[str, str]] = []
                audio_urls: list[dict[str, str]] = []
                for entry in msg.media:
                    if not isinstance(entry, str) or not entry:
                        continue
                    if is_remote_media_url(entry):
                        remote_payload = self._http_router.remote_media_payload(entry)
                        urls.append(remote_payload)
                        if self._is_audio_media_ref(entry, remote_payload):
                            audio_urls.append(remote_payload)
                        continue
                    signed = self._http_router.sign_or_stage_media_path(Path(entry))
                    if signed is not None:
                        urls.append(signed)
                        if self._is_audio_media_ref(entry, signed):
                            audio_urls.append(signed)
                if urls:
                    payload["media_urls"] = urls
                if audio_urls:
                    tha_subscribers = await self._broadcast_tha_event(
                        {
                            "type": "audio",
                            "chatId": INBOX_UNIFIED_CHAT_ID,
                            "text": text,
                            "media": audio_urls,
                        }
                    )
                    if tha_subscribers > 0:
                        payload["tha_played"] = True
            self._transcripts.prepare_event(
                INBOX_UNIFIED_CHAT_ID,
                payload,
                metadata=msg.metadata,
                phase="answer",
            )
            # 进程重启后历史图片失效是现有的已知限制（签名 URL 绑定进程生命周期）。
            await self._fan_out_to_unified_inbox(payload, source_ch, source_cid)
            return

        # 非 WebSocket 通道的入站用户消息，推送给 inbox:unified 订阅者。
        if msg.metadata.get("_unified_inbox_inbound"):
            source_ch = str(msg.metadata.get("source_channel") or "unknown")
            source_cid = str(msg.metadata.get("source_chat_id") or "")
            user_obj: dict[str, Any] = {
                "event": "user",
                "chat_id": INBOX_UNIFIED_CHAT_ID,
                "text": msg.content,
            }
            if msg.media:
                urls: list[dict[str, str]] = []
                for entry in msg.media:
                    if not isinstance(entry, str) or not entry:
                        continue
                    if is_remote_media_url(entry):
                        urls.append(self._http_router.remote_media_payload(entry))
                        continue
                    signed = self._http_router.sign_or_stage_media_path(Path(entry))
                    if signed is not None:
                        urls.append(signed)
                if urls:
                    user_obj["media_urls"] = urls
            self._transcripts.prepare_event(
                INBOX_UNIFIED_CHAT_ID,
                user_obj,
                metadata=msg.metadata,
                phase="user",
            )
            await self._fan_out_to_unified_inbox(user_obj, source_ch, source_cid)
            return

        # Snapshot the subscriber set so ConnectionClosed cleanups mid-iteration are safe.
        conns = list(self._subs.get(msg.chat_id, ()))
        fan_out_unified = self._unified_session and msg.chat_id != INBOX_UNIFIED_CHAT_ID
        if not conns and not (
            fan_out_unified and self._subs.get(INBOX_UNIFIED_CHAT_ID)
        ):
            if (
                msg.metadata.get("_progress")
                or msg.metadata.get("_file_edit_events")
                or msg.metadata.get("_turn_model_updated")
                or msg.metadata.get("_turn_end")
                or msg.metadata.get("_session_updated")
                or msg.metadata.get("_goal_status")
                or msg.metadata.get("_goal_state_sync")
            ):
                self.logger.debug("no active subscribers for chat_id={}", msg.chat_id)
            else:
                self.logger.warning("no active subscribers for chat_id={}", msg.chat_id)
            return
        if msg.metadata.get("_turn_model_updated"):
            await self.send_turn_model_updated(
                msg.chat_id,
                model_name=msg.metadata.get("model"),
                provider_name=msg.metadata.get("provider"),
                is_fallback=msg.metadata.get("is_fallback"),
                metadata=msg.metadata,
            )
            return
        if msg.metadata.get("_goal_state_sync"):
            blob = msg.metadata.get("goal_state")
            await self.send_goal_state(msg.chat_id, blob if isinstance(blob, dict) else {"active": False})
            return
        if msg.metadata.get("_goal_status"):
            status = msg.metadata.get("goal_status")
            if status in ("running", "idle"):
                started_raw = msg.metadata.get("started_at", msg.metadata.get("goal_started_at"))
                await self.send_goal_status(
                    msg.chat_id,
                    status,
                    started_at=float(started_raw) if isinstance(started_raw, int | float) else None,
                )
            return
        # Signal that the agent has fully finished processing the current turn.
        if msg.metadata.get("_turn_end"):
            lat = msg.metadata.get("latency_ms")
            lat_i = int(lat) if isinstance(lat, (int, float)) else None
            gs = msg.metadata.get("goal_state")
            gs_blob = gs if isinstance(gs, dict) else None
            usg = msg.metadata.get("usage")
            usg_dict = usg if isinstance(usg, dict) else None
            await self.send_turn_end(
                msg.chat_id,
                latency_ms=lat_i,
                goal_state=gs_blob,
                usage=usg_dict,
                metadata=msg.metadata,
            )
            return
        if msg.metadata.get("_session_updated"):
            scope = msg.metadata.get("_session_update_scope")
            await self.send_session_updated(
                msg.chat_id,
                scope=scope if isinstance(scope, str) else None,
            )
            return
        if msg.metadata.get("_file_edit_events"):
            edits = msg.metadata.get("_file_edit_events")
            await self.send_file_edit_events(
                msg.chat_id,
                edits if isinstance(edits, list) else [],
                msg.metadata,
            )
            return
        text = msg.content
        wire_text = self._http_router.rewrite_local_markdown_images(text)
        payload: dict[str, Any] = {
            "event": "message",
            "chat_id": msg.chat_id,
            "text": wire_text,
        }
        if msg.media:
            payload["media"] = msg.media
            urls: list[dict[str, str]] = []
            audio_urls: list[dict[str, str]] = []
            for entry in msg.media:
                if not isinstance(entry, str) or not entry:
                    continue
                if is_remote_media_url(entry):
                    remote_payload = self._http_router.remote_media_payload(entry)
                    urls.append(remote_payload)
                    if self._is_audio_media_ref(entry, remote_payload):
                        audio_urls.append(remote_payload)
                    continue
                signed = self._http_router.sign_or_stage_media_path(Path(entry))
                if signed is not None:
                    urls.append(signed)
                    if self._is_audio_media_ref(entry, signed):
                        audio_urls.append(signed)
            if urls:
                payload["media_urls"] = urls
            if audio_urls:
                tha_subscribers = await self._broadcast_tha_event(
                    {
                        "type": "audio",
                        "chatId": msg.chat_id,
                        "text": text,
                        "media": audio_urls,
                    }
                )
                if tha_subscribers > 0:
                    payload["tha_played"] = True
        if msg.reply_to:
            payload["reply_to"] = msg.reply_to
        lat = msg.metadata.get("latency_ms")
        if isinstance(lat, (int, float)):
            payload["latency_ms"] = int(lat)
        usage = msg.metadata.get("usage")
        if isinstance(usage, dict) and usage:
            payload["usage"] = usage
        if msg.metadata.get("_tool_events"):
            payload["tool_events"] = msg.metadata["_tool_events"]
        agent_ui = msg.metadata.get(OUTBOUND_META_AGENT_UI)
        if agent_ui is not None:
            payload["agent_ui"] = agent_ui
        # Mark intermediate agent breadcrumbs (tool-call hints, generic
        # progress strings) so WS clients can render them as subordinate
        # trace rows rather than conversational replies.
        if msg.metadata.get("_tool_hint"):
            payload["kind"] = "tool_hint"
        elif msg.metadata.get("_progress"):
            payload["kind"] = "progress"
        activity_id = msg.metadata.get("_activity_id")
        if isinstance(activity_id, str) and activity_id:
            payload["activity_id"] = activity_id
            activity_status = msg.metadata.get("_activity_status")
            if activity_status in {"start", "end"}:
                payload["activity_status"] = activity_status
        if msg.metadata.get("_channel_delivery"):
            payload["channel_delivery"] = True
        if msg.metadata.get("_user_initiated_channel_delivery"):
            payload["user_initiated_delivery"] = True
        delivery_channel = msg.metadata.get("source_channel")
        if isinstance(delivery_channel, str) and delivery_channel:
            payload["source_channel"] = delivery_channel
        delivery_chat = msg.metadata.get("source_chat_id")
        if isinstance(delivery_chat, str) and delivery_chat:
            payload["source_chat_id"] = delivery_chat
        cron_job_id = msg.metadata.get("_cron_job_id")
        if isinstance(cron_job_id, str) and cron_job_id:
            payload["cron_job_id"] = cron_job_id
        cron_job_name = msg.metadata.get("_cron_job_name")
        if isinstance(cron_job_name, str) and cron_job_name:
            payload["cron_job_name"] = cron_job_name
        fallback_models = msg.metadata.get("_fallback_models")
        if isinstance(fallback_models, list) and fallback_models:
            payload["fallback_models"] = fallback_models
        response_model = msg.metadata.get("_response_model")
        if isinstance(response_model, dict) and response_model.get("model"):
            payload["response_model"] = str(response_model["model"])
            response_provider = response_model.get("provider")
            if isinstance(response_provider, str) and response_provider:
                payload["response_provider"] = response_provider
        fallback_used = msg.metadata.get("_fallback_used")
        if isinstance(fallback_used, bool):
            payload["fallback_used"] = fallback_used
        phase = "activity" if payload.get("kind") in {"tool_hint", "progress"} else "answer"
        if msg.metadata.get("_activity_ephemeral"):
            self._transcripts.prepare_event(
                msg.chat_id,
                payload,
                metadata=msg.metadata,
                phase=phase,
            )
        else:
            self._transcripts.prepare_and_append(
                msg.chat_id,
                payload,
                metadata=msg.metadata,
                phase=phase,
                transcript_overrides={"text": text},
            )
        raw = json.dumps(payload, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" ")
        # 历史数据由 Session 直接提供，无需再写入 unified transcript 文件。
        if fan_out_unified and not msg.metadata.get("_progress"):
            await self._fan_out_to_unified_inbox(payload, "websocket", msg.chat_id)

    async def send_reasoning_delta(
        self,
        chat_id: str,
        delta: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Push one chunk of model reasoning. Mirrors ``send_delta`` shape so
        clients receive a stream that opens, updates in place, and closes —
        rendered above the active assistant bubble with a shimmer header
        until the matching ``reasoning_end`` arrives.
        """
        conns = list(self._subs.get(chat_id, ()))
        fan_out_unified = self._unified_session and chat_id != INBOX_UNIFIED_CHAT_ID
        if not delta or (
            not conns
            and not (fan_out_unified and self._subs.get(INBOX_UNIFIED_CHAT_ID))
        ):
            return
        meta = metadata or {}
        body: dict[str, Any] = {
            "event": "reasoning_delta",
            "chat_id": chat_id,
            "text": delta,
        }
        stream_id = meta.get("_stream_id")
        if stream_id is not None:
            body["stream_id"] = stream_id
        self._transcripts.prepare_and_append(
            chat_id,
            body,
            metadata=meta,
            phase="reasoning",
        )
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" reasoning ")
        if fan_out_unified:
            await self._fan_out_to_unified_inbox(body, "websocket", chat_id)

    async def send_reasoning_end(
        self,
        chat_id: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Close the current reasoning stream segment for in-place renderers."""
        conns = list(self._subs.get(chat_id, ()))
        fan_out_unified = self._unified_session and chat_id != INBOX_UNIFIED_CHAT_ID
        if not conns and not (
            fan_out_unified and self._subs.get(INBOX_UNIFIED_CHAT_ID)
        ):
            return
        meta = metadata or {}
        body: dict[str, Any] = {
            "event": "reasoning_end",
            "chat_id": chat_id,
        }
        stream_id = meta.get("_stream_id")
        if stream_id is not None:
            body["stream_id"] = stream_id
        self._transcripts.prepare_and_append(
            chat_id,
            body,
            metadata=meta,
            phase="reasoning",
        )
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" reasoning_end ")
        if fan_out_unified:
            await self._fan_out_to_unified_inbox(body, "websocket", chat_id)

    async def send_vision_caption_delta(
        self,
        chat_id: str,
        delta: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        conns = list(self._subs.get(chat_id, ()))
        if not conns or not delta:
            return
        meta = metadata or {}
        body: dict[str, Any] = {
            "event": "vision_caption_delta",
            "chat_id": chat_id,
            "text": delta,
        }
        stream_id = meta.get("_stream_id")
        if stream_id is not None:
            body["stream_id"] = stream_id
        image_index = meta.get("image_index")
        if isinstance(image_index, int):
            body["image_index"] = image_index
        self._transcripts.prepare_and_append(
            chat_id,
            body,
            metadata=meta,
            phase="user",
        )
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" vision_caption ")

    async def send_vision_caption_end(
        self,
        chat_id: str,
        metadata: dict[str, Any] | None = None,
        text: str = "",
    ) -> None:
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        meta = metadata or {}
        body: dict[str, Any] = {
            "event": "vision_caption_end",
            "chat_id": chat_id,
        }
        stream_id = meta.get("_stream_id")
        if stream_id is not None:
            body["stream_id"] = stream_id
        image_index = meta.get("image_index")
        if isinstance(image_index, int):
            body["image_index"] = image_index
        error = meta.get("_vision_caption_error")
        if isinstance(error, str) and error:
            body["error"] = error
        if text:
            body["text"] = text
        self._transcripts.prepare_and_append(
            chat_id,
            body,
            metadata=meta,
            phase="user",
        )
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" vision_caption_end ")

    async def send_file_edit_events(
        self,
        chat_id: str,
        edits: list[dict[str, Any]],
        metadata: dict[str, Any] | None = None,
    ) -> None:
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        payload: dict[str, Any] = {
            "event": "file_edit",
            "chat_id": chat_id,
            "edits": edits,
        }
        self._transcripts.prepare_and_append(
            chat_id,
            payload,
            metadata=metadata,
            phase="activity",
        )
        raw = json.dumps(payload, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" file_edit ")

    async def send_delta(
        self,
        chat_id: str,
        delta: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        conns = list(self._subs.get(chat_id, ()))
        fan_out_unified = self._unified_session and chat_id != INBOX_UNIFIED_CHAT_ID
        has_unified_inbox_subs = fan_out_unified and bool(
            self._subs.get(INBOX_UNIFIED_CHAT_ID)
        )
        if not conns and not has_unified_inbox_subs:
            return
        meta = metadata or {}
        stream_key = (chat_id, str(meta.get("_stream_id") or ""))
        full_text: str | None = None
        if meta.get("_stream_end"):
            body: dict[str, Any] = {"event": "stream_end", "chat_id": chat_id}
            buffered = self._stream_text_buffers.pop(stream_key, [])
            if delta:
                buffered.append(delta)
                tail_body: dict[str, Any] = {
                    "event": "delta",
                    "chat_id": chat_id,
                    "text": delta,
                }
                if meta.get("_stream_id") is not None:
                    tail_body["stream_id"] = meta["_stream_id"]
                self._transcripts.prepare_and_append(
                    chat_id,
                    tail_body,
                    metadata=meta,
                    phase="answer",
                )
                if fan_out_unified:
                    await self._fan_out_to_unified_inbox(
                        tail_body, "websocket", chat_id
                    )
                tail_raw = json.dumps(tail_body, ensure_ascii=False)
                for connection in conns:
                    await self._safe_send_to(connection, tail_raw, label=" stream ")
            full_text = "".join(buffered)
            rewritten = self._http_router.rewrite_local_markdown_images(full_text)
            if rewritten != full_text:
                body["text"] = rewritten
        else:
            body = {
                "event": "delta",
                "chat_id": chat_id,
                "text": delta,
            }
            self._stream_text_buffers.setdefault(stream_key, []).append(delta)
        if meta.get("_stream_id") is not None:
            body["stream_id"] = meta["_stream_id"]
        self._transcripts.prepare_and_append(
            chat_id,
            body,
            metadata=meta,
            phase="answer",
        )
        if fan_out_unified and body.get("event") == "delta":
            await self._fan_out_to_unified_inbox(body, "websocket", chat_id)
        if fan_out_unified and full_text is not None:
            await self._fan_out_to_unified_inbox(body, "websocket", chat_id)
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" stream ")

    async def send_turn_end(
        self,
        chat_id: str,
        latency_ms: int | None = None,
        *,
        goal_state: dict[str, Any] | None = None,
        usage: dict[str, int] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Signal that the agent has fully finished processing the current turn."""
        conns = list(self._subs.get(chat_id, ()))
        fan_out_unified = self._unified_session and chat_id != INBOX_UNIFIED_CHAT_ID
        if not conns and not (
            fan_out_unified and self._subs.get(INBOX_UNIFIED_CHAT_ID)
        ):
            return
        body: dict[str, Any] = {"event": "turn_end", "chat_id": chat_id}
        if latency_ms is not None:
            body["latency_ms"] = int(latency_ms)
        if goal_state is not None:
            body["goal_state"] = goal_state
        if usage:
            body["usage"] = usage
        response_model = (metadata or {}).get("_response_model")
        if isinstance(response_model, dict) and response_model.get("model"):
            body["response_model"] = str(response_model["model"])
            response_provider = response_model.get("provider")
            if isinstance(response_provider, str) and response_provider:
                body["response_provider"] = response_provider
        fallback_used = (metadata or {}).get("_fallback_used")
        if isinstance(fallback_used, bool):
            body["fallback_used"] = fallback_used
        fallback_models = (metadata or {}).get("_fallback_models")
        if isinstance(fallback_models, list) and fallback_models:
            body["fallback_models"] = fallback_models
        self._transcripts.prepare_and_append(
            chat_id,
            body,
            metadata=metadata,
            phase="complete",
        )
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" turn_end ")
        if fan_out_unified:
            await self._fan_out_to_unified_inbox(body, "websocket", chat_id)

    async def send_goal_state(self, chat_id: str, blob: dict[str, Any]) -> None:
        """Push persisted goal-state snapshot for *chat_id* (multi-chat isolation)."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        body = {"event": "goal_state", "chat_id": chat_id, "goal_state": blob}
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" goal_state ")

    async def send_goal_status(
        self,
        chat_id: str,
        status: str,
        *,
        started_at: float | None = None,
    ) -> None:
        """Notify subscribed clients that a turn started or finished (wall-clock hint)."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        body: dict[str, Any] = {
            "event": "goal_status",
            "chat_id": chat_id,
            "status": status,
        }
        if status == "running" and started_at is not None:
            body["started_at"] = started_at
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" goal_status ")

    async def send_session_updated(self, chat_id: str, *, scope: str | None = None) -> None:
        """Notify clients that session metadata changed outside the main turn."""
        conns = list(self._subs.get(chat_id, ()))
        if not conns:
            return
        body: dict[str, Any] = {"event": "session_updated", "chat_id": chat_id}
        if scope:
            body["scope"] = scope
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" session_updated ")

    async def request_screenshot(
        self,
        connection: Any,
        *,
        timeout_s: float = 10.0,
    ) -> "Path | None":
        """向指定连接发送截图请求，异步等待 screenshot_result 返回落盘路径。

        超时、连接断开或解码失败均返回 ``None``，不抛出异常。
        结果文件落盘到 ``get_media_dir("websocket")/screenshots/<request_id>.jpg``。
        """
        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[Any] = loop.create_future()
        self._screenshot_futures[request_id] = fut
        self._conn_screenshot_requests.setdefault(connection, set()).add(request_id)
        try:
            await self._safe_send_to(
                connection,
                json.dumps(
                    {"event": "screenshot_request", "request_id": request_id},
                    ensure_ascii=False,
                ),
            )
            # 超时即放弃：wait_for 取消 fut，迟到的 screenshot_result 因 fut.done() 被安全丢弃。
            return await asyncio.wait_for(fut, timeout=timeout_s)
        except asyncio.TimeoutError:
            self.logger.warning("截图请求超时 request_id={}", request_id)
            return None
        except Exception as e:
            self.logger.warning("截图请求失败: {}", e)
            return None
        finally:
            self._screenshot_futures.pop(request_id, None)
            reqs = self._conn_screenshot_requests.get(connection)
            if reqs is not None:
                reqs.discard(request_id)

    def is_connection_focused(self, connection: Any) -> bool:
        """返回连接的焦点状态；字段缺失时兜底为 True。"""
        return self._conn_focused.get(connection, True)

    def is_connection_locked(self, connection: Any) -> bool:
        """返回连接的锁屏状态；字段缺失时兜底为 False（未锁屏）。"""
        return self._conn_locked.get(connection, False)

    def get_unfocused_last_user_connection(self) -> "tuple[Any, str] | None":
        """返回最近一条 user 消息来源连接及其默认 chat_id（若它仍在线且当前失焦且未锁屏）。

        桌面上下文据此决定是否允许截图。下列情况返回 ``None``：
        - 尚无任何 user 消息来源连接；
        - 该连接已断开（清理后不在默认映射中）；
        - 该连接当前在前台（获焦）；
        - 该连接对应的屏幕处于锁屏状态。
        """
        conn = self._last_user_conn
        if conn is None:
            return None
        if conn not in self._conn_default:
            return None
        if self._conn_focused.get(conn, True):
            return None
        if self._conn_locked.get(conn, False):
            self.logger.debug("桌面上下文：屏幕已锁，跳过")
            return None
        return (conn, self._conn_default.get(conn, ""))

    async def send_runtime_model_updated(
        self,
        *,
        model_name: Any,
        model_preset: Any = None,
    ) -> None:
        """Broadcast runtime model changes to every open websocket connection."""
        conns = list(self._conn_chats)
        if not conns or not isinstance(model_name, str) or not model_name.strip():
            return
        body: dict[str, Any] = {
            "event": "runtime_model_updated",
            "model_name": model_name.strip(),
        }
        if isinstance(model_preset, str) and model_preset.strip():
            body["model_preset"] = model_preset.strip()
        raw = json.dumps(body, ensure_ascii=False)
        for connection in conns:
            await self._safe_send_to(connection, raw, label=" runtime_model_updated ")

    async def send_turn_model_updated(
        self,
        chat_id: str,
        *,
        model_name: Any,
        provider_name: Any = None,
        is_fallback: Any = True,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """向当前会话订阅者发送本轮实际使用的 fallback 模型。"""
        if not isinstance(model_name, str) or not model_name.strip():
            return
        body: dict[str, Any] = {
            "event": "turn_model_updated",
            "chat_id": chat_id,
            "model_name": model_name.strip(),
            "is_fallback": is_fallback is not False,
        }
        if isinstance(provider_name, str) and provider_name.strip():
            body["provider"] = provider_name.strip()
        self._transcripts.prepare_event(
            chat_id,
            body,
            metadata=metadata,
            phase="activity",
        )
        raw = json.dumps(body, ensure_ascii=False)
        for connection in list(self._subs.get(chat_id, ())):
            await self._safe_send_to(connection, raw, label=" turn_model_updated ")
