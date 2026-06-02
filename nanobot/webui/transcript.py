"""Append-only WebUI display transcript (JSONL), separate from agent session."""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import unquote, urlparse

from loguru import logger

from nanobot.config.paths import get_webui_dir
from nanobot.session.manager import Session, SessionManager
from nanobot.utils.media_staging import is_remote_media_url

WEBUI_TRANSCRIPT_SCHEMA_VERSION = 3

_AUDIO_EXTS = {".mp3", ".wav", ".ogg", ".aac", ".m4a", ".weba", ".flac", ".opus"}
_VIDEO_EXTS = {".mp4", ".webm", ".avi", ".mov", ".mkv", ".ogv"}


def _infer_media_kind(url: str, name: str) -> str:
    """根据文件名或 URL 后缀推断媒体类型（image / video / audio）。"""
    for candidate in (name, url.split("?")[0]):
        dot = candidate.rfind(".")
        if dot >= 0:
            ext = candidate[dot:].lower()
            if ext in _AUDIO_EXTS:
                return "audio"
            if ext in _VIDEO_EXTS:
                return "video"
    return "image"
_MAX_TRANSCRIPT_FILE_BYTES = 8 * 1024 * 1024
_MARKDOWN_LOCAL_IMAGE_RE = re.compile(
    r"!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(\s+(?:\"[^\"]*\"|'[^']*'))?\)"
)
_INLINE_MARKDOWN_IMAGE_EXTS: frozenset[str] = frozenset({
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
})


def _remote_media_payloads(media: Any) -> list[dict[str, str]]:
    if not isinstance(media, list):
        return []
    out: list[dict[str, str]] = []
    for entry in media:
        if not isinstance(entry, str) or not is_remote_media_url(entry):
            continue
        parsed = urlparse(entry)
        name = Path(unquote(parsed.path)).name or "attachment"
        out.append({"url": entry, "name": name})
    return out


def _local_media_paths(media: Any) -> list[str]:
    if not isinstance(media, list):
        return []
    return [
        entry
        for entry in media
        if isinstance(entry, str) and entry and not is_remote_media_url(entry)
    ]


def rewrite_local_markdown_images(
    text: str,
    *,
    workspace_path: Path,
    sign_path: Callable[[Path], Mapping[str, Any] | None],
) -> str:
    """Rewrite markdown image paths inside the workspace to signed WebUI media URLs."""
    if "![" not in text:
        return text

    def resolve_url(raw_url: str) -> str | None:
        url = raw_url.strip()
        if url.startswith("<") and url.endswith(">"):
            url = url[1:-1].strip()
        if not url or url.startswith(("/api/media/", "#")):
            return None
        parsed = urlparse(url)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
            return None
        path_text = unquote(url)
        if Path(path_text).suffix.lower() not in _INLINE_MARKDOWN_IMAGE_EXTS:
            return None
        candidate = Path(path_text).expanduser()
        if not candidate.is_absolute():
            candidate = workspace_path / candidate
        try:
            resolved = candidate.resolve(strict=False)
            resolved.relative_to(workspace_path)
        except (OSError, ValueError):
            return None
        if not resolved.is_file():
            return None
        signed = sign_path(resolved)
        return str(signed.get("url")) if signed and signed.get("url") else None

    def replace(match: re.Match[str]) -> str:
        signed_url = resolve_url(match.group(2))
        if not signed_url:
            return match.group(0)
        title = match.group(3) or ""
        return f"![{match.group(1)}]({signed_url}{title})"

    return _MARKDOWN_LOCAL_IMAGE_RE.sub(replace, text)


def webui_transcript_path(session_key: str) -> Path:
    stem = SessionManager.safe_key(session_key)
    return get_webui_dir() / f"{stem}.jsonl"


def read_transcript_lines(session_key: str) -> list[dict[str, Any]]:
    path = webui_transcript_path(session_key)
    if not path.is_file():
        return []
    size = path.stat().st_size
    if size > _MAX_TRANSCRIPT_FILE_BYTES:
        logger.warning("webui transcript too large, skipping: {}", path)
        return []
    lines_out: list[dict[str, Any]] = []
    try:
        with open(path, encoding="utf-8") as f:
            for line_no, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    logger.warning("bad jsonl at {} line {}", path, line_no)
                    continue
                if isinstance(obj, dict):
                    lines_out.append(obj)
    except OSError as e:
        logger.warning("read transcript failed {}: {}", path, e)
        return []
    return lines_out


