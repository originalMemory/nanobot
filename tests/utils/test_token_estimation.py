from nanobot.utils.helpers import (
    estimate_message_tokens,
    estimate_prompt_tokens,
    estimate_prompt_tokens_chain,
)


class _NoCounterProvider:
    pass


class _BrokenCounterProvider:
    def estimate_prompt_tokens(self, messages, tools=None, model=None):
        raise RuntimeError("counter unavailable")


def test_estimate_prompt_tokens_chain_falls_back_without_provider_counter() -> None:
    tokens, source = estimate_prompt_tokens_chain(
        _NoCounterProvider(),
        "test-model",
        [{"role": "user", "content": "hello"}],
    )

    assert tokens > 0
    assert source == "tiktoken"


def test_estimate_prompt_tokens_chain_falls_back_when_provider_counter_fails() -> None:
    tokens, source = estimate_prompt_tokens_chain(
        _BrokenCounterProvider(),
        "test-model",
        [{"role": "user", "content": "hello"}],
    )

    assert tokens > 0
    assert source == "tiktoken"


def test_token_estimates_treat_special_token_text_as_plain_content() -> None:
    message = {
        "role": "tool",
        "name": "read_file",
        "tool_call_id": "call-1",
        "content": "model log: <|endoftext|>",
    }

    assert estimate_prompt_tokens([message]) > 0
    assert estimate_message_tokens(message) > 4
