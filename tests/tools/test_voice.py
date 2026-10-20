import asyncio
import shutil
import subprocess
from unittest.mock import AsyncMock

import pytest

from nanobot.agent.voice import VoiceService
from nanobot.config.loader import save_config
from nanobot.config.schema import Config
from nanobot.providers.tts import TTSStreamChunk, TTSStreamResult
from nanobot.webui.settings_services import WebUISettingsConfig


def test_voice_selects_from_voices_array_and_switches(tmp_path):
    config = Config(tools={"tts": {
        "apiKey": "secret", "defaultVoice": "candice",
        "voices": [
            {"id": "candice", "label": "坎蒂丝", "languageVoices": {"default": "genshin-candice"}},
            {"id": "scarlett", "label": "斯嘉丽",
             "languageVoices": {"default": "scarlett-id", "ja": "scarlett-ja"}},
        ],
    }})
    path = tmp_path / "config.json"
    save_config(config, path)
    service = VoiceService(WebUISettingsConfig(path))
    payload = service.placeholder("turn-a")
    assert payload["voice"] == "genshin-candice"  # 默认选中 candice
    settings = service.settings()
    assert "api_key" not in settings and "apiKey" not in settings  # 密钥不暴露
    assert len(settings["voices"]) == 2 and settings["voices"][1]["id"] == "scarlett"
    # 切换音色到 scarlett（apiKey 缺省 → 继承已保存密钥）
    updated = service.update({"defaultVoice": "scarlett", "voices": settings["voices"]})
    payload2 = VoiceService(WebUISettingsConfig(path)).placeholder("turn-b")
    assert payload2["voice"] == "scarlett-id"  # 选中音色的 default 音色生效
    assert updated["defaultVoice"] == "scarlett"
    # 非法切换：default_voice 不在 voices 中 → 拒绝
    with pytest.raises(ValueError):
        service.update({"apiKey": "secret", "defaultVoice": "missing",
                        "voices": settings["voices"]})
    # 全新配置无 apiKey → 拒绝（首次配置必须提供密钥）
    with pytest.raises(ValueError):
        VoiceService(WebUISettingsConfig(tmp_path / "fresh.json")).update(
            {"defaultVoice": "scarlett", "voices": settings["voices"]})
    # voices/apiKey 缺省 → 继承已保存值
    inherited = service.update({"thresholdChars": 200})
    assert len(inherited["voices"]) == 2 and inherited["thresholdChars"] == 200


def test_voice_partial_update_preserves_provider_fields(tmp_path):
    config = Config(tools={"tts": {
        "apiKey": "secret", "apiBase": "https://tts.example/v1", "model": "custom-model",
        "speed": 1.3, "rpm": 7, "extraBody": {"emotion": True},
        "defaultVoice": "voice", "voices": [{"id": "voice", "label": "Voice"}],
    }})
    path = tmp_path / "config.json"
    save_config(config, path)
    service = VoiceService(WebUISettingsConfig(path))

    service.update({"thresholdChars": 200})
    saved = service.config.load().tools.tts
    assert saved.api_base == "https://tts.example/v1"
    assert saved.model == "custom-model"
    assert saved.speed == 1.3 and saved.rpm == 7
    assert saved.extra_body == {"emotion": True}


def test_lover_voice_history_remains_replayable(tmp_path, monkeypatch):
    from nanobot.webui.transcript import (
        build_session_thread_response,
        replay_transcript_to_ui_messages,
    )
    media = tmp_path / "media"
    old_audio = media / "tts" / "voice_old.wav"
    old_audio.parent.mkdir(parents=True)
    old_audio.write_bytes(b"RIFF-test")
    monkeypatch.setattr("nanobot.webui.transcript.get_media_dir", lambda: media)
    voice = {"audioId": "old", "path": str(old_audio),
              "mimeType": "audio/wav", "sampleRate": 24000, "durationMs": 1000,
              "provider": "minimax", "model": "speech-2.8-turbo", "voice": "v", "controls": [],
              "url": "https://expired.invalid/do-not-use"}
    def sign(paths):
        assert paths == [str(old_audio.resolve())]
        return [{"url": "/media/fresh-signature"}]
    history = build_session_thread_response("websocket:desktop", [
        {"role": "user", "content": "hello"}, {"role": "assistant", "content": "reply", "voice": voice},
    ], augment_assistant_media=sign)
    assert history["messages"][-1]["voice"] == {"audioId": "old", "url": "/media/fresh-signature"}
    for audio_first in (True, False):
        answer = {"event": "message", "chat_id": "desktop", "turn_id": "old-turn", "text": "reply"}
        end = {"event": "assistant_audio_end", "chat_id": "desktop", "turn_id": "old-turn", "audio": voice}
        records = [end, answer] if audio_first else [answer, {"event": "turn_end", "turn_id": "old-turn"}, end]
        replay = replay_transcript_to_ui_messages(records, augment_assistant_media=sign)
        assert replay[-1]["voice"]["url"] == "/media/fresh-signature"
    old_audio.unlink()
    assert "voice" not in build_session_thread_response("websocket:desktop", [
        {"role": "assistant", "content": "reply", "voice": voice},
    ], augment_assistant_media=sign)["messages"][-1]



