from __future__ import annotations

import asyncio
import json
import os
import pwd
import stat
from pathlib import Path
from time import monotonic
from typing import Any, Awaitable, Literal, TypeVar

import redis.asyncio as aioredis
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.logging import get_logger
from app.domains.polymarket.logger import redact_secrets
from app.domains.polymarket.position_classification import (
    BULLPEN_POSITION_CLASSIFIER_VERSION,
)
from app.infrastructure.locks.redis_lock import LockAcquisitionError, RedisLock

logger = get_logger(__name__)
_T = TypeVar("_T")

_DEFAULT_BULLPEN_BIN = "/usr/local/bin/bullpen"
_DEFAULT_HOME = "/home/investor"
_DEFAULT_BULLPEN_HOME = "/home/investor/.bullpen"
_DEFAULT_BULLPEN_CONFIG = "/home/investor/.bullpen/config.toml"
_DEFAULT_BULLPEN_ENV = "production"
_AUTH_READY_TTL_SECONDS = 60
_CLI_VERSION_TTL_SECONDS = 300
_POSITIONS_SNAPSHOT_TTL_SECONDS = 300
_POSITIONS_FRESH_SECONDS = 20
_POSITIONS_LOCK_TTL_SECONDS = 120
_POSITIONS_LOCK_TIMEOUT_SECONDS = 12
_AUTHENTICATED_CLI_LOCK_TTL_SECONDS = 120
_AUTHENTICATED_CLI_LOCK_TIMEOUT_SECONDS = 30
_LOCK_RENEW_INTERVAL_SECONDS = 30
_CLI_DEFAULT_TIMEOUT_SECONDS = 30
_POLL_INTERVAL_SECONDS = 0.1
_MAX_BUFFER_BYTES = 10 * 1024 * 1024
_REDIS_PREFIX = "bullpen:runtime"
_AUTHENTICATED_CLI_LOCK_KEY = f"{_REDIS_PREFIX}:authenticated-cli"
_PRODUCTION_ENVIRONMENTS = {"production", "prod"}
_STRICT_RUNTIME_OWNER = "investor"
_READ_ONLY_FLAG = "--read-only"

_POLYMARKET_WRITE_VERBS = {
    "activate",
    "approve",
    "buy",
    "claim",
    "consolidate",
    "limit-buy",
    "limit-sell",
    "migrate",
    "orders",
    "redeem",
    "sell",
    "split",
    "sweep-stranded",
    "unwrap",
    "wrap",
}
_UNSUPPORTED_RUNTIME_VERBS = {"login", "logout"}


class BullpenRuntimeError(RuntimeError):
    pass


class BullpenRuntimeValidationError(BullpenRuntimeError):
    pass


class BullpenRuntimeCommandError(BullpenRuntimeError):
    def __init__(
        self,
        message: str,
        *,
        classification: str | None = None,
        stdout: str | None = None,
        stderr: str | None = None,
        exit_code: int | None = None,
        signal: int | None = None,
    ) -> None:
        super().__init__(message)
        self.classification = classification
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code
        self.signal = signal


class BullpenCredentialArtifact(BaseModel):
    path: str | None = None
    inode: int | None = None
    mtime: float | None = None
    mtime_ns: int | None = None
    size: int | None = None


class BullpenAuthReadyCache(BaseModel):
    checked_at: str
    credential_artifact: BullpenCredentialArtifact = Field(
        default_factory=BullpenCredentialArtifact
    )
    account_identity: str | None = None


class BullpenRuntimeConfigSnapshot(BaseModel):
    effective_user: str | None = None
    effective_uid: int
    home: str
    bullpen_home: str
    bullpen_config: str
    bullpen_env: str
    bullpen_bin: str
    credential_store: str


class BullpenCommandDiagnostics(BaseModel):
    command_category: str
    pid: int
    unix_user: str | None = None
    effective_home: str
    bullpen_version: str | None = None
    credential_artifact: BullpenCredentialArtifact = Field(
        default_factory=BullpenCredentialArtifact
    )
    lock_key: str | None = None
    lock_wait_ms: float | None = None
    lock_hold_ms: float | None = None
    cache_status: Literal["hit", "miss", "stale", "bypass"] = "bypass"
    auth_refresh_attempted: bool = False
    error_classification: str | None = None


class BullpenPositionsSnapshot(BaseModel):
    payload: Any
    fetched_at: str
    cli_version: str | None = None
    credential_artifact: BullpenCredentialArtifact = Field(
        default_factory=BullpenCredentialArtifact
    )
    account_identity: str | None = None
    position_classifier_version: int = BULLPEN_POSITION_CLASSIFIER_VERSION
    auth_checked_at: str | None = None
    source: Literal["live-cli", "redis-cache"] = "live-cli"
    freshness_state: Literal["fresh", "cached", "stale"] = "fresh"
    diagnostics: BullpenCommandDiagnostics


class BullpenRawCommandResult(BaseModel):
    stdout: str
    stderr: str = ""
    exit_code: int = 0
    signal: int | None = None
    diagnostics: BullpenCommandDiagnostics


class BullpenRuntimeFailure(BaseModel):
    occurred_at: str
    command_category: str | None = None
    classification: str | None = None
    message: str


class BullpenRuntimeCachedHealth(BaseModel):
    ok: bool
    checked_at: str
    message: str
    command_category: str | None = None
    error_classification: str | None = None
    cli_version: str | None = None
    command_path: str | None = None
    effective_home: str | None = None
    credential_artifact: BullpenCredentialArtifact = Field(
        default_factory=BullpenCredentialArtifact
    )


class BullpenPositionsSnapshotMetadata(BaseModel):
    fetched_at: str
    cli_version: str | None = None
    credential_artifact: BullpenCredentialArtifact = Field(
        default_factory=BullpenCredentialArtifact
    )
    account_identity: str | None = None
    position_classifier_version: int = BULLPEN_POSITION_CLASSIFIER_VERSION
    auth_checked_at: str | None = None
    source: Literal["live-cli", "redis-cache"] = "live-cli"
    freshness_state: Literal["fresh", "cached", "stale"] = "fresh"
    diagnostics: BullpenCommandDiagnostics


