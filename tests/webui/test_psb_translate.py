from __future__ import annotations

import pytest

from nanobot.webui.psb_translate import (
    parse_translation_mapping,
    translate_psb_labels,
)


def test_parse_translation_mapping_extracts_json_object() -> None:
    content = '说明\n{"待機": "待机", "おさんぽ": "散步"}\n'
    assert parse_translation_mapping(content) == {"待機": "待机", "おさんぽ": "散步"}


@pytest.mark.asyncio
async def test_translate_psb_labels_uses_provider_snapshot_retry_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeProvider:
        async def chat_with_retry(self, **kwargs):  # noqa: ANN003
            captured.update(kwargs)
            return type(
                "Resp",
                (),
                {
                    "content": '{"待機": "待机"}',
                    "reasoning_content": None,
                    "finish_reason": "stop",
                },
            )()

    fake_snapshot = type("Snapshot", (), {"provider": FakeProvider(), "model": "deepseek-v4-flash"})()
    monkeypatch.setattr(
        "nanobot.config.loader.load_config",
        lambda: type("Cfg", (), {"agents": type("A", (), {"defaults": type("D", (), {"model": "deepseek-v4-flash"})()})()})(),
    )
    monkeypatch.setattr("nanobot.providers.factory.build_provider_snapshot", lambda _cfg: fake_snapshot)

    mapping, status = await translate_psb_labels(["待機"])
    assert status == "done"
    assert mapping == {"待機": "待机"}
    assert captured["model"] == "deepseek-v4-flash"
    assert captured["reasoning_effort"] == "none"
    messages = captured["messages"]
    assert isinstance(messages, list)
    assert [message["role"] for message in messages] == ["system", "user"]
    assert "只返回 JSON 对象" in messages[0]["content"]
    assert '["待機"]' in messages[1]["content"]


@pytest.mark.asyncio
async def test_translate_psb_labels_fails_when_content_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    class EmptyProvider:
        async def chat_with_retry(self, **kwargs):  # noqa: ANN003
            return type(
                "Resp",
                (),
                {
                    "content": "",
                    "reasoning_content": "thinking...",
                    "finish_reason": "length",
                },
            )()

    fake_snapshot = type("Snapshot", (), {"provider": EmptyProvider(), "model": "m"})()
    monkeypatch.setattr(
        "nanobot.config.loader.load_config",
        lambda: type("Cfg", (), {"agents": type("A", (), {"defaults": type("D", (), {"model": "m"})()})()})(),
    )
    monkeypatch.setattr("nanobot.providers.factory.build_provider_snapshot", lambda _cfg: fake_snapshot)

    mapping, status = await translate_psb_labels(["待機"])
    assert status == "failed"
    assert mapping == {}