@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required for MP3 encoding")
async def test_voice_background_replay_failure_and_heartbeat_gate(tmp_path, monkeypatch):
    config = Config(tools={"tts": {"apiKey": "secret", "defaultVoice": "voice"}})
    path = tmp_path / "config.json"
    save_config(config, path)
    service = VoiceService(WebUISettingsConfig(path))
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
    monkeypatch.setattr("nanobot.agent.voice.MiniMaxTTSProvider", Provider)
    service.submit("desktop", "turn", "hello")
    assert len(tasks) == 1 and not tasks[0].done()
    release.set()
    await tasks[0]
    assert service.path("turn").suffix == ".mp3"
    assert service.path("turn").stat().st_size > 0
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(service.path("turn")), "-f", "null", "-"], check=True, capture_output=True)
    assert [call.args[1]["phase"] for call in service.emit.call_args_list] == ["start", "chunk", "end"]
    restarted = VoiceService(WebUISettingsConfig(path))
    assert restarted.path("turn").is_file()
    fail = True
    service.submit("desktop", "failed", "text")
    await tasks[-1]
    assert not service.path("failed").exists() and not list(service.directory.glob("*.tmp"))
    assert service.emit.call_args.args[1]["phase"] == "error"
    service.deliver = AsyncMock()
    fail = False
    service.submit("qq-group", "qq-turn", "QQ voice", channel="qq",
                   session_key="unified:default", playback_chat_id="desktop",
                   metadata={"message_id": "source-msg"})
    await tasks[-1]
    delivery = service.deliver.call_args.args[0]
    assert delivery.channel == "qq" and delivery.chat_id == "qq-group"
    assert delivery.metadata["message_id"] == "source-msg"
    assert delivery.media == [str(service.path("qq-turn"))]
    assert service.emit.call_args.args[0] == "desktop"
    assert service.emit.call_args.args[1]["turn_id"] == "qq-turn"
    assert "mode" not in service.settings()
    # 旧 preset/voice 字段被忽略；部分更新走继承语义（apiKey/defaultVoice 保留）。
    updated = service.update({"thresholdChars": 250})
    assert updated["defaultVoice"] == "voice" and updated["thresholdChars"] == 250


async def test_voice_routes_require_auth_and_socket_mutations(tmp_path):
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
    response = await handler.dispatch(connection, Request("/api/voice/settings", Headers()))
    assert response.status_code == 401
    response = await handler.dispatch(connection, Request("/api/voice/settings/update", Headers()))
    assert response.status_code == 405
    response = await handler.dispatch_webui_mutation(connection, "voice.settings", {"preset": "missing", "voice": "missing"})
    assert response.status_code == 400
    assert "mode" not in handler.voice.settings()


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required for MP3 encoding")
@pytest.mark.parametrize("audio_first", [True, False])
async def test_unified_history_keeps_voice_link_across_reload(tmp_path, monkeypatch, audio_first):
    from nanobot.webui.transcript import build_session_thread_response

    config = Config(agents={"defaults": {"workspace": str(tmp_path / "workspace"), "model": "test"}},
                    tools={"tts": {"apiKey": "test", "defaultVoice": "v", "japaneseVoice": "ja-voice"}})
    path = tmp_path / "config.json"
    save_config(config, path)
    service = VoiceService(WebUISettingsConfig(path))
    release = asyncio.Event()
    tasks = []
    service.schedule = lambda coro: tasks.append(asyncio.create_task(coro))
    class AudioProvider:
        def __init__(self, **kwargs): pass
        async def synthesize_stream(self, text, voice, on_chunk):
            await release.wait()
            await on_chunk(TTSStreamChunk(0, b"\x01\x00" * 2400, 24000))
            return TTSStreamResult(24000, 1, 4800)
    monkeypatch.setattr("nanobot.agent.voice.MiniMaxTTSProvider", AudioProvider)
    monkeypatch.setattr("nanobot.webui.transcript.get_media_dir", lambda: tmp_path / "media")
    audio = service.submit("desktop", "saved-voice", "hello", channel="websocket")
    assert audio["audioId"] == service.path("saved-voice").stem
    release.set()
    await tasks[-1]
    saved = [{"role": "user", "content": "speak"},
             {"role": "assistant", "content": "hello", "voice": dict(audio)}]
    assert saved[-1]["voice"]["durationMs"] == 100
    replay = build_session_thread_response(
        "websocket:desktop", saved,
        augment_assistant_media=lambda paths: [{"url": "/media/current-signature"}],
    )
    answer = next(m for m in replay["messages"] if m["role"] == "assistant" and m["content"] == "hello")
    assert answer["voice"]["url"] == "/media/current-signature"
    restarted = VoiceService(WebUISettingsConfig(path))
    assert restarted.path("saved-voice").is_file()
    assert saved[-1]["voice"]["mimeType"] == "audio/mpeg"
    assert saved[-1]["voice"]["audioId"] == answer["voice"]["audioId"]
    assert audio["durationMs"] == 100
