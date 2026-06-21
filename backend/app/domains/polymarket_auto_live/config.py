from __future__ import annotations

import os


def _bool_from_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() == "true"


def auto_live_backend_allows_execution() -> bool:
    return _bool_from_env("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", False)
