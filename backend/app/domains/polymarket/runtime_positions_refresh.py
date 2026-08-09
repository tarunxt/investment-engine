from __future__ import annotations

import json
from typing import Any

from app.domains.polymarket import runtime_broker as runtime_broker_module


_UI_POSITION_REFRESH_CALLERS = frozenset(
    {
        "ui-history-portfolio-refresh",
    }
)

_ORIGINAL_GET_POSITIONS_SNAPSHOT = (
    runtime_broker_module.BullpenRuntimeBroker.get_positions_snapshot
)
_INSTALLED = False


def _verified_auth_cache_for_credential(
    auth_cache: runtime_broker_module.BullpenAuthReadyCache | None,
    credential_artifact: runtime_broker_module.BullpenCredentialArtifact,
) -> runtime_broker_module.BullpenAuthReadyCache | None:
    if auth_cache is None:
        return None
    if not runtime_broker_module._credential_artifact_matches(
        auth_cache.credential_artifact,
        credential_artifact,
    ):
        return None
    return auth_cache


def _verified_active_auth_for_credential(
    active_auth: runtime_broker_module.BullpenRuntimeActiveAuthResult | None,
    credential_artifact: runtime_broker_module.BullpenCredentialArtifact,
) -> runtime_broker_module.BullpenRuntimeActiveAuthResult | None:
    if active_auth is None or not active_auth.healthy:
        return None
    if not runtime_broker_module._credential_artifact_matches(
        active_auth.credential_artifact,
        credential_artifact,
    ):
        return None
    return active_auth


async def _refresh_ui_positions_snapshot(
    broker: runtime_broker_module.BullpenRuntimeBroker,
    *,
    caller_source: str,
    timeout_seconds: int,
) -> runtime_broker_module.BullpenPositionsSnapshot:
    """Read the Bullpen wallet without pre-gating the read on trade auth.

    The Bullpen CLI can expose Polymarket positions even when its account/trade
    login needs remediation. A UI refresh is therefore allowed to execute the
    read command first. ``execute_raw`` still performs the broker's existing
    auth-refresh-and-retry flow if the positions command itself returns an
    auth rejection.

    A successful read is always safe to publish to the display-only LKG. It is
    promoted into the authenticated execution snapshot only when the current
    credential artifact still has a matching short-lived auth-ready cache.
    This keeps auto-trade/auto-claim lineage strict while making the portfolio
    refresh reflect the wallet that Bullpen itself can currently read.
    """

    refresh_requested_at = runtime_broker_module._utc_now_iso()
    normalized_caller_source = runtime_broker_module._normalize_caller_source(
        caller_source
    )

    result = await broker.execute_raw(
        ["polymarket", "positions", "--output", "json"],
        timeout_seconds=timeout_seconds,
        retry_auth_once=True,
    )
    try:
        payload: Any = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        error = runtime_broker_module.BullpenRuntimeCommandError(
            "Bullpen positions returned invalid JSON.",
            classification="json_parse_error",
            stdout=result.stdout,
            stderr=result.stderr,
            exit_code=result.exit_code,
            signal=result.signal,
        )
        result.diagnostics.error_classification = error.classification
        broker._record_failure(
            command_category="positions",
            classification=error.classification,
            message=str(error),
            diagnostics=result.diagnostics,
        )
        raise error from exc

    credential_artifact = result.diagnostics.credential_artifact
    auth_cache_key = f"{runtime_broker_module._REDIS_PREFIX}:auth:ready"
    auth_cache = _verified_auth_cache_for_credential(
        await broker._read_auth_ready_cache(auth_cache_key),
        credential_artifact,
    )
    active_auth = _verified_active_auth_for_credential(
        await broker.read_latest_active_auth_result(),
        credential_artifact,
    )

    payload_account_identity = runtime_broker_module._extract_account_identity(payload)
    cached_account_identity = (
        auth_cache.account_identity if auth_cache is not None else None
    )
    active_account_identity = (
        active_auth.account_identity if active_auth is not None else None
    )
    verified_account_identity = cached_account_identity or active_account_identity

    if (
        payload_account_identity
        and verified_account_identity
        and payload_account_identity != verified_account_identity
    ) or (
        cached_account_identity
        and active_account_identity
        and cached_account_identity != active_account_identity
    ):
        result.diagnostics.error_classification = "account_identity_mismatch"
        message = (
            "Bullpen positions account identity did not match the authenticated "
            "account."
        )
        broker._record_failure(
            command_category="positions",
            classification="account_identity_mismatch",
            message=message,
            diagnostics=result.diagnostics,
        )
        raise runtime_broker_module.BullpenRuntimeCommandError(
            message,
            classification="account_identity_mismatch",
        )

    account_identity = (
        payload_account_identity
        or cached_account_identity
        or active_account_identity
    )
    auth_checked_at = (
        auth_cache.checked_at
        if auth_cache is not None
        else active_auth.auth_checked_at if active_auth is not None else None
    )

    diagnostics = result.diagnostics.model_copy(
        update={
            "command_category": "positions",
            "cache_status": "bypass",
            "refresh_requested_at": refresh_requested_at,
            "caller_source": normalized_caller_source,
            "snapshot_producer_source": normalized_caller_source,
            "produced_by_another_refresh": False,
        }
    )
    snapshot = runtime_broker_module.BullpenPositionsSnapshot(
        payload=payload,
        fetched_at=runtime_broker_module._utc_now_iso(),
        cli_version=result.diagnostics.bullpen_version or broker._version_cache_value,
        credential_artifact=credential_artifact,
        account_identity=account_identity,
        position_classifier_version=(
            runtime_broker_module.BULLPEN_POSITION_CLASSIFIER_VERSION
        ),
        auth_checked_at=auth_checked_at,
        source="live-cli",
        freshness_state="fresh",
        diagnostics=diagnostics,
    )
    serialized_snapshot = snapshot.model_dump_json()

    # UI display state is intentionally separate from the execution-safe cache.
    await broker._redis.set(
        runtime_broker_module._POSITIONS_DISPLAY_LKG_KEY,
        serialized_snapshot,
        ex=runtime_broker_module._POSITIONS_DISPLAY_LKG_TTL_SECONDS,
    )

    if auth_cache is not None:
        # Preserve the existing strict execution contract only when the current
        # credential still has a recent verified auth-ready proof.
        await broker._write_auth_ready_cache(
            cache_key=auth_cache_key,
            checked_at=auth_cache.checked_at,
            credential_artifact=credential_artifact,
            account_identity=account_identity,
        )
        await broker._redis.set(
            runtime_broker_module._POSITIONS_SNAPSHOT_KEY,
            serialized_snapshot,
            ex=runtime_broker_module._POSITIONS_SNAPSHOT_TTL_SECONDS,
        )

    # A prior auth failure remains valid for trade safety, but it must not make
    # a successfully read wallet look unavailable to the portfolio UI.
    broker._update_cached_health(
        ok=True,
        message="Bullpen positions read completed for portfolio display.",
        command_category="positions",
        error_classification=None,
        diagnostics=diagnostics,
    )
    broker._log_runtime_event(diagnostics, success=True)
    return snapshot


