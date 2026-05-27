"""Session management module."""

from nanobot.session.manager import Session, SessionManager

UNIFIED_SESSION_KEY = "unified:default"

__all__ = ["SessionManager", "Session", "UNIFIED_SESSION_KEY"]