class BullpenRuntimePassiveHealth(BaseModel):
    ok: bool
    checked_at: str
    broker_health: BullpenRuntimeCachedHealth
    auth_checked_at: str | None = None
    latest_snapshot: BullpenPositionsSnapshotMetadata | None = None
    last_failure: BullpenRuntimeFailure | None = None
    cli_version: str | None = None
    command_path: str | None = None


def _utc_now_iso() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat()


def _running_loop_or_none() -> asyncio.AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


def _effective_user_name() -> str | None:
    try:
        return pwd.getpwuid(os.getuid()).pw_name
    except (KeyError, OSError):
        return None


def _default_bullpen_home() -> str:
    configured = os.getenv("BULLPEN_HOME") or os.getenv("BULLPEN_CREDENTIALS_HOME")
    return os.path.expanduser((configured or _DEFAULT_BULLPEN_HOME).strip())


def _default_home() -> str:
    configured = os.getenv("HOME")
    if configured and configured.strip():
        return os.path.expanduser(configured.strip())
    bullpen_home = _default_bullpen_home()
    return str(Path(bullpen_home).parent)


def _default_bullpen_config() -> str:
    configured = os.getenv("BULLPEN_CONFIG")
    if configured and configured.strip():
        return os.path.expanduser(configured.strip())
    return str(Path(_default_bullpen_home()) / "config.toml")


def _default_bullpen_env() -> str:
    configured = os.getenv("BULLPEN_ENV")
    return (configured or _DEFAULT_BULLPEN_ENV).strip() or _DEFAULT_BULLPEN_ENV


def _default_bullpen_bin() -> str:
    configured = os.getenv("BULLPEN_BIN")
    return (configured or _DEFAULT_BULLPEN_BIN).strip() or _DEFAULT_BULLPEN_BIN


def _runtime_config() -> BullpenRuntimeConfigSnapshot:
    bullpen_home = _default_bullpen_home()
    home = _default_home()
    return BullpenRuntimeConfigSnapshot(
        effective_user=_effective_user_name(),
        effective_uid=os.getuid(),
        home=home,
        bullpen_home=bullpen_home,
        bullpen_config=_default_bullpen_config(),
        bullpen_env=_default_bullpen_env(),
        bullpen_bin=_default_bullpen_bin(),
        credential_store=bullpen_home,
    )


def _credential_artifact_candidates(config: BullpenRuntimeConfigSnapshot) -> list[Path]:
    home = Path(config.bullpen_home)
    explicit_auth_file = os.getenv("BULLPEN_AUTH_FILE")
    candidates = [
        home / "credentials.json.enc",
        home / "credentials.json",
        Path(explicit_auth_file).expanduser()
        if explicit_auth_file
        else None,
        home,
    ]
    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate is None:
            continue
        resolved = str(candidate)
        if not resolved or resolved in seen:
            continue
        seen.add(resolved)
        unique.append(candidate)
    return unique


def _stat_credential_artifact(
    config: BullpenRuntimeConfigSnapshot,
) -> BullpenCredentialArtifact:
    for candidate in _credential_artifact_candidates(config):
        try:
            candidate_stat = candidate.stat()
        except FileNotFoundError:
            continue
        if not (
            stat.S_ISDIR(candidate_stat.st_mode) or stat.S_ISREG(candidate_stat.st_mode)
        ):
            continue
        return BullpenCredentialArtifact(
            path=str(candidate),
            inode=int(candidate_stat.st_ino),
            mtime=float(candidate_stat.st_mtime),
            mtime_ns=int(candidate_stat.st_mtime_ns),
            size=int(candidate_stat.st_size),
        )
    return BullpenCredentialArtifact()


def _is_runtime_validation_strict() -> bool:
    configured = os.getenv("BULLPEN_RUNTIME_VALIDATE_STRICT")
    if configured is not None:
        return configured.strip().lower() in {"1", "true", "yes", "on"}
    return (
        settings.environment.lower() in _PRODUCTION_ENVIRONMENTS
        and Path("/etc/investor/backend.env").exists()
    )


def _parse_command_category(args: list[str]) -> tuple[str, bool, bool]:
    if not args:
        raise BullpenRuntimeError("Bullpen command arguments are required.")

    root = args[0]
    if root in _UNSUPPORTED_RUNTIME_VERBS:
        raise BullpenRuntimeError(
            f"Bullpen runtime broker does not permit `{root}` in automated flows."
        )
    if root == "--version":
        return "version", False, False
    if root == "status":
        return "status", False, True
    if root == "doctor" and len(args) >= 2 and args[1] == "auth":
        return (
            "doctor-auth-refresh" if "--refresh" in args else "doctor-auth",
            False,
            True,
        )
    if root == "portfolio" and len(args) >= 2 and args[1] == "balances":
        return "balance", False, True
    if root == "portfolio" and len(args) >= 2 and args[1] == "history":
        return "history", False, True
    if root == "funds" and len(args) >= 2 and args[1] == "balances":
        return "balance", False, True
    if root == "wallet":
        subcommand = args[1] if len(args) >= 2 else ""
        if subcommand == "predictions" and "--history" in args:
            return "history", False, True
        return f"wallet-{subcommand or 'read'}", False, True
    if root == "activity":
        return "activity", False, True
    if root != "polymarket":
        return f"raw-{root}", False, True

    verb = args[1] if len(args) >= 2 else ""
    if verb == "positions":
        return "positions", False, True
    if verb == "discover":
        return "discover", False, True
    if verb == "search":
        return "search", False, True
    if verb == "preflight":
        return "preflight", False, True
    if verb == "orders":
        has_write_flag = any(flag in args for flag in ("--cancel", "--cancel-all", "--yes"))
        return ("orders-write" if has_write_flag else "orders-read", has_write_flag, True)
    if verb in _POLYMARKET_WRITE_VERBS:
        return f"polymarket-{verb}", True, True
    return f"polymarket-{verb or 'read'}", False, True


def _sanitize_command_args(args: list[str], *, is_write: bool) -> list[str]:
    if is_write:
        return list(args)
    return [arg for arg in args if arg != _READ_ONLY_FLAG]


