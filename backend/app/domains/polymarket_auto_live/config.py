from __future__ import annotations

import os

AUTO_LIVE_EXECUTION_ENV_VAR = "BULLPEN_AUTO_LIVE_ALLOW_EXECUTION"
AUTO_LIVE_EXECUTION_V2_ENV_VAR = "AUTO_LIVE_EXECUTION_V2_ENABLED"
AUTO_LIVE_EXECUTION_V2_SHADOW_ENV_VAR = "AUTO_LIVE_EXECUTION_V2_SHADOW_ONLY"
TRUTHY_ENV_VALUES = frozenset({"1", "true", "yes", "y", "on"})


def _normalized_env_value(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    return value.strip().lower()


def _bool_from_env(name: str, default: bool) -> bool:
    value = _normalized_env_value(name)
    if value is None:
        return default
    return value in TRUTHY_ENV_VALUES


def auto_live_backend_allows_execution() -> bool:
    return _bool_from_env(AUTO_LIVE_EXECUTION_ENV_VAR, False)


def auto_live_backend_execution_env_detail() -> str:
    value = _normalized_env_value(AUTO_LIVE_EXECUTION_ENV_VAR)
    if value is None:
        return (
            f"{AUTO_LIVE_EXECUTION_ENV_VAR} is missing from this backend process. "
            "Set it to true in /etc/investor/backend.env, then restart "
            "investor-backend and investor-celery-worker."
        )
    if value in TRUTHY_ENV_VALUES:
        return f"{AUTO_LIVE_EXECUTION_ENV_VAR} is enabled in this backend process."
    return (
        f"{AUTO_LIVE_EXECUTION_ENV_VAR} is currently {value!r} in this backend process. "
        "Set it to true in /etc/investor/backend.env, then restart "
        "investor-backend and investor-celery-worker."
    )


def auto_live_execution_v2_enabled() -> bool:
    # Durable intents are the safe default for live Stage 3 execution.  Keep
    # the environment switch as an explicit rollback lever for operators.
    return _bool_from_env(AUTO_LIVE_EXECUTION_V2_ENV_VAR, True)


def auto_live_execution_v2_shadow_only() -> bool:
    return _bool_from_env(AUTO_LIVE_EXECUTION_V2_SHADOW_ENV_VAR, False)
