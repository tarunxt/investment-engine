"""Display existing CopyTrader evidence without creating an operational bot.

These synchronous helpers run in a thread, including JSON decoding, validation,
and full-history aggregates. They never seed stores, initialize providers, or
register the transient projection with the operational manager.
"""
from __future__ import annotations

import json
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from app.domains.polymarket.bot import PolymarketPaperCopyBot
from app.domains.polymarket.config import load_polymarket_config
from app.domains.polymarket.schemas import (
    PolymarketBotState,
    PolymarketHistoryResponse,
    PolymarketLiveTradeDecision,
    PolymarketPaperTrade,
    PolymarketTrackedAccount,
    PolymarketUserConfigOverride,
)

MAX_PASSIVE_TOTAL_BYTES = 8 * 1024 * 1024
ModelT = TypeVar("ModelT", bound=BaseModel)
_MISSING = object()
PERSISTED_READ_MESSAGE = (
    "Showing persisted history only. Current runtime status, doctor, balance, "
    "discovery and redeemed-wallet history are unavailable in this process. "
    "Opening this page does not start or refresh the bot."
)
NO_SNAPSHOT_MESSAGE = (
    "No saved CopyTrader snapshot is available. Current runtime status, balance "
    "and doctor results are unknown. Use an explicit control to initialize the bot."
)


class PassiveProjectionUnavailable(RuntimeError):
    """An evidence read failed; never substitute empty financial history."""


class _NoOperationalCapability:
    def __getattr__(self, name: str):
        raise RuntimeError(f"Operational capability {name} is unavailable to passive reads.")


@dataclass
class _ReadBudget:
    remaining: int


def _read_budget(paths: list[Path]) -> _ReadBudget:
    """Reject combined input before decoding any file; charge actual reads below."""
    total = 0
    for path in paths:
        try:
            metadata = path.stat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise PassiveProjectionUnavailable(f"Saved {path.name} could not be read.") from exc
        if not stat.S_ISREG(metadata.st_mode):
            raise PassiveProjectionUnavailable(f"Saved {path.name} is not a regular evidence file.")
        total += metadata.st_size
        if total > MAX_PASSIVE_TOTAL_BYTES:
            raise PassiveProjectionUnavailable(
                f"Saved {path.name} exceeds the aggregate passive read limit; history was not truncated."
            )
    return _ReadBudget(remaining=MAX_PASSIVE_TOTAL_BYTES)


def _read_json(path: Path, budget: _ReadBudget, *, required: bool = True) -> object:
    try:
        metadata = path.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise PassiveProjectionUnavailable(f"Saved {path.name} is not a regular evidence file.")
        if metadata.st_size > budget.remaining:
            raise PassiveProjectionUnavailable(
                f"Saved {path.name} exceeds the aggregate passive read limit; history was not truncated."
            )
        # A bounded read also handles files that grow between stat and read.
        with path.open("rb") as source:
            raw = source.read(budget.remaining + 1)
    except FileNotFoundError as exc:
        if not required:
            return _MISSING
        raise PassiveProjectionUnavailable(
            f"Saved {path.name} is unavailable; no empty history was substituted."
        ) from exc
    except OSError as exc:
        raise PassiveProjectionUnavailable(f"Saved {path.name} could not be read.") from exc
    budget.remaining -= len(raw)
    if budget.remaining < 0:
        raise PassiveProjectionUnavailable(
            f"Saved {path.name} exceeds the aggregate passive read limit; history was not truncated."
        )
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise PassiveProjectionUnavailable(f"Saved {path.name} is invalid JSON.") from exc


def _read_models(path: Path, model: type[ModelT], budget: _ReadBudget) -> list[ModelT]:
    payload = _read_json(path, budget)
    if not isinstance(payload, list):
        raise PassiveProjectionUnavailable(f"Saved {path.name} is not a history list.")
    try:
        return [model.model_validate(item) for item in payload]
    except ValidationError as exc:
        raise PassiveProjectionUnavailable(f"Saved {path.name} contains invalid records.") from exc


def _user_directory(user_id: int) -> Path:
    return Path(load_polymarket_config().data_dir) / f"user-{user_id}"


def _has_saved_evidence(directory: Path) -> bool:
    return any((directory / name).exists() for name in (
        "polymarket-config.json", "polymarket-trades.json",
        "polymarket-live-trades.json", "polymarket-tracked-accounts.json",
    ))


def read_persisted_history(user_id: int, limit: int) -> PolymarketHistoryResponse:
    directory = _user_directory(user_id)
    if not _has_saved_evidence(directory):
        return PolymarketHistoryResponse(read_source="unavailable", read_message=NO_SNAPSHOT_MESSAGE)
    paper_path = directory / "polymarket-trades.json"
    live_path = directory / "polymarket-live-trades.json"
    budget = _read_budget([paper_path, live_path])
    paper = _read_models(paper_path, PolymarketPaperTrade, budget)
    live = _read_models(live_path, PolymarketLiveTradeDecision, budget)
    return PolymarketHistoryResponse(
        read_source="persisted",
        read_message=PERSISTED_READ_MESSAGE,
        paper_trades=list(reversed(paper[-limit:])),
        live_decisions=list(reversed(live[-limit:])),
    )


def read_persisted_state(user_id: int) -> PolymarketBotState:
    base = load_polymarket_config()
    directory = Path(base.data_dir) / f"user-{user_id}"
    config_path = directory / "polymarket-config.json"
    paper_path = directory / "polymarket-trades.json"
    live_path = directory / "polymarket-live-trades.json"
    account_path = directory / "polymarket-tracked-accounts.json"
    budget = _read_budget([config_path, paper_path, live_path, account_path])
    override = _read_json(config_path, budget, required=False)
    update = {"data_dir": str(directory)}
    if override is not _MISSING:
        try:
            update.update(PolymarketUserConfigOverride.model_validate(override).model_dump(exclude_none=True))
        except ValidationError as exc:
            raise PassiveProjectionUnavailable("Saved polymarket-config.json is invalid.") from exc
    config = base.model_copy(update=update)
    has_saved_evidence = _has_saved_evidence(directory)
    unavailable = _NoOperationalCapability()
    # All operational dependencies are denied, including stores and logging.
    # The constructor only establishes in-memory defaults and the pure guard.
    projection = PolymarketPaperCopyBot(
        user_id=user_id,
        config=config,
        provider=unavailable,
        fallback_provider=unavailable,
        store=unavailable,
        live_store=unavailable,
        tracked_account_store=unavailable,
        config_store=unavailable,
        live_executor=unavailable,
        balance_reader=unavailable,
        redeemed_trades_reader=unavailable,
        logger=unavailable,
    )
    if has_saved_evidence:
        projection.trade_history = _read_models(paper_path, PolymarketPaperTrade, budget)
        projection.live_trade_history = _read_models(live_path, PolymarketLiveTradeDecision, budget)
        projection.tracked_accounts = _read_models(account_path, PolymarketTrackedAccount, budget)
    projection.balance_state.status = "unavailable"
    projection.balance_state.message = "No cached balance is available in this process."
    projection.doctor_status.message = "No cached doctor result is available in this process."
    return projection.get_state_snapshot(restore_poller=False).model_copy(update={
        "read_source": "persisted" if has_saved_evidence else "unavailable",
        "read_message": PERSISTED_READ_MESSAGE if has_saved_evidence else NO_SNAPSHOT_MESSAGE,
    })
