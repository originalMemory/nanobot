"""Shared visibility rules for generated replies."""

from __future__ import annotations


def is_silent_reply(value: str | None) -> bool:
    """Return whether a generated reply is an explicit no-delivery marker."""
    if not isinstance(value, str):
        return False
    normalized = " ".join(
        value.strip().casefold().rstrip(".!?。！？").replace("_", " ").replace("-", " ").split()
    )
    return normalized in {"no reply", "no replay", "all clear"}
