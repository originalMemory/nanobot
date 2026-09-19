import json
from unittest.mock import patch

from nanobot.providers.tts import MiniMaxTTSProvider


async def test_minimax_streams_segments_in_order_and_skips_final_aggregate() -> None:
    chinese = b"\x01\x00\x02\x00"
    japanese = b"\x03\x00"
    requests: list[dict] = []

    def event(status: int, pcm: bytes) -> str:
        return "data: " + json.dumps({
            "data": {"status": status, "audio": pcm.hex()},
            "base_resp": {"status_code": 0},
        })

    class FakeResponse:
        status_code = 200

        def __init__(self, pcm: bytes) -> None:
            self.lines = [event(1, pcm), event(2, pcm)]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            for line in self.lines:
                yield line

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def stream(self, *_, **kwargs):
            requests.append(kwargs["json"])
            return FakeResponse(japanese if kwargs["json"]["language_boost"] == "Japanese" else chinese)

    provider = MiniMaxTTSProvider(
        api_key="sk-test",
        api_base="https://api.minimaxi.com",
        model="speech-2.8-hd",
        japanese_voice="scarlett",
        speed=1.0,
        extra_body={},
        rpm=20,
    )
    chunks = []

    async def collect(chunk):
        chunks.append(chunk)

    with patch("nanobot.providers.tts.httpx.AsyncClient", return_value=FakeClient()):
        result = await provider.synthesize_stream(
            "[zh]谢谢可以说[/zh][ja]ありがとうございます[/ja]",
            "genshin-candice",
            collect,
        )

    assert result is not None
    assert result.pcm_bytes == len(chinese) + len(japanese)
    assert [chunk.sequence for chunk in chunks] == [0, 1]
    assert [chunk.pcm for chunk in chunks] == [chinese, japanese]
    assert {request["voice_setting"]["voice_id"] for request in requests} == {
        "genshin-candice",
        "scarlett",
    }
    assert all(request["model"] == "speech-2.8-hd" for request in requests)
    assert all(request["audio_setting"]["format"] == "pcm" for request in requests)
