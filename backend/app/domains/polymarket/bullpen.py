from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
import pwd
import re
import shutil
from collections.abc import Iterable

from app.domains.polymarket.logger import redact_secrets
from app.domains.polymarket.schemas import (
    PolymarketBalanceState,
    PolymarketBullpenRedeemedTrade,
    PolymarketBotConfig,
    PolymarketDoctorStatus,
    PolymarketLiveTradeDecision,
    PolymarketPosition,
    PolymarketSourceTrade,
)


class BullpenCommandError(RuntimeError):
    pass


def is_redeem_metadata_lookup_warning(message: str) -> bool:
    normalized = message.lower()
    return (
        "payoutdenominator preflight rpc failed" in normalized
        and "market not found in gamma for condition" in normalized
    )


def is_claim_command_unavailable_warning(message: str) -> bool:
    normalized = message.lower()
    return (
        any(
            marker in normalized
            for marker in (
                "unrecognized subcommand",
                "unknown command",
                "no such command",
                "invalid subcommand",
            )
        )
        and "claim" in normalized
    )


BULLPEN_REDEEM_TIMEOUT_SECONDS = 180
BULLPEN_BALANCE_TIMEOUT_SECONDS = 8
DEFAULT_BULLPEN_BUY_MAX_PRICE_BUFFER = 0.10
DEFAULT_BULLPEN_BUY_MIN_PRICE_BUFFER = 0.02
DEFAULT_BULLPEN_BUY_RETRY_PRICE_BUFFER = 0.02
DEFAULT_BULLPEN_BUY_MAX_PRICE_RETRIES = 3
DEFAULT_BULLPEN_SELL_MIN_PRICE_BUFFER = 0.05
MIN_POLYMARKET_LIMIT_PRICE = 0.01
MAX_POLYMARKET_LIMIT_PRICE = 0.99
BULLPEN_MAX_PRICE_ERROR_PATTERN = re.compile(
    r"Fill price \$?(?P<fill_price>\d+(?:\.\d+)?) exceeds maximum acceptable price \$?(?P<max_price>\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
BULLPEN_INSUFFICIENT_COLLATERAL_PATTERN = re.compile(
    r"Insufficient collateral to place this order \(?(?P<needed>\d+(?:\.\d+)?)\s*pUSD needed",
    re.IGNORECASE,
)

BULLPEN_JWT_EXPIRES_PATTERN = re.compile(
    r"JWT expires:\s*(?P<expires>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC",
    re.IGNORECASE,
)
BULLPEN_JWT_OBSERVED_PATTERN = re.compile(
    r"JWT observed:\s*(?P<observed>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC",
    re.IGNORECASE,
)


def _parse_bullpen_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def parse_bullpen_session(
    stdout: str, *, now: datetime | None = None
) -> dict[str, object]:
    now = now or datetime.now(timezone.utc)
    expires_match = BULLPEN_JWT_EXPIRES_PATTERN.search(stdout)
    observed_match = BULLPEN_JWT_OBSERVED_PATTERN.search(stdout)
    expires_at = _parse_bullpen_utc(
        expires_match.group("expires") if expires_match else None
    )
    observed_at = _parse_bullpen_utc(
        observed_match.group("observed") if observed_match else None
    )
    seconds_remaining = (
        max(0, int((expires_at - now).total_seconds())) if expires_at else None
    )
    return {
        "bullpen_login_observed_at": observed_at.isoformat() if observed_at else None,
        "bullpen_jwt_expires_at": expires_at.isoformat() if expires_at else None,
        "bullpen_jwt_seconds_remaining": seconds_remaining,
    }


BULLPEN_RUNTIME_RELATIVE_PATHS = (
    (".runtime-tools", "bullpen"),
    ("runtime-tools", "bullpen"),
)


def _unique_paths(paths: Iterable[str | None]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for path in paths:
        if not path or path in seen:
            continue
        seen.add(path)
        unique.append(path)
    return unique


def _float_from_env(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _clamp_limit_price(price: float) -> float:
    return max(MIN_POLYMARKET_LIMIT_PRICE, min(MAX_POLYMARKET_LIMIT_PRICE, price))


def buy_max_price_for_execution(price: float) -> float:
    configured_buffer = max(
        0.0,
        _float_from_env(
            "BULLPEN_BUY_MAX_PRICE_BUFFER", DEFAULT_BULLPEN_BUY_MAX_PRICE_BUFFER
        ),
    )
    minimum_buffer = max(
        0.0,
        _float_from_env(
            "BULLPEN_BUY_MIN_PRICE_BUFFER", DEFAULT_BULLPEN_BUY_MIN_PRICE_BUFFER
        ),
    )
    return _clamp_limit_price(price + max(configured_buffer, minimum_buffer))


def buy_retry_max_price_for_execution(fill_price: float) -> float:
    retry_buffer = max(
        0.0,
        _float_from_env(
            "BULLPEN_BUY_RETRY_PRICE_BUFFER",
            DEFAULT_BULLPEN_BUY_RETRY_PRICE_BUFFER,
        ),
    )
    return _clamp_limit_price(fill_price + retry_buffer)


def buy_max_price_retry_attempts() -> int:
    return max(
        1,
        int(
            _float_from_env(
                "BULLPEN_BUY_MAX_PRICE_RETRIES",
                DEFAULT_BULLPEN_BUY_MAX_PRICE_RETRIES,
            )
        ),
    )


def extract_bullpen_buy_fill_price_error(message: str) -> float | None:
    match = BULLPEN_MAX_PRICE_ERROR_PATTERN.search(message)
    if not match:
        return None
    try:
        return float(match.group("fill_price"))
    except (TypeError, ValueError):
        return None


def extract_bullpen_insufficient_collateral_amount(message: str) -> float | None:
    match = BULLPEN_INSUFFICIENT_COLLATERAL_PATTERN.search(message)
    if not match:
        return None
    try:
        return float(match.group("needed"))
    except (TypeError, ValueError):
        return None


def sell_min_price_for_execution(price: float) -> float:
    buffer = max(
        0.0,
        _float_from_env(
            "BULLPEN_SELL_MIN_PRICE_BUFFER", DEFAULT_BULLPEN_SELL_MIN_PRICE_BUFFER
        ),
    )
    return _clamp_limit_price(price - buffer)


def bullpen_candidate_paths() -> list[str]:
    runtime_roots = _unique_paths(
        [
            os.getcwd(),
            os.getenv("APP_ROOT"),
            os.getenv("BACKEND_ROOT"),
            "/srv/investor/backend",
            "/backend",
        ]
    )
    runtime_tool_paths = [
        os.path.join(root, *relative_path)
        for root in runtime_roots
        for relative_path in BULLPEN_RUNTIME_RELATIVE_PATHS
    ]

    return _unique_paths(
        [
            os.getenv("BULLPEN_BIN"),
            *runtime_tool_paths,
            shutil.which("bullpen"),
            os.path.expanduser("~/.bullpen/bin/bullpen"),
            "/home/appuser/.bullpen/bin/bullpen",
            "/home/investor/.bullpen/bin/bullpen",
            "/opt/homebrew/bin/bullpen",
            "/usr/local/bin/bullpen",
        ]
    )


def _configured_bullpen_home() -> str | None:
    configured_home = os.getenv("BULLPEN_HOME") or os.getenv("BULLPEN_CREDENTIALS_HOME")
    if configured_home:
        return os.path.expanduser(configured_home)
    return None


def _service_user_home() -> str | None:
    try:
        return pwd.getpwuid(os.getuid()).pw_dir
    except (KeyError, OSError):
        return None


def bullpen_process_env(*, read_only: bool) -> dict[str, str]:
    env = os.environ.copy()
    configured_home = _configured_bullpen_home()
    service_home = _service_user_home()
    if configured_home:
        env["HOME"] = configured_home
    elif service_home and (not env.get("HOME") or env.get("HOME") == "/root"):
        env["HOME"] = service_home
    if read_only:
        env["BULLPEN_READ_ONLY"] = "true"
        env["BULLPEN_NON_INTERACTIVE"] = "true"
    return env


def _bullpen_install_hint() -> str:
    attempted = ", ".join(bullpen_candidate_paths())
    return (
        "Bullpen CLI executable was not found. Install Bullpen in the backend runtime, "
        "place it at <backend>/.runtime-tools/bullpen, <backend>/runtime-tools/bullpen, "
        "/opt/homebrew/bin/bullpen, /usr/local/bin/bullpen, ~/.bullpen/bin/bullpen, "
        "or set BULLPEN_BIN to an executable path. "
        f"Checked: {attempted}"
    )


def bullpen_executable() -> str:
    for candidate in bullpen_candidate_paths():
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate

    return os.getenv("BULLPEN_BIN") or "bullpen"


async def run_bullpen(
    args: list[str],
    *,
    timeout_seconds: int,
    read_only: bool,
) -> str:
    env = bullpen_process_env(read_only=read_only)

    try:
        process = await asyncio.create_subprocess_exec(
            bullpen_executable(),
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
    except FileNotFoundError as exc:
        raise BullpenCommandError(_bullpen_install_hint()) from exc
    except PermissionError as exc:
        raise BullpenCommandError(
            f"Bullpen CLI executable is not runnable: {redact_secrets(str(exc))}. "
            "Verify BULLPEN_BIN points to an executable file owned/readable by the backend service user."
        ) from exc

    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(), timeout=timeout_seconds
        )
    except asyncio.TimeoutError as exc:
        process.kill()
        await process.communicate()
        raise BullpenCommandError(
            f"Command timed out after {timeout_seconds}s"
        ) from exc

    stdout_text = stdout.decode("utf-8", errors="replace").strip()
    stderr_text = stderr.decode("utf-8", errors="replace").strip()
    if process.returncode != 0:
        message = (
            stderr_text
            or stdout_text
            or f"Command exited with code {process.returncode}"
        )
        raise BullpenCommandError(redact_secrets(message))
    return stdout_text


async def run_bullpen_json(args: list[str], *, timeout_seconds: int = 20) -> object:
    stdout = await run_bullpen(args, timeout_seconds=timeout_seconds, read_only=True)
    return json.loads(stdout)


async def run_first_bullpen_json(
    command_variants: Iterable[list[str]], *, timeout_seconds: int = 20
) -> object:
    errors: list[str] = []
    for args in command_variants:
        try:
            return await run_bullpen_json(args, timeout_seconds=timeout_seconds)
        except Exception as exc:
            errors.append(f"{' '.join(args)} => {redact_secrets(str(exc))}")
    raise BullpenCommandError(
        "All Bullpen command variants failed: " + " | ".join(errors)
    )


def _has_active_bullpen_session(session: dict[str, object]) -> bool:
    seconds_remaining = session.get("bullpen_jwt_seconds_remaining")
    return isinstance(seconds_remaining, int) and seconds_remaining > 0


def _is_refresh_token_rejected_error(message: str) -> bool:
    lowered = message.lower()
    return (
        "refresh token rejected" in lowered
        or "invalid refresh token" in lowered
        or "session expired" in lowered
    )


class BullpenLiveExecutor:
    async def doctor(self) -> PolymarketDoctorStatus:
        checked_at = utc_now()
        checks = [
            (["status"], True, "status"),
            (["polymarket", "preflight"], False, "preflight"),
        ]
        session: dict[str, object] = {}
        failures: list[str] = []
        passed: list[str] = []
        for args, read_only, label in checks:
            try:
                stdout = await run_bullpen(
                    args, timeout_seconds=45, read_only=read_only
                )
                if label == "status":
                    session = parse_bullpen_session(stdout)
                passed.append(label)
            except Exception as exc:
                failures.append(f"{label}: {redact_secrets(str(exc))}")
        if not failures:
            return PolymarketDoctorStatus(
                checked_at=checked_at,
                ok=True,
                message="Bullpen status and preflight checks passed.",
                **session,
            )
        failure_message = "; ".join(failures)
        if (
            "status" in passed
            and _has_active_bullpen_session(session)
            and _is_refresh_token_rejected_error(failure_message)
        ):
            return PolymarketDoctorStatus(
                checked_at=checked_at,
                ok=True,
                message=(
                    "Bullpen status passed with an active JWT; preflight reported a "
                    "stale refresh-token error after login, so status is being "
                    "used as the auth source of truth. Preflight detail: "
                    f"{failure_message}"
                ),
                **session,
            )
        return PolymarketDoctorStatus(
            checked_at=checked_at,
            ok=False,
            message=f"Bullpen doctor failed after {', '.join(passed) or 'no'} passed checks: {failure_message}",
            **session,
        )

    async def redeem(
        self,
        *,
        dry_run: bool,
        condition_ids: list[str] | None = None,
    ) -> str:
        args = ["polymarket", "redeem"]
        if condition_ids:
            args.extend(["--condition-ids", ",".join(condition_ids)])
        if dry_run:
            args.extend(["--dry-run", "--output", "json"])
        else:
            args.extend(["--yes", "--non-interactive", "--output", "json"])
        stdout = await run_bullpen(
            args, timeout_seconds=BULLPEN_REDEEM_TIMEOUT_SECONDS, read_only=dry_run
        )
        return redact_secrets(stdout)

    async def claim(self, *, dry_run: bool) -> str:
        args = ["polymarket", "claim"]
        if dry_run:
            args.extend(["--dry-run", "--output", "json"])
        else:
            args.extend(["--yes", "--non-interactive", "--output", "json"])
        stdout = await run_bullpen(
            args, timeout_seconds=BULLPEN_REDEEM_TIMEOUT_SECONDS, read_only=dry_run
        )
        return redact_secrets(stdout)

    async def _redeem_before_buy_retry(self) -> None:
        try:
            await self.redeem(dry_run=False)
        except BullpenCommandError as exc:
            if is_redeem_metadata_lookup_warning(str(exc)):
                return
            raise

    async def buy_limit(
        self,
        *,
        market_id: str,
        outcome: str,
        amount_usd: float,
        max_price: float,
    ) -> str:
        return await self._execute_buy_with_limit(
            market_id=market_id,
            outcome=outcome,
            amount_usd=amount_usd,
            max_price=max_price,
        )

    async def sell_limit(
        self,
        *,
        market_id: str,
        outcome: str,
        shares: float,
        min_price: float,
    ) -> str:
        args = [
            "polymarket",
            "sell",
            market_id,
            outcome,
            f"{shares:.6f}",
            "--min-price",
            f"{_clamp_limit_price(min_price):.4f}",
            "--yes",
            "--non-interactive",
            "--output",
            "json",
        ]
        stdout = await run_bullpen(args, timeout_seconds=45, read_only=False)
        return redact_secrets(stdout)

    async def _execute_buy_with_limit(
        self,
        *,
        market_id: str,
        outcome: str,
        amount_usd: float,
        max_price: float,
    ) -> str:
        args = [
            "polymarket",
            "buy",
            market_id,
            outcome,
            f"{amount_usd:.2f}",
            "--max-price",
            f"{_clamp_limit_price(max_price):.4f}",
            "--yes",
            "--non-interactive",
            "--output",
            "json",
        ]
        attempts_remaining = buy_max_price_retry_attempts()
        current_args = args
        current_max_price = _clamp_limit_price(max_price)
        redeemed_collateral = False
        wrapped_collateral = False
        while True:
            try:
                stdout = await run_bullpen(
                    current_args, timeout_seconds=45, read_only=False
                )
                return redact_secrets(stdout)
            except BullpenCommandError as exc:
                error_message = str(exc)
                collateral_needed = extract_bullpen_insufficient_collateral_amount(
                    error_message
                )
                if collateral_needed is not None and not redeemed_collateral:
                    redeemed_collateral = True
                    await self._redeem_before_buy_retry()
                    continue

                if collateral_needed is not None and not wrapped_collateral:
                    wrapped_collateral = True
                    wrap_amount = max(collateral_needed, amount_usd)
                    await run_bullpen(
                        [
                            "polymarket",
                            "wrap",
                            f"{wrap_amount:.2f}",
                            "--yes",
                            "--non-interactive",
                            "--output",
                            "json",
                        ],
                        timeout_seconds=45,
                        read_only=False,
                    )
                    continue

                fill_price = extract_bullpen_buy_fill_price_error(error_message)
                if fill_price is None or attempts_remaining <= 1:
                    raise
                retry_max_price = buy_retry_max_price_for_execution(fill_price)
                if retry_max_price <= current_max_price:
                    raise
                attempts_remaining -= 1
                current_max_price = retry_max_price
                retry_args = [*current_args]
                max_price_index = retry_args.index("--max-price") + 1
                retry_args[max_price_index] = f"{retry_max_price:.4f}"
                current_args = retry_args

    async def execute(self, decision: PolymarketLiveTradeDecision) -> str:
        if decision.side == "BUY":
            return await self._execute_buy_with_limit(
                market_id=decision.market_id,
                outcome=decision.outcome,
                amount_usd=decision.amount,
                max_price=buy_max_price_for_execution(decision.price),
            )
        return await self.sell_limit(
            market_id=decision.market_id,
            outcome=decision.outcome,
            shares=decision.shares,
            min_price=sell_min_price_for_execution(decision.price),
        )


BALANCE_COMMAND_VARIANTS = [
    [
        "portfolio",
        "balances",
        "--read-only",
        "--non-interactive",
        "--output",
        "json",
    ],
    [
        "funds",
        "balances",
        "--read-only",
        "--non-interactive",
        "--output",
        "json",
    ],
]


def _collect_bullpen_rows(value: object) -> list[dict[str, object]]:
    if isinstance(value, list):
        return [row for item in value for row in _collect_bullpen_rows(item)]
    if isinstance(value, dict):
        nested_keys = (
            "rows",
            "data",
            "items",
            "positions",
            "activities",
            "activity",
            "history",
            "transactions",
            "trades",
            "redemptions",
        )
        rows: list[dict[str, object]] = []
        for key in nested_keys:
            nested = value.get(key)
            if isinstance(nested, (list, dict)):
                rows.extend(_collect_bullpen_rows(nested))
        return rows or [value]
    return []


def _string_from_row(
    row: dict[str, object], keys: tuple[str, ...], default: str = ""
) -> str:
    for key in keys:
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return default


def _float_from_row(
    row: dict[str, object], keys: tuple[str, ...], default: float = 0
) -> float:
    for key in keys:
        value = row.get(key)
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            cleaned = value.replace("$", "").replace(",", "").strip()
            try:
                return float(cleaned)
            except ValueError:
                continue
    return default


def _is_redeem_row(row: dict[str, object]) -> bool:
    text = " ".join(str(value) for value in row.values() if value is not None).lower()
    return "redeem" in text or "redemption" in text


def _normalized_redeemed_trade(
    row: dict[str, object], index: int
) -> PolymarketBullpenRedeemedTrade | None:
    if not _is_redeem_row(row):
        return None
    timestamp = _string_from_row(
        row,
        (
            "timestamp",
            "createdAt",
            "created_at",
            "time",
            "date",
            "redeemedAt",
            "redeemed_at",
        ),
    )
    title = _string_from_row(
        row, ("marketTitle", "market_title", "title", "market", "event", "question")
    )
    if not timestamp or not title:
        return None
    amount = _float_from_row(
        row, ("amount", "value", "usd", "proceeds", "payout", "collateral", "total")
    )
    shares = abs(_float_from_row(row, ("shares", "size", "quantity", "qty"), amount))
    return PolymarketBullpenRedeemedTrade(
        id=_string_from_row(
            row,
            ("id", "transactionHash", "txHash", "hash"),
            f"bullpen-redeem-{index}-{timestamp}-{title}",
        ),
        timestamp=timestamp,
        market_id=_string_from_row(
            row, ("marketId", "market_id", "conditionId", "condition_id", "slug")
        ),
        market_title=title,
        outcome=_string_from_row(
            row, ("outcome", "outcomeName", "asset", "selection"), "—"
        ),
        side=_string_from_row(row, ("side", "action", "type"), "REDEEM").upper(),
        amount=amount,
        shares=shares,
        price=_float_from_row(row, ("price", "avgPrice", "average_price"), 1),
        profit_loss=_float_from_row(
            row,
            ("profitLoss", "profit_loss", "pnl", "realizedPnl", "realized_pnl"),
            amount,
        ),
        status=_string_from_row(row, ("status",), "redeemed"),
        detail=_string_from_row(
            row, ("detail", "description", "reason"), "Bullpen wallet redeem history"
        ),
    )


BULLPEN_REDEEMED_HISTORY_COMMAND_VARIANTS = [
    [
        "wallet",
        "predictions",
        "--history",
        "--read-only",
        "--non-interactive",
        "--output",
        "json",
    ],
    ["portfolio", "history", "--read-only", "--non-interactive", "--output", "json"],
    [
        "activity",
        "--type",
        "redeem",
        "--limit",
        "100",
        "--read-only",
        "--non-interactive",
        "--output",
        "json",
    ],
]


class BullpenRedeemedTradesReader:
    async def refresh(self) -> list[PolymarketBullpenRedeemedTrade]:
        parsed = await run_first_bullpen_json(
            BULLPEN_REDEEMED_HISTORY_COMMAND_VARIANTS, timeout_seconds=10
        )
        rows = _collect_bullpen_rows(parsed)
        redeemed = [
            trade
            for index, row in enumerate(rows)
            if (trade := _normalized_redeemed_trade(row, index)) is not None
        ]
        deduped: dict[str, PolymarketBullpenRedeemedTrade] = {}
        for trade in redeemed:
            key = "::".join(
                [
                    trade.timestamp,
                    trade.market_id,
                    trade.market_title,
                    trade.outcome,
                    str(trade.amount),
                ]
            )
            deduped.setdefault(key, trade)
        return list(deduped.values())


class BullpenBalanceReader:
    async def refresh(self) -> PolymarketBalanceState:
        checked_at = utc_now()
        try:
            parsed = await run_first_bullpen_json(
                BALANCE_COMMAND_VARIANTS,
                timeout_seconds=int(
                    _float_from_env(
                        "BULLPEN_BALANCE_TIMEOUT_SECONDS",
                        BULLPEN_BALANCE_TIMEOUT_SECONDS,
                    )
                ),
            )
            balance_values = _extract_balance_values(parsed)
            return PolymarketBalanceState(
                status="ready",
                checked_at=checked_at,
                message=_format_balance_message(parsed),
                account_value_usd=balance_values["account_value_usd"],
                available_balance_usd=balance_values["available_balance_usd"],
                pnl_usd=balance_values["pnl_usd"],
                upnl_usd=balance_values["upnl_usd"],
            )
        except Exception as exc:
            message = redact_secrets(str(exc))
            return PolymarketBalanceState(
                status="error",
                checked_at=checked_at,
                message=_format_balance_error_message(message),
            )


class LiveTradeGuard:
    def __init__(self, config: PolymarketBotConfig) -> None:
        self.config = config

    def startup_block_reason(
        self,
        doctor: PolymarketDoctorStatus,
        dashboard_unlocked: bool,
        emergency_stopped: bool,
        manually_locked: bool,
    ) -> str | None:
        if emergency_stopped:
            return "Emergency stop is active."
        hard_block = self.hard_block_reason(doctor)
        if hard_block:
            return hard_block
        if manually_locked:
            return "Live locked manually."
        if not dashboard_unlocked:
            return "Dashboard live unlock is required."
        return None

    def hard_block_reason(self, doctor: PolymarketDoctorStatus) -> str | None:
        if self.config.paper_trading:
            return "PAPER_TRADING must be false."
        if not self.config.live_trading:
            return "LIVE_TRADING must be true."
        if not self.config.use_live_reads:
            return "USE_LIVE_READS must be true."
        if not doctor.ok:
            return "Bullpen doctor must pass."
        return self.risk_settings_block_reason()

    def risk_settings_block_reason(self) -> str | None:
        if self.config.max_live_trade_size <= 0:
            return "MAX_LIVE_TRADE_SIZE must be greater than 0."
        if self.config.max_live_trade_size > self.config.fixed_copy_trade_size:
            return "MAX_LIVE_TRADE_SIZE cannot exceed FIXED_COPY_TRADE_SIZE."
        if self.config.max_live_trades_per_day <= 0:
            return "MAX_LIVE_TRADES_PER_DAY must be greater than 0."
        if self.config.max_live_daily_loss <= 0:
            return "MAX_LIVE_DAILY_LOSS must be greater than 0."
        if self.config.max_live_exposure_per_market <= 0:
            return "MAX_LIVE_EXPOSURE_PER_MARKET must be greater than 0."
        if self.config.max_live_trade_size > self.config.max_live_exposure_per_market:
            return "MAX_LIVE_TRADE_SIZE cannot exceed MAX_LIVE_EXPOSURE_PER_MARKET."
        return None

    def trade_block_reason(
        self,
        source_trade: PolymarketSourceTrade,
        live_trades: list[PolymarketLiveTradeDecision],
        positions: list[PolymarketPosition],
    ) -> str | None:
        if self.live_trades_today(live_trades) >= self.config.max_live_trades_per_day:
            return "Max live trades per day reached."
        trader_invested_usd = (
            source_trade.trader_invested_usd
            if source_trade.trader_invested_usd is not None
            else source_trade.size_usd
        )
        if trader_invested_usd <= self.config.trader_invested_threshold_usd:
            return f"Below ${self.config.trader_invested_threshold_usd:g} threshold"
        if self.realized_live_pnl(live_trades) <= -self.config.max_live_daily_loss:
            return "Max live daily loss reached."

        position = next(
            (
                item
                for item in positions
                if item.key
                == live_position_key(source_trade.market_id, source_trade.outcome)
            ),
            None,
        )
        if source_trade.side == "SELL" and (not position or position.shares <= 0):
            return "No matching live-tracked position to sell."

        if source_trade.side == "BUY":
            current_exposure = position.cost_basis if position else 0
            next_exposure = current_exposure + min(
                self.config.fixed_copy_trade_size,
                self.config.max_live_trade_size,
                source_trade.size_usd,
            )
            if next_exposure > self.config.max_live_exposure_per_market:
                return "Max live exposure per market reached."
        return None

    def live_trades_today(self, live_trades: list[PolymarketLiveTradeDecision]) -> int:
        today = utc_now()[:10]
        return sum(
            1
            for trade in live_trades
            if trade.executed_at
            and trade.executed_at.startswith(today)
            and trade.status == "executed"
        )

    def realized_live_pnl(
        self, live_trades: list[PolymarketLiveTradeDecision]
    ) -> float:
        return sum(
            max(-trade.max_loss, 0)
            for trade in live_trades
            if trade.status == "executed" and trade.side == "SELL"
        )


def live_position_key(market_id: str, outcome: str) -> str:
    return f"{market_id}::{outcome}"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _format_balance_error_message(message: str) -> str:
    if _is_missing_balance_command(message):
        return "Balance unavailable: Bullpen CLI balance command not found"
    if _is_auth_required_error(message):
        return "Balance unavailable: Bullpen login required. Run: bullpen login"
    return f"Balance unavailable: {message}"


def _is_auth_required_error(message: str) -> bool:
    lowered = message.lower()
    auth_markers = (
        "auth_required",
        "auth reauthentication required",
        "not logged in",
        "requires_auth",
        "requires_login",
        "bullpen login",
    )
    return any(marker in lowered for marker in auth_markers)


def _is_missing_balance_command(message: str) -> bool:
    lowered = message.lower()
    if "bullpen cli executable was not found" in lowered:
        return False

    missing_command_markers = (
        "unrecognized subcommand",
        "unknown command",
        "no such command",
        "invalid subcommand",
        "command not found",
    )
    return any(marker in lowered for marker in missing_command_markers)


def _extract_balance_values(parsed: object) -> dict[str, float | None]:
    candidates = _collect_balance_candidates(parsed)
    account_value = _select_account_value_candidate(candidates)
    available_balance = _select_available_balance_candidate(candidates)
    pnl = _select_pnl_candidate(candidates)
    upnl = _select_upnl_candidate(candidates)
    return {
        "account_value_usd": float(account_value["amount"]) if account_value else None,
        "available_balance_usd": (
            float(available_balance["amount"]) if available_balance else None
        ),
        "pnl_usd": float(pnl["amount"]) if pnl else None,
        "upnl_usd": float(upnl["amount"]) if upnl else None,
    }


def _select_account_value_candidate(
    candidates: list[dict[str, object]],
) -> dict[str, object] | None:
    preferred_account_value = next(
        (
            item
            for item in candidates
            if "polymarket" in item["context"].lower()
            and _is_account_value_candidate(item)
        ),
        None,
    )
    return preferred_account_value or next(
        (item for item in candidates if _is_account_value_candidate(item)),
        None,
    )


def _select_available_balance_candidate(
    candidates: list[dict[str, object]],
) -> dict[str, object] | None:
    preferred_cash_balance = next(
        (
            item
            for item in candidates
            if "polymarket" in item["context"].lower()
            and _is_cash_balance_candidate(item)
            and not _is_account_value_candidate(item)
        ),
        None,
    )
    return preferred_cash_balance or next(
        (
            item
            for item in candidates
            if _is_cash_balance_candidate(item)
            and not _is_account_value_candidate(item)
        ),
        None,
    )


def _select_pnl_candidate(
    candidates: list[dict[str, object]],
) -> dict[str, object] | None:
    preferred_pnl = next(
        (
            item
            for item in candidates
            if "polymarket" in item["context"].lower() and _is_pnl_candidate(item)
        ),
        None,
    )
    return preferred_pnl or next(
        (item for item in candidates if _is_pnl_candidate(item)),
        None,
    )


def _select_upnl_candidate(
    candidates: list[dict[str, object]],
) -> dict[str, object] | None:
    preferred_upnl = next(
        (
            item
            for item in candidates
            if "polymarket" in item["context"].lower() and _is_upnl_candidate(item)
        ),
        None,
    )
    return preferred_upnl or next(
        (item for item in candidates if _is_upnl_candidate(item)),
        None,
    )


def _format_balance_message(parsed: object) -> str:
    candidates = _collect_balance_candidates(parsed)
    account_value = _select_account_value_candidate(candidates)
    fallback = _select_available_balance_candidate(candidates) or (
        candidates[0] if candidates else None
    )

    balance = account_value or fallback
    if not balance:
        return "Balance unavailable: Bullpen CLI returned no balance rows"

    prefix = "Polymarket" if "polymarket" in balance["context"].lower() else "Bullpen"
    currency = f" {balance['currency']}" if balance.get("currency") else ""
    label = (
        "account value" if _is_account_value_candidate(balance) else "available balance"
    )
    return f"{prefix} {label}: {_format_amount(balance['amount'])}{currency}"


def _is_account_value_candidate(item: dict[str, object]) -> bool:
    label = str(item.get("label") or "").lower()
    normalized = label.replace("_", "").replace("-", "").replace(" ", "")
    return any(
        token in normalized
        for token in (
            "accountvalue",
            "portfoliovalue",
            "totalvalue",
            "valueusd",
            "equity",
            "netliquidation",
            "totalaccountvalue",
            "totalbalance",
            "totalportfolio",
        )
    )


def _is_cash_balance_candidate(item: dict[str, object]) -> bool:
    label = str(item.get("label") or "").lower()
    currency = str(item.get("currency") or "").lower()
    return any(
        token in label or token in currency
        for token in ("available", "balance", "cash", "collateral", "pusd", "usdc")
    )


def _normalized_balance_label(item: dict[str, object]) -> str:
    return (
        str(item.get("label") or "")
        .lower()
        .replace("_", "")
        .replace("-", "")
        .replace(" ", "")
    )


def _is_upnl_candidate(item: dict[str, object]) -> bool:
    normalized = _normalized_balance_label(item)
    return any(
        token in normalized
        for token in (
            "upnl",
            "unrealizedpnl",
            "unrealizedprofitloss",
            "unrealizedprofitandloss",
        )
    )


def _is_pnl_candidate(item: dict[str, object]) -> bool:
    normalized = _normalized_balance_label(item)
    if _is_upnl_candidate(item):
        return False
    return any(
        token in normalized
        for token in (
            "pnl",
            "realizedpnl",
            "profitloss",
            "profitandloss",
        )
    )


def _collect_balance_candidates(
    value: object, context: str = "", label: str = ""
) -> list[dict[str, object]]:
    if isinstance(value, list):
        rows: list[dict[str, object]] = []
        for index, item in enumerate(value, start=1):
            rows.extend(
                _collect_balance_candidates(item, context, label or f"row {index}")
            )
        return rows

    if not isinstance(value, dict):
        return []

    record = value
    next_context = str(
        record.get("chain")
        or record.get("platform")
        or record.get("venue")
        or record.get("account")
        or record.get("walletKind")
        or context
    )
    currency = _string_value(
        record.get("currency")
        or record.get("symbol")
        or record.get("token")
        or record.get("asset")
    )
    rows: list[dict[str, object]] = []

    for key, raw in record.items():
        if isinstance(raw, dict) or isinstance(raw, list):
            rows.extend(_collect_balance_candidates(raw, next_context, key))
            continue
        normalized_key = key.lower().replace("_", "").replace("-", "").replace(" ", "")
        if not any(
            token in normalized_key
            for token in (
                "accountvalue",
                "available",
                "balance",
                "cash",
                "collateral",
                "equity",
                "netliquidation",
                "totalaccountvalue",
                "totalbalance",
                "totalportfolio",
                "portfoliovalue",
                "pusd",
                "totalvalue",
                "usdc",
                "valueusd",
                "pnl",
                "upnl",
                "realizedpnl",
                "unrealizedpnl",
                "profitloss",
                "profitandloss",
            )
        ):
            continue
        amount = _number_value(raw)
        if amount is None:
            continue
        rows.append(
            {
                "context": next_context,
                "label": key or label,
                "amount": amount,
                "currency": currency,
            }
        )
    return rows


def _number_value(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if not isinstance(value, str):
        return None
    try:
        return float(value.replace("$", "").replace(",", ""))
    except ValueError:
        return None


def _string_value(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _format_amount(value: float) -> str:
    return f"{value:,.4f}".rstrip("0").rstrip(".")
