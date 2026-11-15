from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from pydantic import BaseModel, ConfigDict

from app.domains.polymarket.runtime_broker import (
    BullpenRuntimePassiveHealth,
    close_bullpen_runtime_broker,
    get_bullpen_runtime_broker,
)

_DEFAULT_STATE_DIR = "/home/investor/.bullpen-health"
_REPORT_FILENAME = "bullpen-health.json"
_MAX_REPORT_BYTES = 16 * 1024
_DEFAULT_WEBHOOK_TIMEOUT_SECONDS = 10
_MAX_WEBHOOK_TIMEOUT_SECONDS = 30
_SAFE_CLASSIFICATIONS = frozenset(
    {
        "auth_rejected",
        "json_parse_error",
        "lock_timeout",
        "missing_runtime",
        "passive_cache_miss",
        "passive_health_read_failed",
        "runtime_error",
        "timeout",
        "transport_error",
        "wallet_not_ready",
    }
)


class PassiveAuthReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    available: bool
    healthy: bool | None = None
    checked_at: str | None = None
    auth_checked_at: str | None = None
    login_required: bool | None = None
    wallet_ready: bool | None = None
    error_classification: str | None = None


class PassivePositionsReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    available: bool
    fetched_at: str | None = None
    freshness_state: str | None = None
    source: str | None = None
    position_classifier_version: int | None = None


class PassiveFailureReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    occurred_at: str | None = None
    classification: str | None = None
    stale: bool = False
    recovered_at: str | None = None
    message: str | None = None


