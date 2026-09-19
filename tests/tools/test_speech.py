import asyncio
import shutil
import subprocess
from unittest.mock import AsyncMock

import pytest

from nanobot.agent.speech import DEFERRED_SPEECH, SpeechService
from nanobot.agent.tools.context import RequestContext, request_context
from nanobot.agent.tools.tts import TtsTool
from nanobot.config.loader import save_config
from nanobot.config.schema import Config
from nanobot.providers.tts import TTSStreamChunk, TTSStreamResult
from nanobot.webui.settings_services import WebUISettingsConfig


def test_lover_speech_history_remains_replayable(tmp_path, monkeypatch):
    from nanobot.webui.transcript import (
        build_session_thread_response,
        replay_transcript_to_ui_messages,
    )
    media = tmp_path / "media"
    old_audio = media / "tts" / "speech_old.wav"
    old_audio.parent.mkdir(parents=True)
    old_audio.write_bytes(b"RIFF-test")
    monkeypatch.setattr("nanobot.webui.transcript.get_media_dir", lambda: media)
    speech = {"audioId": "old", "path": str(old_audio),
              "mimeType": "audio/wav", "sampleRate": 24000, "durationMs": 1000,
              "provider": "minimax", "model": "speech-2.8-turbo", "voice": "v", "controls": [],
              "url": "https://expired.invalid/do-not-use"}
    def sign(paths):
        assert paths == [str(old_audio.resolve())]
        return [{"url": "/media/fresh-signature"}]
    history = build_session_thread_response("websocket:desktop", [
        {"role": "user", "content": "hello"}, {"role": "assistant", "content": "reply", "speech": speech},
    ], augment_assistant_media=sign)
    assert history["messages"][-1]["speech"] == {"audioId": "old", "url": "/media/fresh-signature"}
    for audio_first in (True, False):
        answer = {"event": "message", "chat_id": "desktop", "turn_id": "old-turn", "text": "reply"}
        end = {"event": "assistant_audio_end", "chat_id": "desktop", "turn_id": "old-turn", "audio": speech}
        records = [end, answer] if audio_first else [answer, {"event": "turn_end", "turn_id": "old-turn"}, end]
        replay = replay_transcript_to_ui_messages(records, augment_assistant_media=sign)
        assert replay[-1]["speech"]["url"] == "/media/fresh-signature"
    old_audio.unlink()
    assert "speech" not in build_session_thread_response("websocket:desktop", [
        {"role": "assistant", "content": "reply", "speech": speech},
    ], augment_assistant_media=sign)["messages"][-1]



@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required for MP3 encoding")
async def test_speech_background_replay_failure_and_heartbeat_gate(tmp_path, monkeypatch):
    config = Config(tools={"tts": {"mode": "off", "preset": "minimax", "voice": "voice"}},
                    ttsPresets={"minimax": {"label": "MiniMax", "config": {"apiKey": "secret"},
                        "voices": [{"id": "voice", "label": "Voice", "languageVoices": {"default": "zh"}}]}})
    path = tmp_path / "config.json"
    save_config(config, path)
    service = SpeechService(WebUISettingsConfig(path))
    assert "secret" not in str(service.settings())
    tasks = []
    service.schedule = lambda coro: tasks.append(asyncio.create_task(coro))
    service.emit = AsyncMock()
    release = asyncio.Event()
    fail = False
    class Provider:
        def __init__(self, **kwargs): pass
        async def synthesize_stream(self, text, voice, on_chunk):
            await release.wait()
            await on_chunk(TTSStreamChunk(0, b"\x01\x00", 24000))
            return None if fail else TTSStreamResult(24000, 1, 2)
    monkeypatch.setattr("nanobot.agent.speech.MiniMaxTTSProvider", Provider)
    tool = TtsTool(service)
    with request_context(RequestContext(channel="websocket", chat_id="desktop", metadata={"webui_turn_id": "turn"})):
        assert "已触发" in await tool.execute("hello")
        await tool.execute("duplicate")
    assert len(tasks) == 1 and not tasks[0].done()
    release.set()
    await tasks[0]
    assert service.path("turn").suffix == ".mp3"
    assert service.path("turn").stat().st_size > 0
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(service.path("turn")), "-f", "null", "-"], check=True, capture_output=True)
    assert [call.args[1]["phase"] for call in service.emit.call_args_list] == ["start", "chunk", "end"]
    restarted = SpeechService(WebUISettingsConfig(path))
    assert restarted.path("turn").is_file()
    fail = True
    service.submit("desktop", "failed", "text")
    await tasks[-1]
    assert not service.path("failed").exists() and not list(service.directory.glob("*.tmp"))
    assert service.emit.call_args.args[1]["phase"] == "error"
    before = len(tasks)
    pending = []
    token = DEFERRED_SPEECH.set(pending)
    try:
        with request_context(RequestContext(channel="qq", chat_id="qq-group", session_key="heartbeat", turn_id="heartbeat-turn")):
            assert "获准" in await tool.execute("greeting")
        assert pending == ["greeting"] and len(tasks) == before
    finally:
        DEFERRED_SPEECH.reset(token)
    service.deliver = AsyncMock()
    fail = False
    with request_context(RequestContext(channel="qq", chat_id="qq-group", turn_id="qq-turn", metadata={"message_id": "source-msg"})):
        assert "已触发" in await tool.execute("QQ voice")
    await tasks[-1]
    delivery = service.deliver.call_args.args[0]
    assert delivery.channel == "qq" and delivery.chat_id == "qq-group"
    assert delivery.metadata["message_id"] == "source-msg"
    assert delivery.media == [str(service.path("qq-turn"))]
    assert service.emit.call_args.args[1]["turn_id"] != "qq-turn"
    assert "mode" not in service.settings()
    with pytest.raises(ValueError):
        service.update({"mode": "agent", "preset": "other", "voice": "voice"})


