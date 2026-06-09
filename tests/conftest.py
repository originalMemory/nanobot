"""Shared pytest hooks and fixtures for the full test suite."""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent


def _cleanup_magic_mock_sqlite_artifacts() -> None:
    """Remove SQLite files accidentally created from mocked Path operations."""
    for path in _REPO_ROOT.iterdir():
        if path.is_file() and path.name.startswith("<MagicMock"):
            path.unlink(missing_ok=True)


@pytest.fixture(autouse=True)
def _cleanup_magic_mock_sqlite_pollution():
    yield
    _cleanup_magic_mock_sqlite_artifacts()


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    _cleanup_magic_mock_sqlite_artifacts()
