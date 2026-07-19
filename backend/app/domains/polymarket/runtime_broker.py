from __future__ import annotations

import asyncio
import json
import os
import pwd
import stat
from pathlib import Path
from time import monotonic
from typing import Any, Literal

import redis.asyncio as aioredis
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.logging import get_logger
from app.domains.polymarket.logger import redact_secrets
from app.infrastructure.locks.redis_lock import LockAcquisitionError, RedisLock

logger = get_logger(__name__)

_DEFAULT_BULLPEN_BIN = "/usr/local/bin/bullpen"
_DEFAULT_HOME = "/home/investor"
_DEFAULT_BULLPEN_HOME = "/home/investor/.bullpen"
_DEFAULT_BULLPEN_CONFIG = "/home/investor/.bullpen/config.toml"
_DEFAULT_BULLPEN_ENV = "production"
_AUTH_READY_TTL_SECONDS = 60
_CLI_VERSION_TTL_SECONDS = 300
_POSITIONS_SNAPSHOT_TTL_SECONDS = 300
_POSITIONS_FRESH_SECONDS = 20
_POSITIONS_LOCK_TTL_SECONDS = 45
_POSITIONS_LOCK_TIMEOUT_SECONDS = 12
_AUTH_LOCK_TTL_SECONDS = 25
_AUTH_LOCK_TIMEOUT_SECONDS = 8
_CLI_DEFAULT_TIMEOUT_SECONDS = 30
_POLL_INTERVAL_SECONDS = 0.1
_MAX_BUFFER_BYTES = 10 * 1024 * 1024
_REDIS_PREFIX = "bullpen:runtime"
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