async def _get_positions_snapshot_with_ui_read_fallback(
    self: runtime_broker_module.BullpenRuntimeBroker,
    *,
    force_fresh: bool = False,
    allow_refresh: bool = True,
    caller_source: str | None = None,
    max_age_seconds: int = runtime_broker_module._POSITIONS_FRESH_SECONDS,
    timeout_seconds: int = runtime_broker_module._CLI_DEFAULT_TIMEOUT_SECONDS,
) -> runtime_broker_module.BullpenPositionsSnapshot:
    normalized_caller_source = runtime_broker_module._normalize_caller_source(
        caller_source
    )
    if (
        force_fresh
        and allow_refresh
        and normalized_caller_source in _UI_POSITION_REFRESH_CALLERS
    ):
        return await _refresh_ui_positions_snapshot(
            self,
            caller_source=normalized_caller_source,
            timeout_seconds=timeout_seconds,
        )

    return await _ORIGINAL_GET_POSITIONS_SNAPSHOT(
        self,
        force_fresh=force_fresh,
        allow_refresh=allow_refresh,
        caller_source=caller_source,
        max_age_seconds=max_age_seconds,
        timeout_seconds=timeout_seconds,
    )


def install_bullpen_ui_positions_refresh() -> None:
    """Install the UI-only wallet-read path exactly once per process."""

    global _INSTALLED
    if _INSTALLED:
        return
    runtime_broker_module.BullpenRuntimeBroker.get_positions_snapshot = (
        _get_positions_snapshot_with_ui_read_fallback
    )
    _INSTALLED = True
