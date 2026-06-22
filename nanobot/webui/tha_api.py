"""THA 桌面宠物 HTTP 与 WebSocket 辅助函数。"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

from websockets.exceptions import ConnectionClosed

from nanobot.config.loader import load_config, save_config
from nanobot.webui.tha_engine import (
    THA_MOTIONS,
    THAModelManager,
    THAPoseGenerator,
    get_engine,
)

THA_STATIC_DIR = Path(__file__).resolve().parents[1] / "web" / "tha"


class THAApiError(ValueError):
    """THA API 校验错误。"""

    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def tha_config_payload() -> dict[str, Any]:
    config = load_config().tha
    return {
        "enabledEmotions": config.enabled_emotions,
        "enabledMouthSync": config.enabled_mouth_sync,
        "windowWidth": config.window_width,
        "windowHeight": config.window_height,
        "audioDelayMs": config.audio_delay_ms,
    }


def tha_payload() -> dict[str, Any]:
    manager = THAModelManager()
    return {
        "config": tha_config_payload(),
        "model": manager.model_payload(),
        "motions": sorted(THA_MOTIONS),
        "emotions": ["happy", "angry", "sad", "neutral", "surprised", "relaxed"],
    }


def update_tha_config(query: dict[str, list[str]]) -> dict[str, Any]:
    config = load_config()
    tha = config.tha
    changed = False

    def first(*keys: str) -> str | None:
        for key in keys:
            values = query.get(key)
            if values:
                return values[0]
        return None

    def parse_bool(value: str, name: str) -> bool:
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        raise THAApiError(f"{name} must be a boolean")

    bool_fields = [
        ("enabledEmotions", "enabled_emotions"),
        ("enabledMouthSync", "enabled_mouth_sync"),
    ]
    for query_key, attr in bool_fields:
        value = first(query_key, attr)
        if value is not None:
            parsed = parse_bool(value, query_key)
            if getattr(tha, attr) != parsed:
                setattr(tha, attr, parsed)
                changed = True

    int_fields = [
        ("windowWidth", "window_width", 240, 2400),
        ("windowHeight", "window_height", 240, 2400),
        ("audioDelayMs", "audio_delay_ms", 0, 2000),
    ]
    for query_key, attr, min_value, max_value in int_fields:
        value = first(query_key, attr)
        if value is None:
            continue
        try:
            parsed = int(value)
        except ValueError:
            raise THAApiError(f"{query_key} must be an integer") from None
        if parsed < min_value or parsed > max_value:
            raise THAApiError(f"{query_key} is out of range")
        if getattr(tha, attr) != parsed:
            setattr(tha, attr, parsed)
            changed = True

    if changed:
        save_config(config)
    return tha_payload()


def tha_models_payload(kind: str) -> dict[str, Any]:
    if kind == "fixed":
        return {"success": True, "model": THAModelManager().model_payload()}
    raise THAApiError("unknown model list kind", status=404)


async def tha_websocket_loop(connection: Any) -> None:
    manager = THAModelManager()
    model_path = manager.model_path()
    if model_path is None:
        await connection.send(
            json.dumps(
                {
                    "type": "error",
                    "message": "THA model not found. Put model.onnx or model.mlpackage in tha_model.",
                },
                ensure_ascii=False,
            )
        )
        return

    generator = THAPoseGenerator()
    engine = get_engine(model_path)

    async def recv_loop() -> None:
        async for message in connection:
            if not isinstance(message, str):
                continue
            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                continue
            msg_type = payload.get("type")
            if msg_type == "emotion":
                generator.set_emotion(str(payload.get("emotion", "neutral")))
            elif msg_type == "motion":
                generator.set_motion(str(payload.get("motion", "")))
            elif msg_type == "motionClear":
                generator.clear_motion()
            elif msg_type == "mouth":
                generator.set_mouth(float(payload.get("amplitude", 0.0)))
            elif msg_type == "mouse":
                generator.set_mouse(float(payload.get("x", 0.0)), float(payload.get("y", 0.0)))
            elif msg_type == "ping":
                await connection.send(
                    json.dumps(
                        {
                            "type": "pong",
                            "sentAt": payload.get("sentAt"),
                            "serverAt": int(time.time() * 1000),
                        },
                        ensure_ascii=False,
                    )
                )

    async def render_loop() -> None:
        loop = asyncio.get_running_loop()
        frame_interval = 1.0 / 30.0
        while True:
            started = time.perf_counter()
            pose = generator.step()
            frame = await loop.run_in_executor(None, engine.render, pose)
            await connection.send(frame)
            elapsed = time.perf_counter() - started
            await asyncio.sleep(max(0.0, frame_interval - elapsed))

    recv_task = asyncio.create_task(recv_loop())
    render_task = asyncio.create_task(render_loop())
    try:
        done, pending = await asyncio.wait(
            {recv_task, render_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in done:
            task.result()
        for task in pending:
            task.cancel()
    except ConnectionClosed:
        return
    finally:
        recv_task.cancel()
        render_task.cancel()