def _utc_now_iso() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat()


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
    config_path = Path(config.bullpen_config)
    candidates = [
        Path(os.getenv("BULLPEN_AUTH_FILE", "")).expanduser()
        if os.getenv("BULLPEN_AUTH_FILE")
        else None,
        config_path,
        home / "auth.json",
        home / "session.json",
        home / "tokens.json",
        home / "credentials.json",
        home / ".auth.json",
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


class BullpenRuntimeBroker:
    def __init__(self) -> None:
        self._redis = aioredis.from_url(settings.redis_url, decode_responses=True)
        self._lock = RedisLock(self._redis)
        self._positions_futures: dict[asyncio.AbstractEventLoop, asyncio.Future] = {}
        self._version_cache_value: str | None = None
        self._version_cache_expires_at: float = 0.0

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
        return config

    async def cli_version(self) -> str | None:
        now = monotonic()
        if self._version_cache_value and now < self._version_cache_expires_at:
            return self._version_cache_value
        try:
            result = await self._execute_process(
                ["--version"],
                timeout_seconds=10,
                command_category="version",
                is_write=False,
                requires_auth=False,
            )
        except BullpenRuntimeCommandError:
            return None
        version = redact_secrets(result.stdout.strip() or result.stderr.strip())
        self._version_cache_value = version or None
        self._version_cache_expires_at = now + _CLI_VERSION_TTL_SECONDS
        return self._version_cache_value

    async def ensure_auth_ready(self, *, force_refresh: bool = False) -> str:
        cache_key = f"{_REDIS_PREFIX}:auth:ready"
        if not force_refresh:
            cached = await self._redis.get(cache_key)
            if cached:
                return cached

        async with self._lock.acquire(
            f"{_REDIS_PREFIX}:auth-refresh",
            ttl=_AUTH_LOCK_TTL_SECONDS,
            timeout=_AUTH_LOCK_TIMEOUT_SECONDS,
        ) as lease:
            if not force_refresh:
                cached = await self._redis.get(cache_key)
                if cached:
                    return cached

            checked_at = await self._refresh_auth_under_lock(
                cache_key=cache_key,
                lease_lock_key=lease.lock_key,
                lease_wait_ms=lease.wait_duration_seconds * 1000,
            )

        return checked_at

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
        observed_credential = _stat_credential_artifact(_runtime_config())
        auth_refresh_attempted = False
        try:
            return await self._execute_process(
                sanitized_args,
                timeout_seconds=timeout_seconds,
                command_category=category,
                is_write=is_write,
                requires_auth=requires_auth,
                extra_env=extra_env,
            )
        except BullpenRuntimeCommandError as exc:
            if not (retry_auth_once and requires_auth and not is_write):
                raise
            if exc.classification != "auth_rejected":
                raise

            async with self._lock.acquire(
                f"{_REDIS_PREFIX}:auth-refresh",
                ttl=_AUTH_LOCK_TTL_SECONDS,
                timeout=_AUTH_LOCK_TIMEOUT_SECONDS,
            ) as lease:
                auth_cache_key = f"{_REDIS_PREFIX}:auth:ready"
                current_credential = _stat_credential_artifact(_runtime_config())
                auth_ready_cached = await self._redis.get(auth_cache_key)
                if (
                    observed_credential.inode == current_credential.inode
                    and observed_credential.mtime == current_credential.mtime
                    and not auth_ready_cached
                ):
                    auth_refresh_attempted = True
                    await self._refresh_auth_under_lock(
                        cache_key=auth_cache_key,
                        lease_lock_key=lease.lock_key,
                        lease_wait_ms=lease.wait_duration_seconds * 1000,
                    )

                try:
                    retry_result = await self._execute_process(
                        sanitized_args,
                        timeout_seconds=timeout_seconds,
                        command_category=category,
                        is_write=is_write,
                        requires_auth=requires_auth,
                        extra_env=extra_env,
                        auth_refresh_attempted=auth_refresh_attempted,
                        lock_key=lease.lock_key,
                        lock_wait_ms=lease.wait_duration_seconds * 1000,
                    )
                except BullpenRuntimeCommandError as retry_exc:
                    retry_exc.classification = retry_exc.classification or "auth_rejected"
                    raise retry_exc from exc

            retry_result.diagnostics.lock_hold_ms = (
                lease.hold_duration_seconds * 1000
                if lease.hold_duration_seconds is not None
                else retry_result.diagnostics.lock_hold_ms
            )
            return retry_result

    async def get_positions_snapshot(
        self,
        *,
        force_fresh: bool = False,
        max_age_seconds: int = _POSITIONS_FRESH_SECONDS,
        timeout_seconds: int = _CLI_DEFAULT_TIMEOUT_SECONDS,
    ) -> BullpenPositionsSnapshot:
        cache_key = f"{_REDIS_PREFIX}:positions:snapshot"
        cached = await self._read_positions_snapshot(cache_key)
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
        cached = await self._read_positions_snapshot(cache_key)
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
                cached = await self._read_positions_snapshot(cache_key)
                if cached and not force_fresh and self._snapshot_is_fresh(
                    cached, max_age_seconds
                ):
                    cached.source = "redis-cache"
                    cached.freshness_state = "cached"
                    cached.diagnostics.cache_status = "hit"
                    return cached

                auth_checked_at = await self.ensure_auth_ready(force_refresh=False)
                result = await self.execute_raw(
                    ["polymarket", "positions", "--output", "json"],
                    timeout_seconds=timeout_seconds,
                    retry_auth_once=True,
                )
                payload = json.loads(result.stdout)
                snapshot = BullpenPositionsSnapshot(
                    payload=payload,
                    fetched_at=_utc_now_iso(),
                    cli_version=await self.cli_version(),
                    credential_artifact=result.diagnostics.credential_artifact,
                    auth_checked_at=auth_checked_at,
                    source="live-cli",
                    freshness_state="fresh",
                    diagnostics=result.diagnostics.model_copy(
                        update={
                            "command_category": "positions",
                            "cache_status": "miss",
                            "lock_key": lease.lock_key,
                            "lock_wait_ms": lease.wait_duration_seconds * 1000,
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
            if waited is not None:
                waited.source = "redis-cache"
                waited.freshness_state = (
                    "cached"
                    if self._snapshot_is_fresh(waited, max_age_seconds)
                    else "stale"
                )
                waited.diagnostics.cache_status = (
                    "hit" if waited.freshness_state == "cached" else "stale"
                )
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
            self._log_runtime_event(diagnostics, success=False)
            raise BullpenRuntimeCommandError(
                f"Bullpen command timed out after {timeout_seconds}s.",
                classification="timeout",
            ) from exc

        stdout_text = stdout.decode("utf-8", errors="replace").strip()
        stderr_text = stderr.decode("utf-8", errors="replace").strip()
        if command_category != "version":
            diagnostics.bullpen_version = (
                diagnostics.bullpen_version or await self.cli_version()
            )
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
            self._log_runtime_event(diagnostics, success=False)
            raise BullpenRuntimeCommandError(
                message,
                classification=classification,
                stdout=stdout_text,
                stderr=stderr_text,
                exit_code=process.returncode,
                signal=process.returncode if process.returncode < 0 else None,
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
            raise BullpenRuntimeCommandError(
                "Bullpen auth refresh returned invalid JSON.",
                classification="json_parse_error",
                stdout=result.stdout,
                stderr=result.stderr,
                exit_code=result.exit_code,
                signal=result.signal,
            ) from exc

        failure = _looks_like_auth_refresh_failure(payload)
        if failure:
            raise BullpenRuntimeCommandError(
                failure,
                classification="auth_rejected",
                stdout=result.stdout,
                stderr=result.stderr,
                exit_code=result.exit_code,
                signal=result.signal,
            )

        checked_at = _extract_auth_ready_timestamp(payload) or _utc_now_iso()
        await self._redis.set(cache_key, checked_at, ex=_AUTH_READY_TTL_SECONDS)
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

    async def read_cached_positions_snapshot(self) -> BullpenPositionsSnapshot | None:
        return await self._read_positions_snapshot(f"{_REDIS_PREFIX}:positions:snapshot")

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
            snapshot = await self._read_positions_snapshot(cache_key)
            if snapshot and self._snapshot_is_fresh(snapshot, max_age_seconds):
                return snapshot
            await asyncio.sleep(_POLL_INTERVAL_SECONDS)
        return await self._read_positions_snapshot(cache_key)

    def _log_runtime_event(
        self, diagnostics: BullpenCommandDiagnostics, *, success: bool
    ) -> None:
        payload = diagnostics.model_dump(mode="json")
        if success:
            logger.info("Bullpen runtime command completed: %s", payload)
            return
        logger.warning("Bullpen runtime command failed: %s", payload)


_runtime_broker: BullpenRuntimeBroker | None = None


def get_bullpen_runtime_broker() -> BullpenRuntimeBroker:
    global _runtime_broker
    if _runtime_broker is None:
        _runtime_broker = BullpenRuntimeBroker()
    return _runtime_broker


async def close_bullpen_runtime_broker() -> None:
    global _runtime_broker
    if _runtime_broker is None:
        return
    await _runtime_broker.aclose()
    _runtime_broker = None