def _classify_runtime_error(message: str) -> str:
    lowered = message.lower()
    if any(
        marker in lowered
        for marker in (
            "auth_refresh_rejected_login_required",
            "refresh token rejected",
            "refresh_token_rejected",
            "invalid refresh token",
            "session expired",
            "jwt expired",
            "not logged in",
            "requires_login",
            "auth required",
        )
    ):
        return "auth_rejected"
    if "timed out" in lowered or "timeout" in lowered:
        return "timeout"
    if "no such file" in lowered or "not found" in lowered:
        return "missing_runtime"
    if any(
        marker in lowered
        for marker in (
            "bad gateway",
            "connection reset",
            "socket hang up",
            "temporarily unavailable",
            "rate limited",
            "protocol error",
        )
    ):
        return "transport_error"
    return "runtime_error"


def _extract_auth_ready_timestamp(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    for key in ("checked_at", "checkedAt", "authenticated_at", "authenticatedAt"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _looks_like_auth_refresh_failure(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    lowered_fields = " ".join(
        str(payload.get(key, "")).lower()
        for key in ("error", "message", "detail", "status", "error_code")
    )
    if payload.get("requires_login") or payload.get("requires_auth"):
        return "Bullpen auth refresh requires a manual login."
    if payload.get("status") == "error" or payload.get("error"):
        return redact_secrets(
            str(
                payload.get("error")
                or payload.get("message")
                or payload.get("detail")
                or "Bullpen auth refresh failed."
            )
        )
    if "requires login" in lowered_fields or "not logged in" in lowered_fields:
        return redact_secrets(lowered_fields)
    return None


def _credential_artifact_matches(
    expected: BullpenCredentialArtifact,
    actual: BullpenCredentialArtifact,
) -> bool:
    return (
        expected.path == actual.path
        and expected.inode == actual.inode
        and expected.mtime_ns == actual.mtime_ns
        and expected.size == actual.size
    )


_ACCOUNT_IDENTITY_KEYS = {
    "wallet",
    "wallet_address",
    "walletaddress",
    "proxy_wallet",
    "proxywallet",
    "address",
    "public_key",
    "publickey",
    "account",
    "account_id",
    "accountid",
    "user",
    "user_id",
    "userid",
    "owner",
}
_ACCOUNT_IDENTITY_CONTAINER_KEYS = {
    "summary",
    "account",
    "user",
    "wallet",
    "identity",
    "metadata",
    "meta",
}


def _normalize_account_identity(value: object) -> str | None:
    if isinstance(value, str):
        normalized = value.strip()
        if not normalized:
            return None
        return normalized.lower() if normalized.startswith("0x") else normalized
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return None


def _extract_account_identity(value: Any, *, max_depth: int = 3) -> str | None:
    def walk(current: Any, depth: int) -> str | None:
        if depth > max_depth:
            return None
        if isinstance(current, dict):
            for key, nested in current.items():
                normalized_key = str(key).strip().lower()
                if normalized_key in _ACCOUNT_IDENTITY_KEYS:
                    direct = _normalize_account_identity(nested)
                    if direct:
                        return direct
                if normalized_key in _ACCOUNT_IDENTITY_CONTAINER_KEYS:
                    nested_identity = walk(nested, depth + 1)
                    if nested_identity:
                        return nested_identity
            return None
        if isinstance(current, list):
            for item in current:
                nested_identity = walk(item, depth + 1)
                if nested_identity:
                    return nested_identity
        return None

    return walk(value, 0)


def _snapshot_matches_runtime(
    snapshot: BullpenPositionsSnapshot,
    *,
    current_credential: BullpenCredentialArtifact,
    auth_cache: BullpenAuthReadyCache | None,
) -> bool:
    if snapshot.position_classifier_version != BULLPEN_POSITION_CLASSIFIER_VERSION:
        return False
    if not _credential_artifact_matches(snapshot.credential_artifact, current_credential):
        return False
    current_account_identity = auth_cache.account_identity if auth_cache else None
    if current_account_identity and snapshot.account_identity != current_account_identity:
        return False
    return True


def _build_auth_refresh_failure(payload: Any, reason: str) -> BullpenRuntimeCommandError:
    return BullpenRuntimeCommandError(
        redact_secrets(reason),
        classification="auth_rejected",
        stdout=json.dumps(payload) if isinstance(payload, dict) else None,
    )


def _validate_auth_refresh_payload(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise BullpenRuntimeCommandError(
            "Bullpen auth refresh returned an unexpected payload.",
            classification="json_parse_error",
        )

    failure = _looks_like_auth_refresh_failure(payload)
    if failure:
        raise _build_auth_refresh_failure(payload, failure)

    if payload.get("credentials_valid") is not True:
        raise _build_auth_refresh_failure(
            payload,
            "Bullpen auth refresh did not confirm valid credentials.",
        )
    if payload.get("token_valid") is not True:
        raise _build_auth_refresh_failure(
            payload,
            "Bullpen auth refresh did not confirm a valid Bullpen token.",
        )
    if payload.get("refresh_succeeded") is False:
        raise _build_auth_refresh_failure(
            payload,
            "Bullpen auth refresh reported that token refresh failed.",
        )
    if payload.get("trade_auth_blocked") is True:
        raise _build_auth_refresh_failure(
            payload,
            "Bullpen auth refresh reported that trading auth is blocked.",
        )
    if payload.get("requires_login") is True or payload.get("requires_auth") is True:
        raise _build_auth_refresh_failure(
            payload,
            "Bullpen auth refresh still requires a manual login.",
        )

    remediation = payload.get("remediation")
    if isinstance(remediation, dict):
        action = str(remediation.get("action") or "").strip().lower()
        if action and action != "none":
            raise _build_auth_refresh_failure(
                payload,
                f"Bullpen auth refresh requires operator remediation: {action}.",
            )

    return _extract_auth_ready_timestamp(payload) or _utc_now_iso()


class BullpenRuntimeBroker:
    def __init__(self) -> None:
        self._redis = aioredis.from_url(settings.redis_url, decode_responses=True)
        self._lock = RedisLock(self._redis)
        self._positions_futures: dict[asyncio.AbstractEventLoop, asyncio.Future] = {}
        self._version_cache_value: str | None = None
        self._version_cache_expires_at: float = 0.0
        config = _runtime_config()
        self._last_auth_checked_at: str | None = None
        self._last_failure: BullpenRuntimeFailure | None = None
        self._last_health = BullpenRuntimeCachedHealth(
            ok=False,
            checked_at=_utc_now_iso(),
            message="Bullpen runtime broker initialized. Awaiting the first authenticated command.",
            cli_version=None,
            command_path=config.bullpen_bin,
            effective_home=config.home,
            credential_artifact=_stat_credential_artifact(config),
        )

    async def aclose(self) -> None:
        await self._redis.aclose()

    def validate_startup(self) -> BullpenRuntimeConfigSnapshot:
        config = _runtime_config()
        problems: list[str] = []
        binary_path = Path(config.bullpen_bin)

        if _is_runtime_validation_strict():
            if config.effective_user != _STRICT_RUNTIME_OWNER:
                problems.append(
                    f"effective user must be `{_STRICT_RUNTIME_OWNER}`, found `{config.effective_user or 'unknown'}`"
                )
            if config.home != _DEFAULT_HOME:
                problems.append(f"HOME must be `{_DEFAULT_HOME}`, found `{config.home}`")
            if config.bullpen_home != _DEFAULT_BULLPEN_HOME:
                problems.append(
                    f"BULLPEN_HOME must be `{_DEFAULT_BULLPEN_HOME}`, found `{config.bullpen_home}`"
                )
            if config.bullpen_config != _DEFAULT_BULLPEN_CONFIG:
                problems.append(
                    f"BULLPEN_CONFIG must be `{_DEFAULT_BULLPEN_CONFIG}`, found `{config.bullpen_config}`"
                )
            if config.bullpen_env != _DEFAULT_BULLPEN_ENV:
                problems.append(
                    f"BULLPEN_ENV must be `{_DEFAULT_BULLPEN_ENV}`, found `{config.bullpen_env}`"
                )
            if config.bullpen_bin != _DEFAULT_BULLPEN_BIN:
                problems.append(
                    f"BULLPEN_BIN must be `{_DEFAULT_BULLPEN_BIN}`, found `{config.bullpen_bin}`"
                )

        if not binary_path.is_file() or not os.access(binary_path, os.X_OK):
            problems.append(f"BULLPEN_BIN is not executable: `{config.bullpen_bin}`")

        if not Path(config.bullpen_home).exists():
            problems.append(
                f"canonical Bullpen credential store is missing: `{config.bullpen_home}`"
            )

        if problems:
            raise BullpenRuntimeValidationError(
                "Bullpen runtime validation failed: " + "; ".join(problems)
            )

        logger.info(
            "Bullpen runtime validated",
            extra={
                "runtime_config": config.model_dump(mode="json"),
                "credential_artifact": _stat_credential_artifact(config).model_dump(
                    mode="json"
                ),
            },
        )
        self._last_health = BullpenRuntimeCachedHealth(
            ok=True,
            checked_at=_utc_now_iso(),
            message="Bullpen runtime validated. Awaiting the next authenticated command.",
            cli_version=self._version_cache_value,
            command_path=config.bullpen_bin,
            effective_home=config.home,
            credential_artifact=_stat_credential_artifact(config),
        )
        return config

    async def cli_version(self) -> str | None:
        now = monotonic()
        if self._version_cache_value and now < self._version_cache_expires_at:
            return self._version_cache_value
        try:
            async with self._lock.acquire(
                _AUTHENTICATED_CLI_LOCK_KEY,
                ttl=_AUTHENTICATED_CLI_LOCK_TTL_SECONDS,
                timeout=_AUTHENTICATED_CLI_LOCK_TIMEOUT_SECONDS,
                renew_interval=_LOCK_RENEW_INTERVAL_SECONDS,
            ) as lease:
                return await self._cli_version_under_lock(
                    lock_key=lease.lock_key,
                    lock_wait_ms=lease.wait_duration_seconds * 1000,
                )
        except (BullpenRuntimeCommandError, LockAcquisitionError):
            return None

    async def ensure_auth_ready(self, *, force_refresh: bool = False) -> str:
        cache_key = f"{_REDIS_PREFIX}:auth:ready"
        observed_credential = _stat_credential_artifact(_runtime_config())
        async with self._lock.acquire(
            _AUTHENTICATED_CLI_LOCK_KEY,
            ttl=_AUTHENTICATED_CLI_LOCK_TTL_SECONDS,
            timeout=_AUTHENTICATED_CLI_LOCK_TIMEOUT_SECONDS,
            renew_interval=_LOCK_RENEW_INTERVAL_SECONDS,
        ) as lease:
            return await self.ensure_auth_ready_under_lock(
                force_refresh=force_refresh,
                cache_key=cache_key,
                lock_key=lease.lock_key,
                lock_wait_ms=lease.wait_duration_seconds * 1000,
                observed_credential=observed_credential,
            )

    async def ensure_auth_ready_under_lock(
        self,
        *,
        force_refresh: bool,
        cache_key: str,
        lock_key: str | None,
        lock_wait_ms: float | None,
        observed_credential: BullpenCredentialArtifact | None = None,
    ) -> str:
        current_credential = _stat_credential_artifact(_runtime_config())
        if not force_refresh:
            cached = await self._read_auth_ready_cache(cache_key)
            if cached and _credential_artifact_matches(
                cached.credential_artifact,
                current_credential,
            ) and (
                observed_credential is None
                or _credential_artifact_matches(observed_credential, current_credential)
            ):
                self._last_auth_checked_at = cached.checked_at
                return cached.checked_at

        return await self._refresh_auth_under_lock(
            cache_key=cache_key,
            current_credential=current_credential,
            lease_lock_key=lock_key,
            lease_wait_ms=lock_wait_ms,
        )

    async def read_passive_health(self) -> BullpenRuntimePassiveHealth:
        snapshot = await self.read_cached_positions_snapshot()
        auth_cache = await self._read_auth_ready_cache(f"{_REDIS_PREFIX}:auth:ready")
        latest_auth_checked_at = (
            auth_cache.checked_at
            if auth_cache is not None
            else snapshot.auth_checked_at if snapshot is not None else self._last_auth_checked_at
        )
        return BullpenRuntimePassiveHealth(
            ok=self._last_health.ok,
            checked_at=_utc_now_iso(),
            broker_health=self._last_health,
            auth_checked_at=latest_auth_checked_at,
            latest_snapshot=self._snapshot_metadata(snapshot),
            last_failure=self._last_failure,
            cli_version=self._version_cache_value,
            command_path=_runtime_config().bullpen_bin,
        )

    async def _read_auth_ready_cache(
        self,
        cache_key: str,
    ) -> BullpenAuthReadyCache | None:
        raw = await self._redis.get(cache_key)
        if not raw:
            return None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            text = raw.strip()
            return BullpenAuthReadyCache(checked_at=text) if text else None
        try:
            return BullpenAuthReadyCache.model_validate(payload)
        except Exception:
            return None

    async def _write_auth_ready_cache(
        self,
        *,
        cache_key: str,
        checked_at: str,
        credential_artifact: BullpenCredentialArtifact,
        account_identity: str | None = None,
    ) -> None:
        payload = BullpenAuthReadyCache(
            checked_at=checked_at,
            credential_artifact=credential_artifact,
            account_identity=account_identity,
        )
        await self._redis.set(
            cache_key,
            payload.model_dump_json(),
            ex=_AUTH_READY_TTL_SECONDS,
        )

    async def _delete_auth_ready_cache(self, cache_key: str) -> None:
        await self._redis.delete(cache_key)

    def _snapshot_metadata(
        self,
        snapshot: BullpenPositionsSnapshot | None,
    ) -> BullpenPositionsSnapshotMetadata | None:
        if snapshot is None:
            return None
        return BullpenPositionsSnapshotMetadata(
            fetched_at=snapshot.fetched_at,
            cli_version=snapshot.cli_version,
            credential_artifact=snapshot.credential_artifact,
            account_identity=snapshot.account_identity,
            position_classifier_version=snapshot.position_classifier_version,
            auth_checked_at=snapshot.auth_checked_at,
            source=snapshot.source,
            freshness_state=snapshot.freshness_state,
            diagnostics=snapshot.diagnostics,
        )

    def _update_cached_health(
        self,
        *,
        ok: bool,
        message: str,
        command_category: str | None,
        error_classification: str | None,
        diagnostics: BullpenCommandDiagnostics,
    ) -> None:
        self._last_health = BullpenRuntimeCachedHealth(
            ok=ok,
            checked_at=_utc_now_iso(),
            message=redact_secrets(message),
            command_category=command_category,
            error_classification=error_classification,
            cli_version=diagnostics.bullpen_version or self._version_cache_value,
            command_path=_runtime_config().bullpen_bin,
            effective_home=diagnostics.effective_home,
            credential_artifact=diagnostics.credential_artifact,
        )

    def _record_failure(
        self,
        *,
        command_category: str | None,
        classification: str | None,
        message: str,
        diagnostics: BullpenCommandDiagnostics,
    ) -> None:
        sanitized_message = redact_secrets(message)
        self._last_failure = BullpenRuntimeFailure(
            occurred_at=_utc_now_iso(),
            command_category=command_category,
            classification=classification,
            message=sanitized_message,
        )
        self._update_cached_health(
            ok=False,
            message=sanitized_message,
            command_category=command_category,
            error_classification=classification,
            diagnostics=diagnostics,
        )

    async def _cli_version_under_lock(
        self,
        *,
        lock_key: str | None,
        lock_wait_ms: float | None,
    ) -> str | None:
        now = monotonic()
        if self._version_cache_value and now < self._version_cache_expires_at:
            return self._version_cache_value
        result = await self._execute_process(
            ["--version"],
            timeout_seconds=10,
            command_category="version",
            is_write=False,
            requires_auth=False,
            lock_key=lock_key,
            lock_wait_ms=lock_wait_ms,
        )
        version = redact_secrets(result.stdout.strip() or result.stderr.strip())
        self._version_cache_value = version or None
        self._version_cache_expires_at = monotonic() + _CLI_VERSION_TTL_SECONDS
        return self._version_cache_value

    async def execute_json(
        self,
        args: list[str],
        *,
        timeout_seconds: int = _CLI_DEFAULT_TIMEOUT_SECONDS,
        extra_env: dict[str, str] | None = None,
        retry_auth_once: bool = True,
    ) -> Any:
        result = await self.execute_raw(
            args,
            timeout_seconds=timeout_seconds,
            extra_env=extra_env,
            retry_auth_once=retry_auth_once,
        )
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise BullpenRuntimeCommandError(
                "Bullpen command returned invalid JSON.",
                classification="json_parse_error",
                stdout=result.stdout,
                stderr=result.stderr,
                exit_code=result.exit_code,
                signal=result.signal,
            ) from exc

    async def execute_first_json(
        self,
        command_variants: list[list[str]],
        *,
        timeout_seconds: int = _CLI_DEFAULT_TIMEOUT_SECONDS,
        extra_env: dict[str, str] | None = None,
        retry_auth_once: bool = True,
    ) -> Any:
        errors: list[str] = []
        for args in command_variants:
            try:
                return await self.execute_json(
                    args,
                    timeout_seconds=timeout_seconds,
                    extra_env=extra_env,
                    retry_auth_once=retry_auth_once,
                )
            except Exception as exc:
                errors.append(f"{' '.join(args)} => {redact_secrets(str(exc))}")
        raise BullpenRuntimeCommandError(
            "All Bullpen command variants failed: " + " | ".join(errors),
            classification="runtime_error",
        )

    async def execute_raw(
        self,
        args: list[str],
        *,
        timeout_seconds: int = _CLI_DEFAULT_TIMEOUT_SECONDS,
        extra_env: dict[str, str] | None = None,
        retry_auth_once: bool = True,
    ) -> BullpenRawCommandResult:
        category, is_write, requires_auth = _parse_command_category(args)
        sanitized_args = _sanitize_command_args(args, is_write=is_write)
        if not requires_auth:
            return await self._execute_process(
                sanitized_args,
                timeout_seconds=timeout_seconds,
                command_category=category,
                is_write=is_write,
                requires_auth=requires_auth,
                extra_env=extra_env,
            )

        async with self._lock.acquire(
            _AUTHENTICATED_CLI_LOCK_KEY,
            ttl=_AUTHENTICATED_CLI_LOCK_TTL_SECONDS,
            timeout=_AUTHENTICATED_CLI_LOCK_TIMEOUT_SECONDS,
            renew_interval=_LOCK_RENEW_INTERVAL_SECONDS,
        ) as lease:
            result = await self._execute_raw_under_lock(
                sanitized_args,
                timeout_seconds=timeout_seconds,
                command_category=category,
                is_write=is_write,
                requires_auth=requires_auth,
                extra_env=extra_env,
                retry_auth_once=retry_auth_once,
                lock_key=lease.lock_key,
                lock_wait_ms=lease.wait_duration_seconds * 1000,
            )
        result.diagnostics.lock_hold_ms = (
            lease.hold_duration_seconds * 1000
            if lease.hold_duration_seconds is not None
            else result.diagnostics.lock_hold_ms
        )
        return result

    async def _execute_raw_under_lock(
        self,
        args: list[str],
        *,
        timeout_seconds: int,
        command_category: str,
        is_write: bool,
        requires_auth: bool,
        extra_env: dict[str, str] | None,
        retry_auth_once: bool,
        lock_key: str | None,
        lock_wait_ms: float | None,
    ) -> BullpenRawCommandResult:
        initial_credential = _stat_credential_artifact(_runtime_config())
        try:
            return await self._execute_process(
                args,
                timeout_seconds=timeout_seconds,
                command_category=command_category,
                is_write=is_write,
                requires_auth=requires_auth,
                extra_env=extra_env,
                lock_key=lock_key,
                lock_wait_ms=lock_wait_ms,
            )
        except BullpenRuntimeCommandError as exc:
            if not (retry_auth_once and requires_auth and not is_write):
                raise
            if exc.classification != "auth_rejected":
                raise

            auth_cache_key = f"{_REDIS_PREFIX}:auth:ready"
            await self._delete_auth_ready_cache(auth_cache_key)
            current_credential = _stat_credential_artifact(_runtime_config())
            if not _credential_artifact_matches(initial_credential, current_credential):
                logger.info(
                    "Bullpen credential artifact changed before auth refresh retry",
                    extra={
                        "before": initial_credential.model_dump(mode="json"),
                        "after": current_credential.model_dump(mode="json"),
                    },
                )

            await self._refresh_auth_under_lock(
                cache_key=auth_cache_key,
                current_credential=current_credential,
                lease_lock_key=lock_key,
                lease_wait_ms=lock_wait_ms,
            )
            try:
                return await self._execute_process(
                    args,
                    timeout_seconds=timeout_seconds,
                    command_category=command_category,
                    is_write=is_write,
                    requires_auth=requires_auth,
                    extra_env=extra_env,
                    auth_refresh_attempted=True,
                    lock_key=lock_key,
                    lock_wait_ms=lock_wait_ms,
                )
            except BullpenRuntimeCommandError as retry_exc:
                retry_exc.classification = (
                    retry_exc.classification or exc.classification or "auth_rejected"
                )
                raise retry_exc from exc

    async def get_positions_snapshot(
        self,
        *,
        force_fresh: bool = False,
        max_age_seconds: int = _POSITIONS_FRESH_SECONDS,
        timeout_seconds: int = _CLI_DEFAULT_TIMEOUT_SECONDS,
    ) -> BullpenPositionsSnapshot:
        cache_key = f"{_REDIS_PREFIX}:positions:snapshot"
        cached = await self._read_valid_positions_snapshot(cache_key)
        if cached and not force_fresh and self._snapshot_is_fresh(cached, max_age_seconds):
            cached.source = "redis-cache"
            cached.freshness_state = "cached"
            cached.diagnostics.cache_status = "hit"
            return cached

        loop = asyncio.get_running_loop()
        existing_future = self._positions_futures.get(loop)
        if existing_future and not existing_future.done():
            return await asyncio.shield(existing_future)

        creator = loop.create_future()
        self._positions_futures[loop] = creator
        try:
            snapshot = await self._refresh_positions_snapshot(
                cache_key=cache_key,
                force_fresh=force_fresh,
                max_age_seconds=max_age_seconds,
                timeout_seconds=timeout_seconds,
            )
            creator.set_result(snapshot)
            return snapshot
        except Exception as exc:
            creator.set_exception(exc)
            raise
        finally:
            self._positions_futures.pop(loop, None)

    async def _refresh_positions_snapshot(
        self,
        *,
        cache_key: str,
        force_fresh: bool,
        max_age_seconds: int,
        timeout_seconds: int,
    ) -> BullpenPositionsSnapshot:
        cached = await self._read_valid_positions_snapshot(cache_key)
        if cached and not force_fresh and self._snapshot_is_fresh(cached, max_age_seconds):
            cached.source = "redis-cache"
            cached.freshness_state = "cached"
            cached.diagnostics.cache_status = "hit"
            return cached

        try:
            async with self._lock.acquire(
                f"{_REDIS_PREFIX}:positions-refresh",
                ttl=_POSITIONS_LOCK_TTL_SECONDS,
                timeout=_POSITIONS_LOCK_TIMEOUT_SECONDS,
            ) as lease:
                cached = await self._read_valid_positions_snapshot(cache_key)
                if cached and not force_fresh and self._snapshot_is_fresh(
                    cached, max_age_seconds
                ):
                    cached.source = "redis-cache"
                    cached.freshness_state = "cached"
                    cached.diagnostics.cache_status = "hit"
                    return cached

                async with self._lock.acquire(
                    _AUTHENTICATED_CLI_LOCK_KEY,
                    ttl=_AUTHENTICATED_CLI_LOCK_TTL_SECONDS,
                    timeout=_AUTHENTICATED_CLI_LOCK_TIMEOUT_SECONDS,
                    renew_interval=_LOCK_RENEW_INTERVAL_SECONDS,
                ) as auth_lease:
                    auth_checked_at = await self.ensure_auth_ready_under_lock(
                        force_refresh=False,
                        cache_key=f"{_REDIS_PREFIX}:auth:ready",
                        lock_key=auth_lease.lock_key,
                        lock_wait_ms=auth_lease.wait_duration_seconds * 1000,
                    )
                    result = await self._execute_raw_under_lock(
                        ["polymarket", "positions", "--output", "json"],
                        timeout_seconds=timeout_seconds,
                        command_category="positions",
                        is_write=False,
                        requires_auth=True,
                        extra_env=None,
                        retry_auth_once=True,
                        lock_key=auth_lease.lock_key,
                        lock_wait_ms=auth_lease.wait_duration_seconds * 1000,
                    )
                try:
                    payload = json.loads(result.stdout)
                except json.JSONDecodeError as exc:
                    raise BullpenRuntimeCommandError(
                        "Bullpen positions returned invalid JSON.",
                        classification="json_parse_error",
                        stdout=result.stdout,
                        stderr=result.stderr,
                        exit_code=result.exit_code,
                        signal=result.signal,
                    ) from exc
                auth_cache = await self._read_auth_ready_cache(
                    f"{_REDIS_PREFIX}:auth:ready"
                )
                snapshot = BullpenPositionsSnapshot(
                    payload=payload,
                    fetched_at=_utc_now_iso(),
                    cli_version=result.diagnostics.bullpen_version
                    or self._version_cache_value,
                    credential_artifact=result.diagnostics.credential_artifact,
                    account_identity=(
                        _extract_account_identity(payload)
                        or (
                            auth_cache.account_identity
                            if auth_cache is not None
                            else None
                        )
                    ),
                    position_classifier_version=BULLPEN_POSITION_CLASSIFIER_VERSION,
                    auth_checked_at=auth_checked_at,
                    source="live-cli",
                    freshness_state="fresh",
                    diagnostics=result.diagnostics.model_copy(
                        update={
                            "command_category": "positions",
                            "cache_status": "miss",
                        }
                    ),
                )
                await self._redis.set(
                    cache_key,
                    snapshot.model_dump_json(),
                    ex=_POSITIONS_SNAPSHOT_TTL_SECONDS,
                )
            snapshot.diagnostics.lock_hold_ms = (
                lease.hold_duration_seconds * 1000
                if lease.hold_duration_seconds is not None
                else snapshot.diagnostics.lock_hold_ms
            )
            return snapshot
        except LockAcquisitionError as exc:
            waited = await self._poll_for_positions_snapshot(
                cache_key=cache_key,
                max_age_seconds=max_age_seconds,
                timeout_seconds=_POSITIONS_LOCK_TIMEOUT_SECONDS,
            )
            if waited is not None and self._snapshot_is_fresh(waited, max_age_seconds):
                waited.source = "redis-cache"
                waited.freshness_state = "cached"
                waited.diagnostics.cache_status = "hit"
                return waited
            raise BullpenRuntimeCommandError(
                f"Timed out waiting for Bullpen positions refresh: {redact_secrets(str(exc))}",
                classification="lock_timeout",
            ) from exc

    async def _execute_process(
        self,
        args: list[str],
        *,
        timeout_seconds: int,
        command_category: str,
        is_write: bool,
        requires_auth: bool,
        extra_env: dict[str, str] | None = None,
        auth_refresh_attempted: bool = False,
        lock_key: str | None = None,
        lock_wait_ms: float | None = None,
    ) -> BullpenRawCommandResult:
        config = _runtime_config()
        diagnostics = BullpenCommandDiagnostics(
            command_category=command_category,
            pid=os.getpid(),
            unix_user=config.effective_user,
            effective_home=config.home,
            bullpen_version=self._version_cache_value,
            credential_artifact=_stat_credential_artifact(config),
            lock_key=lock_key,
            lock_wait_ms=lock_wait_ms,
            auth_refresh_attempted=auth_refresh_attempted,
        )
        env = {
            **os.environ,
            "HOME": config.home,
            "BULLPEN_BIN": config.bullpen_bin,
            "BULLPEN_HOME": config.bullpen_home,
            "BULLPEN_CONFIG": config.bullpen_config,
            "BULLPEN_ENV": config.bullpen_env,
            "BULLPEN_CREDENTIALS_HOME": config.bullpen_home,
            "BULLPEN_NON_INTERACTIVE": "true",
        }
        if extra_env:
            env.update(extra_env)

        started_at = monotonic()
        try:
            process = await asyncio.create_subprocess_exec(
                config.bullpen_bin,
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                limit=_MAX_BUFFER_BYTES,
            )
        except FileNotFoundError as exc:
            diagnostics.error_classification = "missing_runtime"
            self._record_failure(
                command_category=command_category,
                classification="missing_runtime",
                message=f"Bullpen CLI executable was not found: `{config.bullpen_bin}`.",
                diagnostics=diagnostics,
            )
            self._log_runtime_event(diagnostics, success=False)
            raise BullpenRuntimeCommandError(
                f"Bullpen CLI executable was not found: `{config.bullpen_bin}`.",
                classification="missing_runtime",
            ) from exc

        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=timeout_seconds
            )
        except asyncio.TimeoutError as exc:
            process.kill()
            await process.communicate()
            diagnostics.error_classification = "timeout"
            diagnostics.lock_hold_ms = (monotonic() - started_at) * 1000
            self._record_failure(
                command_category=command_category,
                classification="timeout",
                message=f"Bullpen command timed out after {timeout_seconds}s.",
                diagnostics=diagnostics,
            )
            self._log_runtime_event(diagnostics, success=False)
            raise BullpenRuntimeCommandError(
                f"Bullpen command timed out after {timeout_seconds}s.",
                classification="timeout",
            ) from exc

        stdout_text = stdout.decode("utf-8", errors="replace").strip()
        stderr_text = stderr.decode("utf-8", errors="replace").strip()
        if diagnostics.lock_key is not None:
            diagnostics.lock_hold_ms = (monotonic() - started_at) * 1000

        if process.returncode != 0:
            message = redact_secrets(
                stderr_text
                or stdout_text
                or f"Bullpen command exited with code {process.returncode}."
            )
            classification = _classify_runtime_error(message)
            diagnostics.error_classification = classification
            self._record_failure(
                command_category=command_category,
                classification=classification,
                message=message,
                diagnostics=diagnostics,
            )
            self._log_runtime_event(diagnostics, success=False)
            raise BullpenRuntimeCommandError(
                message,
                classification=classification,
                stdout=stdout_text,
                stderr=stderr_text,
                exit_code=process.returncode,
                signal=process.returncode if process.returncode < 0 else None,
            )

        if command_category == "version":
            version = redact_secrets(stdout_text or stderr_text)
            self._version_cache_value = version or None
            self._version_cache_expires_at = monotonic() + _CLI_VERSION_TTL_SECONDS
            diagnostics.bullpen_version = self._version_cache_value
        else:
            diagnostics.bullpen_version = self._version_cache_value

        self._update_cached_health(
            ok=True,
            message=f"Bullpen command `{command_category}` completed.",
            command_category=command_category,
            error_classification=None,
            diagnostics=diagnostics,
        )
        self._log_runtime_event(diagnostics, success=True)
        return BullpenRawCommandResult(
            stdout=stdout_text,
            stderr=stderr_text,
            exit_code=process.returncode,
            signal=None,
            diagnostics=diagnostics,
        )

    async def _refresh_auth_under_lock(
        self,
        *,
        cache_key: str,
        current_credential: BullpenCredentialArtifact,
        lease_lock_key: str | None,
        lease_wait_ms: float | None,
    ) -> str:
        result = await self._execute_process(
            ["doctor", "auth", "--refresh", "--output", "json"],
            timeout_seconds=20,
            command_category="doctor-auth-refresh",
            is_write=False,
            requires_auth=True,
            auth_refresh_attempted=True,
            lock_key=lease_lock_key,
            lock_wait_ms=lease_wait_ms,
        )
        try:
            payload = json.loads(result.stdout or "{}")
        except json.JSONDecodeError as exc:
            error = BullpenRuntimeCommandError(
                "Bullpen auth refresh returned invalid JSON.",
                classification="json_parse_error",
                stdout=result.stdout,
                stderr=result.stderr,
                exit_code=result.exit_code,
                signal=result.signal,
            )
            self._record_failure(
                command_category="doctor-auth-refresh",
                classification=error.classification,
                message=str(error),
                diagnostics=result.diagnostics,
            )
            raise error from exc

        try:
            checked_at = _validate_auth_refresh_payload(payload)
        except BullpenRuntimeCommandError as exc:
            self._record_failure(
                command_category="doctor-auth-refresh",
                classification=exc.classification,
                message=str(exc),
                diagnostics=result.diagnostics,
            )
            raise

        account_identity = _extract_account_identity(payload)
        final_credential = _stat_credential_artifact(_runtime_config())
        await self._write_auth_ready_cache(
            cache_key=cache_key,
            checked_at=checked_at,
            credential_artifact=(
                final_credential
                if final_credential.path is not None
                else current_credential
            ),
            account_identity=account_identity,
        )
        self._last_auth_checked_at = checked_at
        return checked_at

    async def _read_positions_snapshot(
        self, cache_key: str
    ) -> BullpenPositionsSnapshot | None:
        raw = await self._redis.get(cache_key)
        if not raw:
            return None
        try:
            return BullpenPositionsSnapshot.model_validate_json(raw)
        except Exception:
            return None

    async def _read_valid_positions_snapshot(
        self, cache_key: str
    ) -> BullpenPositionsSnapshot | None:
        snapshot = await self._read_positions_snapshot(cache_key)
        if snapshot is None:
            return None
        current_credential = _stat_credential_artifact(_runtime_config())
        auth_cache = await self._read_auth_ready_cache(f"{_REDIS_PREFIX}:auth:ready")
        if _snapshot_matches_runtime(
            snapshot,
            current_credential=current_credential,
            auth_cache=auth_cache,
        ):
            return snapshot
        await self._redis.delete(cache_key)
        return None

    async def read_cached_positions_snapshot(self) -> BullpenPositionsSnapshot | None:
        return await self._read_valid_positions_snapshot(
            f"{_REDIS_PREFIX}:positions:snapshot"
        )

    def _snapshot_is_fresh(
        self, snapshot: BullpenPositionsSnapshot, max_age_seconds: int
    ) -> bool:
        from datetime import UTC, datetime

        try:
            fetched_at = datetime.fromisoformat(snapshot.fetched_at)
        except ValueError:
            return False
        if fetched_at.tzinfo is None:
            fetched_at = fetched_at.replace(tzinfo=UTC)
        return (datetime.now(UTC) - fetched_at).total_seconds() <= max_age_seconds

    async def _poll_for_positions_snapshot(
        self,
        *,
        cache_key: str,
        max_age_seconds: int,
        timeout_seconds: int,
    ) -> BullpenPositionsSnapshot | None:
        deadline = monotonic() + timeout_seconds
        while monotonic() < deadline:
            snapshot = await self._read_valid_positions_snapshot(cache_key)
            if snapshot and self._snapshot_is_fresh(snapshot, max_age_seconds):
                return snapshot
            await asyncio.sleep(_POLL_INTERVAL_SECONDS)
        return await self._read_valid_positions_snapshot(cache_key)

    def _log_runtime_event(
        self, diagnostics: BullpenCommandDiagnostics, *, success: bool
    ) -> None:
        payload = diagnostics.model_dump(mode="json")
        if success:
            logger.info("Bullpen runtime command completed: %s", payload)
            return
        logger.warning("Bullpen runtime command failed: %s", payload)


_runtime_broker: BullpenRuntimeBroker | None = None
_runtime_broker_loop: asyncio.AbstractEventLoop | None = None


def get_bullpen_runtime_broker() -> BullpenRuntimeBroker:
    global _runtime_broker, _runtime_broker_loop
    current_loop = _running_loop_or_none()
    if (
        _runtime_broker is None
        or (
            current_loop is not None
            and _runtime_broker_loop is not None
            and _runtime_broker_loop is not current_loop
        )
    ):
        _runtime_broker = BullpenRuntimeBroker()
        _runtime_broker_loop = current_loop
    elif current_loop is not None and _runtime_broker_loop is None:
        _runtime_broker_loop = current_loop
    return _runtime_broker


async def close_bullpen_runtime_broker() -> None:
    global _runtime_broker, _runtime_broker_loop
    if _runtime_broker is None:
        return
    await _runtime_broker.aclose()
    _runtime_broker = None
    _runtime_broker_loop = None


def run_with_bullpen_runtime_cleanup(awaitable: Awaitable[_T]) -> _T:
    async def runner() -> _T:
        try:
            return await awaitable
        finally:
            await close_bullpen_runtime_broker()

    return asyncio.run(runner())