async def test_speech_routes_require_auth_and_socket_mutations(tmp_path):
    from types import SimpleNamespace

    from websockets.datastructures import Headers
    from websockets.http11 import Request

    from nanobot.bus.queue import MessageBus
    from nanobot.channels.websocket.runtime import WebSocketConfig
    from nanobot.webui.gateway_services import build_gateway_services

    services = build_gateway_services(
        config=WebSocketConfig(), bus=MessageBus(), session_manager=None,
        static_dist_path=None, workspace_path=tmp_path, default_restrict_to_workspace=False,
        config_path=tmp_path / "config.json", runtime_model_name=None,
        runtime_surface="browser", runtime_capabilities_overrides=None,
    )
    connection = SimpleNamespace(remote_address=("127.0.0.1", 10000))
    handler = services.http
    response = await handler.dispatch(connection, Request("/api/speech/settings", Headers()))
    assert response.status_code == 401
    response = await handler.dispatch(connection, Request("/api/speech/settings/update", Headers()))
    assert response.status_code == 405
    response = await handler.dispatch_webui_mutation(connection, "speech.settings", {"preset": "missing", "voice": "missing"})
    assert response.status_code == 400
    assert "mode" not in handler.speech.settings()


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required for MP3 encoding")
@pytest.mark.parametrize("audio_first", [True, False])
async def test_unified_history_keeps_speech_link_across_reload(tmp_path, monkeypatch, audio_first):
    from nanobot.agent.loop import AgentLoop
    from nanobot.agent.tools.registry import ToolRegistry
    from nanobot.bus.events import InboundMessage
    from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest
    from nanobot.webui.transcript import build_session_thread_response

    config = Config(agents={"defaults": {"workspace": str(tmp_path / "workspace"), "model": "test"}},
                    tools={"tts": {"preset": "minimax", "voice": "v"}},
                    ttsPresets={"minimax": {"label": "MiniMax", "config": {"apiKey": "test"},
                        "voices": [{"id": "v", "label": "Voice", "languageVoices": {"default": "zh"}}]}})
    path = tmp_path / "config.json"
    save_config(config, path)
    service = SpeechService(WebUISettingsConfig(path))
    release = asyncio.Event()
    tasks = []
    service.schedule = lambda coro: tasks.append(asyncio.create_task(coro))
    class AudioProvider:
        def __init__(self, **kwargs): pass
        async def synthesize_stream(self, text, voice, on_chunk):
            await release.wait()
            await on_chunk(TTSStreamChunk(0, b"\x01\x00" * 2400, 24000))
            return TTSStreamResult(24000, 1, 4800)
    monkeypatch.setattr("nanobot.agent.speech.MiniMaxTTSProvider", AudioProvider)
    class Provider(LLMProvider):
        def __init__(self):
            super().__init__(provider_name="test")
            self.calls = 0
        def get_default_model(self): return "test"
        async def chat(self, messages, **kwargs):
            self.calls += 1
            if self.calls == 1:
                return LLMResponse(content="", tool_calls=[ToolCallRequest(id="tts-1", name="tts", arguments={"text": "hello"})])
            if audio_first:
                release.set()
                await tasks[-1]
            return LLMResponse(content="hello")
    registry = ToolRegistry()
    registry.register(TtsTool(service))
    loop = AgentLoop.from_config(config, provider=Provider(), tool_registry=registry)
    service.sessions = loop.sessions
    monkeypatch.setattr("nanobot.webui.transcript.get_media_dir", lambda: tmp_path / "media")
    await loop._process_message(InboundMessage(channel="websocket", sender_id="user", chat_id="desktop",
        content="speak", metadata={"webui_turn_id": "saved-voice"}), session_key="unified:default")
    release.set()
    await tasks[-1]
    saved = loop.sessions.read_session_file("unified:default")["messages"]
    replay = build_session_thread_response("websocket:desktop", saved, augment_assistant_media=lambda paths: [{"url": "/media/current-signature"}])
    answer = next(m for m in replay["messages"] if m["role"] == "assistant" and m["content"] == "hello")
    assert answer.get("turnId") is None
    assert "speechTurnId" not in answer
    assert answer["speech"]["url"] == "/media/current-signature"
    restarted = SpeechService(WebUISettingsConfig(path))
    assert restarted.path("saved-voice").is_file()
    assert saved[-1]["speech"]["mimeType"] == "audio/mpeg"
    assert saved[-1]["speech"]["durationMs"] == 100
    assert saved[-1]["speech"]["audioId"] == answer["speech"]["audioId"]
    assert all("speech" not in m for m in loop.sessions.get_or_create("unified:default").get_history())
