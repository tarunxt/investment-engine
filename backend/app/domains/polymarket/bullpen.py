from __future__ import annotations

import asyncio
import json
import os
import shutil
from collections.abc import Iterable

from app.domains.polymarket.logger import redact_secrets
from app.domains.polymarket.schemas import (
    PolymarketBalanceState,
    PolymarketBotConfig,
    PolymarketDoctorStatus,
    PolymarketLiveTradeDecision,
    PolymarketPosition,
    PolymarketSourceTrade,
)


class BullpenCommandError(RuntimeError):
    pass


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
            shutil.which("bullpen"),
            *runtime_tool_paths,
            os.path.expanduser("~/.bullpen/bin/bullpen"),
            "/home/appuser/.bullpen/bin/bullpen",
            "/home/investor/.bullpen/bin/bullpen",
            "/usr/local/bin/bullpen",
        ]
    )


def _bullpen_install_hint() -> str:
    attempted = ", ".join(bullpen_candidate_paths())
    return (
        "Bullpen CLI executable was not found. Install Bullpen in the backend runtime, "
        "place it at <backend>/.runtime-tools/bullpen, <backend>/runtime-tools/bullpen, "
        "/usr/local/bin/bullpen, ~/.bullpen/bin/bullpen, or set BULLPEN_BIN to an executable path. "
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
    env = os.environ.copy()
    if read_only:
        env["BULLPEN_READ_ONLY"] = "true"
        env["BULLPEN_NON_INTERACTIVE"] = "true"

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


class BullpenLiveExecutor:
    async def doctor(self) -> PolymarketDoctorStatus:
        checked_at = utc_now()
        checks = [
            (["status"], True, "status"),
            (["polymarket", "preflight"], False, "preflight"),
            (["polymarket", "approve", "--check"], False, "approvals"),
        ]
        failures: list[str] = []
        passed: list[str] = []
        for args, read_only, label in checks:
            try:
                await run_bullpen(args, timeout_seconds=45, read_only=read_only)
                passed.append(label)
            except Exception as exc:
                failures.append(f"{label}: {redact_secrets(str(exc))}")
        if not failures:
            return PolymarketDoctorStatus(
                checked_at=checked_at,
                ok=True,
                message="Bullpen status, preflight, and approval checks passed.",
            )
        return PolymarketDoctorStatus(
            checked_at=checked_at,
            ok=False,
            message=f"Bullpen doctor failed after {', '.join(passed) or 'no'} passed checks: {'; '.join(failures)}",
        )

    async def redeem(self, *, dry_run: bool) -> str:
        args = ["polymarket", "redeem"]
        if dry_run:
            args.extend(["--dry-run", "--output", "json"])
        else:
            args.extend(["--yes", "--non-interactive", "--output", "json"])
        stdout = await run_bullpen(args, timeout_seconds=60, read_only=dry_run)
        return redact_secrets(stdout)

    async def execute(self, decision: PolymarketLiveTradeDecision) -> str:
        if decision.side == "BUY":
            args = [
                "polymarket",
                "buy",
                decision.market_id,
                decision.outcome,
                f"{decision.amount:.2f}",
                "--max-price",
                f"{decision.price:.4f}",
                "--yes",
                "--non-interactive",
                "--output",
                "json",
            ]
        else:
            args = [
                "polymarket",
                "sell",
                decision.market_id,
                decision.outcome,
                f"{decision.shares:.6f}",
                "--min-price",
                f"{decision.price:.4f}",
                "--yes",
                "--non-interactive",
                "--output",
                "json",
            ]
        stdout = await run_bullpen(args, timeout_seconds=45, read_only=False)
        return redact_secrets(stdout)


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


class BullpenBalanceReader:
    async def refresh(self) -> PolymarketBalanceState:
        checked_at = utc_now()
        try:
            parsed = await run_first_bullpen_json(
                BALANCE_COMMAND_VARIANTS,
                timeout_seconds=30,
            )
            return PolymarketBalanceState(
                status="ready",
                checked_at=checked_at,
                message=_format_balance_message(parsed),
            )
        except Exception as exc:
            message = redact_secrets(str(exc))
            return PolymarketBalanceState(
                status="error",
                checked_at=checked_at,
                message=(
                    "Balance unavailable: Bullpen CLI balance command not found"
                    if _is_missing_balance_command(message)
                    else f"Balance unavailable: {message}"
                ),
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
        if not self.config.jurisdiction_confirmation:
            return "JURISDICTION_CONFIRMATION must be true."
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
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


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


def _format_balance_message(parsed: object) -> str:
    candidates = _collect_balance_candidates(parsed)
    preferred = next(
        (
            item
            for item in candidates
            if "polymarket" in item["context"].lower()
            and _is_cash_balance_candidate(item)
        ),
        None,
    )
    fallback = next(
        (item for item in candidates if _is_cash_balance_candidate(item)),
        None,
    ) or (candidates[0] if candidates else None)

    balance = preferred or fallback
    if not balance:
        return "Balance unavailable: Bullpen CLI returned no balance rows"

    prefix = "Polymarket" if "polymarket" in balance["context"].lower() else "Bullpen"
    currency = f" {balance['currency']}" if balance.get("currency") else ""
    return f"{prefix} available balance: {_format_amount(balance['amount'])}{currency}"


def _is_cash_balance_candidate(item: dict[str, object]) -> bool:
    label = str(item.get("label") or "").lower()
    currency = str(item.get("currency") or "").lower()
    return any(
        token in label or token in currency
        for token in ("available", "balance", "cash", "collateral", "pusd", "usdc")
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
        if not any(
            token in key.lower()
            for token in ("available", "balance", "cash", "pusd", "usdc", "collateral")
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