def append_transcript_object(session_key: str, obj: dict[str, Any]) -> None:
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    if len(raw.encode("utf-8")) > _MAX_TRANSCRIPT_FILE_BYTES:
        msg = "webui transcript line too large"
        raise ValueError(msg)
    path = webui_transcript_path(session_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = raw + "\n"
    with open(path, "a", encoding="utf-8") as f:
        f.write(line)
        f.flush()
        os.fsync(f.fileno())


def delete_webui_transcript(session_key: str) -> bool:
    path = webui_transcript_path(session_key)
    if not path.is_file():
        return False
    try:
        path.unlink()
        return True
    except OSError as e:
        logger.warning("Failed to delete webui transcript {}: {}", path, e)
        return False


def _format_tool_call_trace(call: Any) -> str | None:
    if not call or not isinstance(call, dict):
        return None
    fn = call.get("function")
    name = fn.get("name") if isinstance(fn, dict) else None
    if not isinstance(name, str) or not name:
        raw_name = call.get("name")
        name = raw_name if isinstance(raw_name, str) else ""
    if not name:
        return None
    args = (fn.get("arguments") if isinstance(fn, dict) else None) or call.get("arguments")
    if isinstance(args, str) and args.strip():
        return f"{name}({args})"
    if args and isinstance(args, dict):
        return f"{name}({json.dumps(args, ensure_ascii=False)})"
    return f"{name}()"


def tool_trace_lines_from_events(events: Any) -> list[str]:
    if not isinstance(events, list):
        return []
    lines: list[str] = []
    seen: set[str] = set()
    for event in events:
        if not event or not isinstance(event, dict):
            continue
        if event.get("phase") not in {"start", "end", "error"}:
            continue
        call_id = event.get("call_id")
        if isinstance(call_id, str) and call_id:
            if call_id in seen:
                continue
            seen.add(call_id)
        t = _format_tool_call_trace(event)
        if t:
            lines.append(t)
    return lines


_PHASE_RANK = {"start": 1, "end": 2, "error": 3}


def _normalize_tool_events(events: Any) -> list[dict[str, Any]]:
    if not isinstance(events, list):
        return []
    out: list[dict[str, Any]] = []
    for event in events:
        if not event or not isinstance(event, dict):
            continue
        if event.get("phase") not in {"start", "end", "error"}:
            continue
        if not isinstance(event.get("name"), str):
            fn = event.get("function")
            if not (isinstance(fn, dict) and isinstance(fn.get("name"), str)):
                continue
        out.append(dict(event))
    return out


def _tool_event_key(event: dict[str, Any]) -> str:
    call_id = event.get("call_id")
    if isinstance(call_id, str) and call_id:
        return f"call:{call_id}"
    return _format_tool_call_trace(event) or json.dumps(event, sort_keys=True, ensure_ascii=False)


def _merge_tool_events(previous: Any, incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(previous, list) or not previous:
        return incoming
    if not incoming:
        return [dict(event) for event in previous if isinstance(event, dict)]
    merged = [dict(event) for event in previous if isinstance(event, dict)]
    index_by_key = {_tool_event_key(event): idx for idx, event in enumerate(merged)}
    for event in incoming:
        key = _tool_event_key(event)
        existing_index = index_by_key.get(key)
        if existing_index is None:
            index_by_key[key] = len(merged)
            merged.append(event)
            continue
        existing = merged[existing_index]
        incoming_rank = _PHASE_RANK.get(str(event.get("phase")), 0)
        existing_rank = _PHASE_RANK.get(str(existing.get("phase")), 0)
        if incoming_rank >= existing_rank:
            merged[existing_index] = {**existing, **event}
    return merged


def _merge_unique_tool_trace_lines(
    previous_traces: list[str],
    lines: list[str],
) -> tuple[list[str], bool]:
    seen_lines = set(previous_traces)
    traces = list(previous_traces)
    added = False
    for line in lines:
        if line in seen_lines:
            continue
        seen_lines.add(line)
        traces.append(line)
        added = True
    return traces, added


def replay_transcript_to_ui_messages(
    lines: list[dict[str, Any]],
    *,
    augment_media_paths: Callable[[list[str]], list[dict[str, Any]]] | None = None,
    augment_assistant_text: Callable[[str], str] | None = None,
) -> list[dict[str, Any]]:
    """Fold JSONL records into ``UIMessage``-shaped dicts for the WebUI.

    Mirrors the core fold in ``useNanobotStream.ts`` (delta, reasoning,
    message+kind, turn_end). ``augment_media_paths`` maps persisted filesystem
    paths to ``{url, name?}`` / attachment dicts the client expects.
    """
    messages: list[dict[str, Any]] = []
    buffer_message_id: str | None = None
    buffer_parts: list[str] = []
    suppress_until_turn_end = False
    active_activity_segment_id: str | None = None
    active_file_edit_segment_id: str | None = None
    activity_segment_counter = 0
    _ts_base = int(time.time() * 1000)

    def _new_id(prefix: str, idx: int) -> str:
        return f"{prefix}-{idx}-{uuid.uuid4().hex[:8]}"

    def _new_activity_segment(*, activate: bool = True) -> str:
        nonlocal active_activity_segment_id, activity_segment_counter
        activity_segment_counter += 1
        segment_id = f"activity-{activity_segment_counter}"
        if activate:
            active_activity_segment_id = segment_id
        return segment_id

    def _ensure_activity_segment() -> str:
        return active_activity_segment_id or _new_activity_segment()

    def close_activity_for_answer() -> None:
        nonlocal active_activity_segment_id, active_file_edit_segment_id
        active_activity_segment_id = None
        active_file_edit_segment_id = None

    def close_file_edit_phase_before_activity() -> None:
        nonlocal active_activity_segment_id, active_file_edit_segment_id
        if active_file_edit_segment_id:
            active_activity_segment_id = None
            active_file_edit_segment_id = None

    def attach_reasoning_chunk(prev: list[dict[str, Any]], chunk: str, idx: int) -> None:
        for i in range(len(prev) - 1, -1, -1):
            candidate = prev[i]
            if candidate.get("role") == "user":
                break
            if candidate.get("kind") == "trace":
                break
            if candidate.get("role") != "assistant":
                continue
            content = str(candidate.get("content") or "")
            has_answer = len(content) > 0
            if (
                candidate.get("reasoningStreaming")
                or candidate.get("reasoning") is not None
                or has_answer
                or candidate.get("isStreaming")
            ):
                prev[i] = {
                    **candidate,
                    "reasoning": (str(candidate.get("reasoning") or "")) + chunk,
                    "reasoningStreaming": True,
                    "activitySegmentId": candidate.get("activitySegmentId") or _ensure_activity_segment(),
                }
                return
            if not has_answer and candidate.get("isStreaming"):
                prev[i] = {
                    **candidate,
                    "reasoning": chunk,
                    "reasoningStreaming": True,
                    "activitySegmentId": candidate.get("activitySegmentId") or _ensure_activity_segment(),
                }
                return
            break
        segment = _ensure_activity_segment()
        prev.append(
            {
                "id": _new_id("as", idx),
                "role": "assistant",
                "content": "",
                "isStreaming": True,
                "reasoning": chunk,
                "reasoningStreaming": True,
                "activitySegmentId": segment,
                "createdAt": _ts_base + idx,
            },
        )

    def find_active_placeholder(prev: list[dict[str, Any]]) -> str | None:
        last = prev[-1] if prev else None
        if not last:
            return None
        if last.get("role") != "assistant" or last.get("kind") == "trace":
            return None
        if str(last.get("content") or ""):
            return None
        if not last.get("isStreaming"):
            return None
        return str(last.get("id"))

    def close_reasoning(prev: list[dict[str, Any]]) -> None:
        for i in range(len(prev) - 1, -1, -1):
            if prev[i].get("reasoningStreaming"):
                prev[i] = {**prev[i], "reasoningStreaming": False}
                return

    def is_reasoning_only_placeholder(m: dict[str, Any]) -> bool:
        return (
            m.get("role") == "assistant"
            and m.get("kind") != "trace"
            and not str(m.get("content") or "").strip()
            and bool(m.get("reasoning"))
            and not m.get("reasoningStreaming")
            and not m.get("media")
        )

    def is_tool_trace_at(index: int) -> bool:
        m = messages[index] if 0 <= index < len(messages) else None
        return bool(m and m.get("kind") == "trace")

    def is_assistant_answer(m: dict[str, Any]) -> bool:
        return (
            m.get("role") == "assistant"
            and m.get("kind") != "trace"
            and (bool(str(m.get("content") or "").strip()) or bool(m.get("media")))
        )

    def prune_reasoning_only() -> None:
        nonlocal messages
        kept: list[dict[str, Any]] = []
        for i, m in enumerate(messages):
            if is_reasoning_only_placeholder(m) and not is_tool_trace_at(i + 1):
                continue
            # Prune cleared placeholders (reasoning was moved to the answer message).
            if (
                m.get("role") == "assistant"
                and m.get("kind") != "trace"
                and not str(m.get("content") or "").strip()
                and not m.get("reasoning")
                and not m.get("reasoningStreaming")
                and not m.get("isStreaming")
                and not m.get("media")
            ):
                continue
            kept.append(m)
        messages = kept

    def stamp_latency(latency_ms: int) -> None:
        for i in range(len(messages) - 1, -1, -1):
            if is_assistant_answer(messages[i]):
                messages[i] = {
                    **messages[i],
                    "latencyMs": latency_ms,
                    "isStreaming": False,
                }
                return

    def stamp_usage(usage: dict[str, Any]) -> None:
        for i in range(len(messages) - 1, -1, -1):
            if is_assistant_answer(messages[i]):
                messages[i] = {**messages[i], "usage": usage}
                return

    def absorb_complete(extra: dict[str, Any], idx: int) -> None:
        nonlocal active_activity_segment_id, active_file_edit_segment_id
        last = messages[-1] if messages else None
        if last and is_reasoning_only_placeholder(last):
            messages[-1] = {
                **last,
                **extra,
                "isStreaming": False,
                "reasoningStreaming": False,
            }
        else:
            # Look back through this turn for a reasoning-only placeholder.
            # When tool calls sit between reasoning and the answer, we copy the
            # reasoning onto the answer so it renders inside the bubble, and
            # clear the placeholder so it gets pruned later.
            inline_reasoning: str | None = None
            reasoning_idx: int | None = None
            for i in range(len(messages) - 1, -1, -1):
                m = messages[i]
                if m.get("role") == "user":
                    break
                if is_reasoning_only_placeholder(m):
                    inline_reasoning = str(m.get("reasoning") or "") or None
                    reasoning_idx = i
                    break
            new_msg: dict[str, Any] = {
                "id": _new_id("as", idx),
                "role": "assistant",
                "createdAt": _ts_base + idx,
                **extra,
            }
            if inline_reasoning:
                new_msg["reasoning"] = inline_reasoning
                messages[reasoning_idx] = {**messages[reasoning_idx], "reasoning": None}
            messages.append(new_msg)
        active_activity_segment_id = None
        active_file_edit_segment_id = None

    def _file_edit_key(edit: dict[str, Any]) -> str:
        call_id = str(edit.get("call_id") or "")
        tool = str(edit.get("tool") or "")
        if call_id:
            return f"{call_id}|{tool}"
        return f"{tool}|{edit.get('path') or ''}"

    def find_file_edit_trace_index(
        segment: str | None,
        edits: list[dict[str, Any]],
    ) -> int | None:
        incoming_keys = {_file_edit_key(edit) for edit in edits if isinstance(edit, dict)}
        for i in range(len(messages) - 1, -1, -1):
            candidate = messages[i]
            if candidate.get("role") == "user":
                break
            if candidate.get("kind") != "trace" or not candidate.get("fileEdits"):
                continue
            if segment and candidate.get("activitySegmentId") == segment:
                return i
            existing_edits = candidate.get("fileEdits")
            if not isinstance(existing_edits, list):
                continue
            for existing in existing_edits:
                if isinstance(existing, dict) and _file_edit_key(existing) in incoming_keys:
                    return i
        return None

    def upsert_file_edits(edits: list[dict[str, Any]], idx: int) -> None:
        nonlocal active_file_edit_segment_id
        if not edits:
            return
        segment = active_file_edit_segment_id
        target_index = find_file_edit_trace_index(segment, edits)
        if target_index is not None:
            last = messages[target_index]
            segment = str(last.get("activitySegmentId") or segment or _new_activity_segment(activate=False))
            active_file_edit_segment_id = segment
        else:
            if not segment:
                segment = _new_activity_segment(activate=False)
            active_file_edit_segment_id = segment
            messages.append(
                {
                    "id": _new_id("tr", idx),
                    "role": "tool",
                    "kind": "trace",
                    "content": "",
                    "traces": [],
                    "fileEdits": [],
                    "activitySegmentId": segment,
                    "createdAt": _ts_base + idx,
                },
            )
            target_index = len(messages) - 1
            last = messages[target_index]
        if not segment:
            segment = _new_activity_segment(activate=False)
            active_file_edit_segment_id = segment
        existing = list(last.get("fileEdits") or [])
        index_by_key = {
            _file_edit_key(edit): pos
            for pos, edit in enumerate(existing)
            if isinstance(edit, dict)
        }
        for edit in edits:
            if not isinstance(edit, dict):
                continue
            key = _file_edit_key(edit)
            if key in index_by_key:
                pos = index_by_key[key]
                merged = {**existing[pos], **edit}
                if edit.get("path") and not edit.get("pending"):
                    merged.pop("pending", None)
                existing[pos] = merged
            else:
                index_by_key[key] = len(existing)
                existing.append(dict(edit))
        messages[target_index] = {
            **last,
            "fileEdits": existing,
            "activitySegmentId": last.get("activitySegmentId") or segment,
        }

    for idx, rec in enumerate(lines):
        ev = rec.get("event")
        if ev == "user":
            suppress_until_turn_end = False
            buffer_message_id = None
            buffer_parts = []
            active_activity_segment_id = None
            active_file_edit_segment_id = None
            text = rec.get("text")
            text_s = text if isinstance(text, str) else ""
            media_paths = rec.get("media_paths")
            paths: list[str] = []
            if isinstance(media_paths, list):
                paths = [str(p) for p in media_paths if p]
            media_att: list[dict[str, Any]] = []
            media_urls = rec.get("media_urls")
            if isinstance(media_urls, list):
                for m in media_urls:
                    if isinstance(m, dict) and m.get("url"):
                        _url = str(m["url"])
                        _name = str(m.get("name") or "")
                        media_att.append(
                            {
                                "kind": _infer_media_kind(_url, _name),
                                "url": _url,
                                "name": _name,
                            },
                        )
            if paths and augment_media_paths is not None:
                media_att.extend(augment_media_paths(paths))
            row: dict[str, Any] = {
                "id": _new_id("u", idx),
                "role": "user",
                "content": text_s,
                "createdAt": _ts_base + idx,
            }
            if media_att:
                row["media"] = media_att
                if all(m.get("kind") == "image" for m in media_att):
                    row["images"] = [{"url": m.get("url"), "name": m.get("name")} for m in media_att]
            cli_apps = rec.get("cli_apps")
            if isinstance(cli_apps, list) and cli_apps:
                row["cliApps"] = [dict(app) for app in cli_apps if isinstance(app, dict)]
            mcp_presets = rec.get("mcp_presets")
            if isinstance(mcp_presets, list) and mcp_presets:
                row["mcpPresets"] = [
                    dict(preset) for preset in mcp_presets if isinstance(preset, dict)
                ]
            sc = rec.get("source_channel")
            if isinstance(sc, str) and sc:
                row["sourceChannel"] = sc
            if rec.get("channel_delivery"):
                row["channelDelivery"] = True
            if rec.get("user_initiated_delivery"):
                row["userInitiatedDelivery"] = True
            messages.append(row)
            continue

        if ev == "file_edit":
            raw_edits = rec.get("edits")
            if isinstance(raw_edits, list):
                upsert_file_edits([e for e in raw_edits if isinstance(e, dict)], idx)
            continue

        if ev == "delta":
            if suppress_until_turn_end:
                continue
            chunk = rec.get("text")
            if not isinstance(chunk, str):
                continue
            close_activity_for_answer()
            adopted = find_active_placeholder(messages) if buffer_message_id is None else None
            if buffer_message_id is None:
                if adopted:
                    buffer_message_id = adopted
                else:
                    buffer_message_id = _new_id("buf", idx)
                    messages.append(
                        {
                            "id": buffer_message_id,
                            "role": "assistant",
                            "content": "",
                            "isStreaming": True,
                            "createdAt": _ts_base + idx,
                        },
                    )
            buffer_parts.append(chunk)
            combined = "".join(buffer_parts)
            for i, m in enumerate(messages):
                if m.get("id") == buffer_message_id:
                    messages[i] = {**m, "content": combined, "isStreaming": True}
                    break
            continue

        if ev == "stream_end":
            if suppress_until_turn_end:
                buffer_message_id = None
                buffer_parts = []
                continue
            final_text = rec.get("text")
            if isinstance(final_text, str):
                if buffer_message_id is None:
                    buffer_message_id = _new_id("buf", idx)
                    messages.append(
                        {
                            "id": buffer_message_id,
                            "role": "assistant",
                            "content": final_text,
                            "isStreaming": True,
                            "createdAt": _ts_base + idx,
                        },
                    )
                else:
                    for i, m in enumerate(messages):
                        if m.get("id") == buffer_message_id:
                            messages[i] = {**m, "content": final_text, "isStreaming": True}
                            break
            buffer_message_id = None
            buffer_parts = []
            continue

        if ev == "reasoning_delta":
            if suppress_until_turn_end:
                continue
            chunk = rec.get("text")
            if not isinstance(chunk, str) or not chunk:
                continue
            close_file_edit_phase_before_activity()
            attach_reasoning_chunk(messages, chunk, idx)
            continue

        if ev == "reasoning_end":
            if suppress_until_turn_end:
                continue
            close_reasoning(messages)
            continue

        if ev == "message":
            if suppress_until_turn_end and rec.get("kind") in (
                "tool_hint",
                "progress",
                "reasoning",
            ):
                continue
            kind = rec.get("kind")
            if kind == "reasoning":
                line = rec.get("text")
                if not isinstance(line, str) or not line:
                    continue
                close_file_edit_phase_before_activity()
                attach_reasoning_chunk(messages, line, idx)
                close_reasoning(messages)
                continue
            if kind in ("tool_hint", "progress"):
                structured_events = _normalize_tool_events(rec.get("tool_events"))
                structured = tool_trace_lines_from_events(rec.get("tool_events"))
                text = rec.get("text")
                trace_lines = structured if structured else ([text] if isinstance(text, str) and text else [])
                if not trace_lines:
                    continue
                segment = _ensure_activity_segment()
                last = messages[-1] if messages else None
                if (
                    last
                    and last.get("kind") == "trace"
                    and not last.get("isStreaming")
                    and (last.get("activitySegmentId") in (None, segment))
                ):
                    prev_traces = list(last.get("traces") or [last.get("content")])
                    if structured:
                        merged_traces, added = _merge_unique_tool_trace_lines(prev_traces, structured)
                        if not added and not structured_events:
                            continue
                    else:
                        merged_traces = prev_traces + trace_lines
                    merged = {
                        **last,
                        "traces": merged_traces,
                        "content": merged_traces[-1],
                        "toolEvents": _merge_tool_events(last.get("toolEvents"), structured_events)
                        if structured_events
                        else last.get("toolEvents"),
                        "activitySegmentId": last.get("activitySegmentId") or segment,
                    }
                    messages[-1] = merged
                else:
                    messages.append(
                        {
                            "id": _new_id("tr", idx),
                            "role": "tool",
                            "kind": "trace",
                            "content": trace_lines[-1],
                            "traces": trace_lines,
                            **({"toolEvents": structured_events} if structured_events else {}),
                            "activitySegmentId": segment,
                            "createdAt": _ts_base + idx,
                        },
                    )
                continue

            buffer_message_id = None
            buffer_parts = []
            text = rec.get("text")
            content_s = text if isinstance(text, str) else ""
            media_urls = rec.get("media_urls")
            media: list[dict[str, Any]] = []
            if isinstance(media_urls, list):
                for m in media_urls:
                    if isinstance(m, dict) and m.get("url"):
                        _url = str(m["url"])
                        _name = str(m.get("name") or "")
                        media.append(
                            {
                                "kind": _infer_media_kind(_url, _name),
                                "url": _url,
                                "name": _name,
                            },
                        )
            media_paths = rec.get("media_paths")
            if isinstance(media_paths, list) and media_paths and augment_media_paths is not None:
                paths = [str(p) for p in media_paths if p]
                if paths:
                    media_att = augment_media_paths(paths)
                    if media_att:
                        media.extend(media_att)
            extra: dict[str, Any] = {"content": content_s}
            if media:
                extra["media"] = media
            lat = rec.get("latency_ms")
            if isinstance(lat, (int, float)) and lat >= 0:
                extra["latencyMs"] = int(lat)
            usg = rec.get("usage")
            if isinstance(usg, dict) and usg:
                extra["usage"] = usg
            ts_str = rec.get("ts")
            if isinstance(ts_str, str):
                extra["messageTs"] = ts_str
            sc = rec.get("source_channel")
            if isinstance(sc, str) and sc:
                extra["sourceChannel"] = sc
            if rec.get("channel_delivery"):
                extra["channelDelivery"] = True
            if rec.get("user_initiated_delivery"):
                extra["userInitiatedDelivery"] = True
            absorb_complete(extra, idx)
            if media and not rec.get("channel_delivery"):
                suppress_until_turn_end = True
            continue

        if ev == "turn_end":
            suppress_until_turn_end = False
            active_activity_segment_id = None
            active_file_edit_segment_id = None
            for i, m in enumerate(messages):
                if m.get("isStreaming"):
                    messages[i] = {**m, "isStreaming": False}
            prune_reasoning_only()
            lat = rec.get("latency_ms")
            if isinstance(lat, (int, float)) and lat >= 0:
                stamp_latency(int(lat))
            usg = rec.get("usage")
            if isinstance(usg, dict) and usg:
                stamp_usage(usg)
            buffer_message_id = None
            buffer_parts = []
            continue

    for i, m in enumerate(messages):
        if (
            augment_assistant_text is not None
            and m.get("role") == "assistant"
            and m.get("kind") != "trace"
            and isinstance(m.get("content"), str)
        ):
            messages[i] = {**m, "content": augment_assistant_text(m["content"])}
        m.pop("isStreaming", None)
        m.pop("reasoningStreaming", None)
    return messages


def build_webui_thread_response(
    session_key: str,
    *,
    augment_media_paths: Callable[[list[str]], list[dict[str, Any]]] | None = None,
    augment_assistant_text: Callable[[str], str] | None = None,
) -> dict[str, Any] | None:
    """Return a payload compatible with ``WebuiThreadPersistedPayload``."""
    lines = read_transcript_lines(session_key)
    if not lines:
        return None
    msgs = replay_transcript_to_ui_messages(
        lines,
        augment_media_paths=augment_media_paths,
        augment_assistant_text=augment_assistant_text,
    )
    return {
        "schemaVersion": WEBUI_TRANSCRIPT_SCHEMA_VERSION,
        "sessionKey": session_key,
        "messages": msgs,
    }


def session_messages_to_wire_events(
    messages: list[dict[str, Any]],
    chat_id: str = "inbox:unified",
) -> list[dict[str, Any]]:
    """将 OpenAI 格式的 Session 消息转换为 ``replay_transcript_to_ui_messages`` 所需的 wire events。

    处理 user、assistant（纯文本 + tool_calls）和 tool result 消息，
    保留 ``source_channel`` 和 ``source_chat_id`` 字段。

    Tool call 策略：assistant 的 tool_calls 按 call_id 缓冲；等到对应的 tool result
    到达时，才生成一条合并的 ``phase: "end"`` 事件（与 wire 日志格式一致），避免
    同时发 start/end 两条事件导致 UI 出现重复 trace 行。
    """
    events: list[dict[str, Any]] = []
    # call_id → {name, arguments}：从 assistant tool_calls 填充，
    # 收到匹配的 tool result 时消费。
    pending_tool_calls: dict[str, dict[str, Any]] = {}
    pending_user_delivery_events: list[dict[str, Any]] = []

    def flush_user_delivery_events() -> None:
        if not pending_user_delivery_events:
            return
        events.extend(pending_user_delivery_events)
        pending_user_delivery_events.clear()

    def flush_next_user_delivery_event(tool_ev: dict[str, Any]) -> None:
        if not pending_user_delivery_events:
            return
        match_index = 0
        args = tool_ev.get("arguments")
        if isinstance(args, dict):
            for i, ev in enumerate(pending_user_delivery_events):
                if (
                    (not args.get("channel") or ev.get("source_channel") == args.get("channel"))
                    and (not args.get("chat_id") or ev.get("source_chat_id") == args.get("chat_id"))
                    and (
                        not isinstance(args.get("content"), str)
                        or ev.get("text") == args.get("content")
                    )
                ):
                    match_index = i
                    break
        events.append(pending_user_delivery_events.pop(match_index))

    for msg in messages:
        if msg.get("_type") == "metadata":
            continue
        role = msg.get("role")
        content = msg.get("content", "")
        if isinstance(content, list):
            text_parts = [
                b.get("text", "") for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            ]
            content = "\n".join(text_parts)
        if not isinstance(content, str):
            content = str(content) if content else ""

        base: dict[str, Any] = {"chat_id": chat_id}
        sc = msg.get("source_channel")
        if sc:
            base["source_channel"] = sc
        scid = msg.get("source_chat_id")
        if scid:
            base["source_chat_id"] = scid

        if role == "user":
            flush_user_delivery_events()
            ev: dict[str, Any] = {**base, "event": "user", "text": content}
            media = msg.get("media")
            local_paths = _local_media_paths(media)
            if local_paths:
                ev["media_paths"] = local_paths
            remote_urls = _remote_media_payloads(media)
            if remote_urls:
                ev["media_urls"] = remote_urls
            events.append(ev)

        elif role == "assistant":
            tool_calls = msg.get("tool_calls")
            ts = msg.get("timestamp")
            media = msg.get("media")
            local_paths = _local_media_paths(media)
            remote_urls = _remote_media_payloads(media)
            reasoning = msg.get("reasoning_content") or msg.get("reasoning")
            if isinstance(reasoning, str) and reasoning:
                reasoning_ev: dict[str, Any] = {
                    **base,
                    "event": "message",
                    "kind": "reasoning",
                    "text": reasoning,
                }
                if isinstance(ts, str):
                    reasoning_ev["ts"] = ts
                events.append(reasoning_ev)
            # 若 content 和 tool_calls 同时存在（如 DeepSeek 在调工具时附带旁白），
            # 先单独发一条 message 事件，与直播流行为保持一致。
            if content and tool_calls and isinstance(tool_calls, list):
                inline: dict[str, Any] = {**base, "event": "message", "text": content}
                if isinstance(ts, str):
                    inline["ts"] = ts
                events.append(inline)
            if tool_calls and isinstance(tool_calls, list):
                # 缓冲 tool calls，等 tool result 到达时生成合并的 end 事件，
                # 与 wire 日志的单事件格式保持一致。
                for tc in tool_calls:
                    if not isinstance(tc, dict):
                        continue
                    call_id = tc.get("id", "")
                    fn = tc.get("function") or {}
                    pending_tool_calls[call_id] = {
                        "name": fn.get("name", ""),
                        "arguments": _safe_parse_args(fn.get("arguments", "")),
                    }
            elif content or local_paths or remote_urls:
                ev = {**base, "event": "message", "text": content}
                lat = msg.get("latency_ms")
                if isinstance(lat, (int, float)):
                    ev["latency_ms"] = int(lat)
                usg = msg.get("usage")
                if isinstance(usg, dict) and usg:
                    ev["usage"] = usg
                if isinstance(ts, str):
                    ev["ts"] = ts
                if msg.get("_channel_delivery"):
                    ev["channel_delivery"] = True
                if msg.get("_user_initiated_channel_delivery"):
                    ev["user_initiated_delivery"] = True
                if local_paths:
                    ev["media_paths"] = local_paths
                if remote_urls:
                    ev["media_urls"] = remote_urls
                if ev.get("channel_delivery") and ev.get("user_initiated_delivery"):
                    pending_user_delivery_events.append(ev)
                    continue
                events.append(ev)

        elif role == "tool":
            call_id = msg.get("tool_call_id", "")
            pending = pending_tool_calls.pop(call_id, {})
            name = pending.get("name") or msg.get("name", "")
            tool_ev: dict[str, Any] = {
                "version": 1,
                "phase": "end",
                "call_id": call_id,
                "name": name,
                "result": content or "",
            }
            # 带上 arguments，使 _format_tool_call_trace 在 start/end 两阶段
            # 生成相同文本，避免 UI 出现重复 trace 行。
            if pending.get("arguments") is not None:
                tool_ev["arguments"] = pending["arguments"]
            events.append({
                **base,
                "event": "message",
                "text": "",
                "kind": "tool_hint",
                "tool_events": [tool_ev],
            })
            if name == "message":
                flush_next_user_delivery_event(tool_ev)

    flush_user_delivery_events()
    if events:
        events.append({"event": "turn_end", "chat_id": chat_id})

    return events


def _safe_parse_args(raw: Any) -> Any:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return raw
    return raw


def build_inbox_thread_from_session(
    session: Session,
    *,
    augment_media_paths: Callable[[list[str]], list[dict[str, Any]]] | None = None,
    augment_assistant_text: Callable[[str], str] | None = None,
) -> dict[str, Any]:
    """直接从 Session 对象构建 inbox thread 响应。

    将 OpenAI 格式的 Session 消息转换为 wire events → UI 消息，
    完全绕过独立的 unified transcript 文件。
    """
    wire_events = session_messages_to_wire_events(session.messages)
    if not wire_events:
        return {
            "schemaVersion": WEBUI_TRANSCRIPT_SCHEMA_VERSION,
            "sessionKey": session.key,
            "messages": [],
        }
    msgs = replay_transcript_to_ui_messages(
        wire_events,
        augment_media_paths=augment_media_paths,
        augment_assistant_text=augment_assistant_text,
    )
    return {
        "schemaVersion": WEBUI_TRANSCRIPT_SCHEMA_VERSION,
        "sessionKey": session.key,
        "messages": msgs,
    }