class BullpenPassiveHealthReport(BaseModel):
    """Bounded, identity-free monitoring projection of shared broker state."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = 1
    report_type: str = "bullpen-runtime-passive-health"
    source: str = "centralized-runtime-broker-cache"
    monitoring_mode: str = "passive-read-only"
    ok: bool
    checked_at: str
    classification: str | None = None
    message: str
    auth: PassiveAuthReport
    positions_snapshot: PassivePositionsReport
    last_failure: PassiveFailureReport | None = None


def _safe_classification(value: object | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized:
        return None
    if normalized not in _SAFE_CLASSIFICATIONS:
        return "runtime_error"
    return normalized


def _safe_timestamp(value: object | None) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.isoformat()


def build_passive_health_report(
    passive_health: BullpenRuntimePassiveHealth,
) -> BullpenPassiveHealthReport:
    active_auth = passive_health.active_auth
    snapshot = passive_health.latest_snapshot
    last_failure = passive_health.last_failure
    classification = (
        active_auth.error_classification
        if active_auth is not None and not active_auth.healthy
        else passive_health.broker_health.error_classification
    )
    if classification is None and last_failure is not None and not last_failure.stale:
        classification = last_failure.classification

    report_ok = (
        passive_health.ok
        and snapshot is not None
        and not (active_auth is not None and active_auth.wallet_ready is False)
    )
    if (
        active_auth is not None
        and active_auth.wallet_ready is False
        and _safe_classification(classification) is None
    ):
        classification = "wallet_not_ready"
    if snapshot is None and _safe_classification(classification) is None:
        classification = "passive_cache_miss"
    safe_classification = _safe_classification(classification)
    safe_message = (
        "Shared Bullpen runtime cache reports healthy."
        if report_ok
        else "Shared Bullpen runtime cache reports unhealthy."
    )

    return BullpenPassiveHealthReport(
        ok=report_ok,
        checked_at=_safe_timestamp(passive_health.checked_at) or "unknown",
        classification=safe_classification,
        message=safe_message,
        auth=PassiveAuthReport(
            available=active_auth is not None,
            healthy=active_auth.healthy if active_auth is not None else None,
            checked_at=(
                _safe_timestamp(active_auth.checked_at)
                if active_auth is not None
                else None
            ),
            auth_checked_at=_safe_timestamp(passive_health.auth_checked_at),
            login_required=(
                active_auth.login_required if active_auth is not None else None
            ),
            wallet_ready=active_auth.wallet_ready if active_auth is not None else None,
            error_classification=(
                _safe_classification(active_auth.error_classification)
                if active_auth is not None
                else None
            ),
        ),
        positions_snapshot=PassivePositionsReport(
            available=snapshot is not None,
            fetched_at=(
                _safe_timestamp(snapshot.fetched_at) if snapshot is not None else None
            ),
            freshness_state=snapshot.freshness_state if snapshot is not None else None,
            source=snapshot.source if snapshot is not None else None,
            position_classifier_version=(
                snapshot.position_classifier_version if snapshot is not None else None
            ),
        ),
        last_failure=(
            PassiveFailureReport(
                occurred_at=_safe_timestamp(last_failure.occurred_at),
                classification=_safe_classification(last_failure.classification),
                stale=last_failure.stale,
                recovered_at=_safe_timestamp(last_failure.recovered_at),
                message="A shared Bullpen runtime failure was recorded.",
            )
            if last_failure is not None
            else None
        ),
    )


async def collect_passive_health_report() -> BullpenPassiveHealthReport:
    broker = get_bullpen_runtime_broker()
    try:
        return build_passive_health_report(
            await broker.read_passive_health(strict_read_only=True)
        )
    finally:
        await close_bullpen_runtime_broker()


def _state_directory(value: str | None = None) -> Path:
    configured = value if value is not None else os.getenv("BULLPEN_HEALTH_STATE_DIR")
    path = Path((configured or _DEFAULT_STATE_DIR).strip()).expanduser()
    if not path.is_absolute():
        raise ValueError("BULLPEN_HEALTH_STATE_DIR must be an absolute path.")
    if path.is_symlink():
        raise ValueError("BULLPEN_HEALTH_STATE_DIR must not be a symbolic link.")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ValueError("BULLPEN_HEALTH_STATE_DIR must be a real directory.")
    return path


def _serialized_report(report: BullpenPassiveHealthReport) -> bytes:
    payload = json.dumps(
        report.model_dump(mode="json"),
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    if len(payload) + 1 > _MAX_REPORT_BYTES:
        raise ValueError("Bullpen passive health report exceeded its size limit.")
    return payload + b"\n"


def write_passive_health_report(
    report: BullpenPassiveHealthReport,
    *,
    state_dir: str | None = None,
) -> Path:
    directory = _state_directory(state_dir)
    destination = directory / _REPORT_FILENAME
    payload = _serialized_report(report)
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=directory,
        prefix=f".{_REPORT_FILENAME}.",
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "wb") as handle:
            file_descriptor = -1
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, destination)
        directory_descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if file_descriptor >= 0:
            os.close(file_descriptor)
        temporary_path.unlink(missing_ok=True)
    return destination


def _webhook_timeout_seconds(value: str | None = None) -> int:
    configured = (
        value
        if value is not None
        else os.getenv("BULLPEN_HEALTH_WEBHOOK_TIMEOUT_SECONDS")
    )
    try:
        parsed = int((configured or str(_DEFAULT_WEBHOOK_TIMEOUT_SECONDS)).strip())
    except ValueError:
        parsed = _DEFAULT_WEBHOOK_TIMEOUT_SECONDS
    return max(1, min(parsed, _MAX_WEBHOOK_TIMEOUT_SECONDS))


def post_passive_health_webhook(
    report: BullpenPassiveHealthReport,
    *,
    webhook_url: str | None = None,
    timeout_seconds: int | None = None,
    urlopen_impl: Callable[..., Any] = urlopen,
) -> bool:
    configured = (
        webhook_url
        if webhook_url is not None
        else os.getenv("BULLPEN_HEALTH_WEBHOOK_URL")
    )
    url = (configured or "").strip()
    if not url:
        return False
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("BULLPEN_HEALTH_WEBHOOK_URL must use HTTP or HTTPS.")

    request = Request(
        url,
        data=_serialized_report(report),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "credx-bullpen-passive-health/1",
        },
        method="POST",
    )
    timeout = (
        max(1, min(timeout_seconds, _MAX_WEBHOOK_TIMEOUT_SECONDS))
        if timeout_seconds is not None
        else _webhook_timeout_seconds()
    )
    with urlopen_impl(request, timeout=timeout) as response:
        status = int(getattr(response, "status", 200))
        if status < 200 or status >= 300:
            raise RuntimeError(f"Bullpen health webhook returned HTTP {status}.")
    return True


def _failure_report(error: Exception) -> BullpenPassiveHealthReport:
    del error
    message = "Passive Bullpen health cache read failed."
    return BullpenPassiveHealthReport(
        ok=False,
        checked_at=datetime.now(UTC).isoformat(),
        classification="passive_health_read_failed",
        message=message,
        auth=PassiveAuthReport(available=False),
        positions_snapshot=PassivePositionsReport(available=False),
        last_failure=PassiveFailureReport(
            classification="passive_health_read_failed",
            message=message,
        ),
    )


async def run_healthcheck() -> int:
    try:
        report = await collect_passive_health_report()
    except Exception as exc:
        report = _failure_report(exc)

    try:
        write_passive_health_report(report)
    except Exception:
        print(
            "Bullpen passive health report write failed.",
            file=sys.stderr,
        )
        return 1

    webhook_failed = False
    try:
        post_passive_health_webhook(report)
    except Exception:
        webhook_failed = True
        print(
            "Bullpen passive health webhook delivery failed.",
            file=sys.stderr,
        )

    print(json.dumps(report.model_dump(mode="json"), indent=2, sort_keys=True))
    return 0 if report.ok and not webhook_failed else 1


def main() -> None:
    raise SystemExit(asyncio.run(run_healthcheck()))


if __name__ == "__main__":
    main()
