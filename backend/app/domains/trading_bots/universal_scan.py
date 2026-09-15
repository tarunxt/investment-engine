"""Durable scheduling and export storage for the shared Universal Polymarket Scan."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import zlib
from datetime import UTC, datetime, timedelta
from pathlib import Path
from collections.abc import Iterator
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domains.trading_bots.models import (
    UniversalScanSettingsRecord,
    UniversalScanStateRecord,
)

SETTINGS_KEY = "universal_scan_auto_run"
STATE_KEY = "universal_scan_auto_run"
DEFAULT_START_AT = "2026-08-22T12:30:00+00:00"  # 18:00 IST
DEFAULT_REFRESH_MINUTES = 360
MAX_HISTORY = 25


def utc_now() -> datetime:
    return datetime.now(UTC)


def parse_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def next_scheduled_time(reference: datetime, *, start_at: str, refresh_minutes: int) -> datetime:
    anchor = parse_datetime(start_at) or parse_datetime(DEFAULT_START_AT)
    assert anchor is not None
    interval = timedelta(minutes=max(1, refresh_minutes))
    reference = reference.astimezone(UTC)
    if reference < anchor:
        return anchor
    elapsed = reference - anchor
    cycles = int(elapsed.total_seconds() // interval.total_seconds()) + 1
    return anchor + cycles * interval


def _settings_record(session: Session, user_id: int) -> UniversalScanSettingsRecord:
    record = session.get(UniversalScanSettingsRecord, user_id)
    if record is None:
        record = UniversalScanSettingsRecord(user_id=user_id, payload={})
        session.add(record)
        session.flush()
    return record


def _state_record(session: Session, user_id: int) -> UniversalScanStateRecord:
    record = session.get(UniversalScanStateRecord, user_id)
    if record is None:
        record = UniversalScanStateRecord(user_id=user_id, payload={})
        session.add(record)
        session.flush()
    return record


def read_settings(record: UniversalScanSettingsRecord | None) -> dict[str, Any]:
    saved = record.payload.get(SETTINGS_KEY) if record and isinstance(record.payload, dict) else None
    saved = saved if isinstance(saved, dict) else {}
    refresh = saved.get("refresh_minutes", DEFAULT_REFRESH_MINUTES)
    return {
        "enabled": bool(saved.get("enabled", False)),
        "start_at": saved.get("start_at") if parse_datetime(saved.get("start_at")) else DEFAULT_START_AT,
        "refresh_minutes": max(1, int(refresh)) if isinstance(refresh, (int, float)) else DEFAULT_REFRESH_MINUTES,
    }


def read_state(record: UniversalScanStateRecord | None) -> dict[str, Any]:
    saved = record.payload.get(STATE_KEY) if record and isinstance(record.payload, dict) else None
    saved = saved if isinstance(saved, dict) else {}
    history = saved.get("history")
    return {
        "running": bool(saved.get("running", False)),
        "paused": bool(saved.get("paused", False)),
        "kill_requested": bool(saved.get("kill_requested", False)),
        "run_id": saved.get("run_id"),
        "next_run_at": saved.get("next_run_at"),
        "last_run_at": saved.get("last_run_at"),
        "last_completed_at": saved.get("last_completed_at"),
        "last_failed_at": saved.get("last_failed_at"),
        "last_error": saved.get("last_error"),
        "last_total_events": (
            int(saved["last_total_events"])
            if isinstance(saved.get("last_total_events"), (int, float))
            else None
        ),
        "progress_events": int(saved.get("progress_events", 0) or 0),
        "progress_pages": int(saved.get("progress_pages", 0) or 0),
        "estimated_total_events": (
            int(saved["estimated_total_events"])
            if isinstance(saved.get("estimated_total_events"), (int, float))
            else None
        ),
        "progress_message": saved.get("progress_message"),
        "history": history[:MAX_HISTORY] if isinstance(history, list) else [],
    }


def save_settings(session: Session, user_id: int, settings: dict[str, Any]) -> None:
    record = _settings_record(session, user_id)
    record.payload = {**(record.payload or {}), SETTINGS_KEY: settings}


def save_state(session: Session, user_id: int, state: dict[str, Any]) -> None:
    record = _state_record(session, user_id)
    record.payload = {**(record.payload or {}), STATE_KEY: state}


def status_for_user(session: Session, user_id: int) -> dict[str, Any]:
    settings = read_settings(session.get(UniversalScanSettingsRecord, user_id))
    state = read_state(session.get(UniversalScanStateRecord, user_id))
    latest_history = state["history"][0] if state["history"] else None
    last_run_at = parse_datetime(state["last_run_at"])
    configured_start = parse_datetime(settings["start_at"])
    effective_run_start = last_run_at.replace(microsecond=0) if last_run_at is not None else None
    if (
        isinstance(latest_history, dict)
        and latest_history.get("triggered_by") == "manual"
        and effective_run_start is not None
        and (configured_start is None or effective_run_start > configured_start)
    ):
        settings["enabled"] = True
        settings["start_at"] = effective_run_start.isoformat()
        state["next_run_at"] = next_scheduled_time(
            utc_now(),
            start_at=settings["start_at"],
            refresh_minutes=settings["refresh_minutes"],
        ).isoformat()
        save_settings(session, user_id, settings)
        save_state(session, user_id, state)
    if settings["enabled"] and not state["running"] and parse_datetime(state["next_run_at"]) is None:
        state["next_run_at"] = next_scheduled_time(
            utc_now(),
            start_at=settings["start_at"],
            refresh_minutes=settings["refresh_minutes"],
        ).isoformat()
        save_state(session, user_id, state)
    return {**settings, **state}


def update_schedule(
    session: Session,
    user_id: int,
    *,
    enabled: bool | None = None,
    start_at: str | None = None,
    refresh_minutes: int | None = None,
) -> dict[str, Any]:
    settings = read_settings(_settings_record(session, user_id))
    state = read_state(_state_record(session, user_id))
    if start_at is not None:
        parsed = parse_datetime(start_at)
        if parsed is None:
            raise ValueError("Auto-run start time must be a valid ISO timestamp.")
        settings["start_at"] = parsed.isoformat()
    if refresh_minutes is not None:
        if refresh_minutes < 1:
            raise ValueError("Refresh duration must be at least one minute.")
        settings["refresh_minutes"] = refresh_minutes
    if enabled is not None:
        settings["enabled"] = enabled
    state["next_run_at"] = (
        next_scheduled_time(
            utc_now(),
            start_at=settings["start_at"],
            refresh_minutes=settings["refresh_minutes"],
        ).isoformat()
        if settings["enabled"]
        else None
    )
    save_settings(session, user_id, settings)
    save_state(session, user_id, state)
    return {**settings, **state}


def due_user_ids(session: Session, now: datetime) -> list[int]:
    rows = session.scalars(select(UniversalScanSettingsRecord)).all()
    due: list[int] = []
    for row in rows:
        settings = read_settings(row)
        if not settings["enabled"]:
            continue
        state_record = session.get(UniversalScanStateRecord, row.user_id)
        state = read_state(state_record)
        if state["running"]:
            started_at = parse_datetime(state["last_run_at"])
            if started_at is None or now - started_at <= timedelta(minutes=55):
                continue
            stale_run_id = str(state.get("run_id") or f"stale-{row.user_id}")
            finish_run(
                session,
                row.user_id,
                stale_run_id,
                error="Universal Scan worker exceeded its 55-minute recovery window.",
            )
            state = read_state(session.get(UniversalScanStateRecord, row.user_id))
        next_at = parse_datetime(state["next_run_at"])
        if next_at is None:
            state["next_run_at"] = next_scheduled_time(
                now - timedelta(seconds=1),
                start_at=settings["start_at"],
                refresh_minutes=settings["refresh_minutes"],
            ).isoformat()
            save_state(session, row.user_id, state)
            next_at = parse_datetime(state["next_run_at"])
        if next_at is not None and next_at <= now:
            due.append(row.user_id)
    return due


def mark_queued(session: Session, user_id: int, run_id: str, *, triggered_by: str) -> dict[str, Any]:
    state = read_state(_state_record(session, user_id))
    if state["running"]:
        return state
    now = utc_now().isoformat()
    state.update({
        "running": True,
        "paused": False,
        "kill_requested": False,
        "run_id": run_id,
        "last_run_at": now,
        "last_error": None,
        "progress_events": 0,
        "progress_pages": 0,
        "estimated_total_events": state["last_total_events"],
        "progress_message": "Queued for the Universal Scan worker.",
    })
    state["history"] = ([{
        "id": run_id,
        "status": "queued",
        "triggered_by": triggered_by,
        "started_at": now,
        "completed_at": None,
        "total_events": None,
        "error": None,
    }] + state["history"])[:MAX_HISTORY]
    save_state(session, user_id, state)
    return state


def mark_started(session: Session, user_id: int, run_id: str) -> bool:
    state = read_state(_state_record(session, user_id))
    if not state["running"] or state["run_id"] != run_id:
        return False
    state["history"] = [
        {**item, "status": "running"}
        if isinstance(item, dict) and item.get("id") == run_id
        else item
        for item in state["history"]
    ]
    state["progress_message"] = "Fetching the first Polymarket Gamma page."
    save_state(session, user_id, state)
    return True


def update_progress(
    session: Session,
    user_id: int,
    run_id: str,
    *,
    events: int,
    pages: int,
) -> str:
    record = session.scalar(
        select(UniversalScanStateRecord)
        .where(UniversalScanStateRecord.user_id == user_id)
        .with_for_update()
    )
    state = read_state(record)
    if not state["running"] or state["run_id"] != run_id:
        return "kill"
    state["progress_events"] = max(0, events)
    state["progress_pages"] = max(0, pages)
    if state["kill_requested"]:
        state["progress_message"] = "Cancelling after the current Gamma page."
        control = "kill"
    elif state["paused"]:
        state["progress_message"] = "Paused by user. Resume to continue scanning."
        control = "pause"
    else:
        state["progress_message"] = f"Scanning page {pages:,}: {events:,} events captured."
        control = "continue"
    save_state(session, user_id, state)
    return control


def control_run(session: Session, user_id: int, *, action: str) -> dict[str, Any]:
    record = session.scalar(
        select(UniversalScanStateRecord)
        .where(UniversalScanStateRecord.user_id == user_id)
        .with_for_update()
    )
    state = read_state(record)
    if not state["running"]:
        return state
    if action == "pause":
        state["paused"] = True
        state["progress_message"] = "Pause requested; finishing the current Gamma page."
    elif action == "resume":
        state["paused"] = False
        state["progress_message"] = "Resuming Universal Scan."
    elif action == "kill":
        state["kill_requested"] = True
        state["paused"] = False
        state["progress_message"] = "Kill requested; cancelling after the current Gamma page."
    else:
        raise ValueError("Unknown Universal Scan control action.")
    save_state(session, user_id, state)
    if action == "kill":
        return finish_run(
            session,
            user_id,
            str(state["run_id"]),
            total_events=int(state["progress_events"]),
            cancelled=True,
        )
    return state


def finish_run(
    session: Session,
    user_id: int,
    run_id: str,
    *,
    total_events: int | None = None,
    error: str | None = None,
    cancelled: bool = False,
) -> dict[str, Any]:
    settings = read_settings(_settings_record(session, user_id))
    state = read_state(_state_record(session, user_id))
    finished_at = utc_now().isoformat()
    status = "cancelled" if cancelled else "failed" if error else "completed"
    history = []
    found = False
    for item in state["history"]:
        if isinstance(item, dict) and item.get("id") == run_id:
            history.append({**item, "status": status, "completed_at": finished_at,
                            "total_events": total_events, "error": error})
            found = True
        else:
            history.append(item)
    if not found:
        history.insert(0, {"id": run_id, "status": status, "triggered_by": "scheduler",
                           "started_at": state.get("last_run_at"), "completed_at": finished_at,
                           "total_events": total_events, "error": error})
    state.update({
        "running": False,
        "paused": False,
        "kill_requested": False,
        "run_id": None,
        "last_completed_at": finished_at if not error and not cancelled else state.get("last_completed_at"),
        "last_total_events": (
            total_events
            if not error and not cancelled and total_events is not None
            else state.get("last_total_events")
        ),
        "last_failed_at": finished_at if error and not cancelled else state.get("last_failed_at"),
        "last_error": error if not cancelled else None,
        "progress_events": total_events if total_events is not None else state.get("progress_events", 0),
        "progress_message": (
            "Universal Scan cancelled by user."
            if cancelled
            else error
            if error
            else f"Universal Scan completed with {total_events or 0:,} events."
        ),
        "history": history[:MAX_HISTORY],
        "next_run_at": next_scheduled_time(
            utc_now(), start_at=settings["start_at"], refresh_minutes=settings["refresh_minutes"]
        ).isoformat() if settings["enabled"] else None,
    })
    save_state(session, user_id, state)
    return state


def export_directory() -> Path:
    configured = os.environ.get("BULLPEN_STAGE_ONE_EXPORT_DIRECTORY", "").strip()
    return Path(configured) if configured else Path.home() / ".local/share/credx-bullpen-stage-one-exports"


def latest_completed_universal_export(
    user_id: int,
    *,
    export_id: str | None = None,
) -> tuple[dict[str, Any], Path] | None:
    """Resolve the immutable Universal Scan selected by a workflow trigger."""

    directory = export_directory()
    owner_hash = hashlib.sha256(f"{user_id}:universal".encode()).hexdigest()
    candidates: list[tuple[datetime, dict[str, Any], Path]] = []
    metadata_paths = (
        [directory / f"{export_id}.json"]
        if export_id
        else directory.glob("*.json")
    )
    for metadata_path in metadata_paths:
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if (
            metadata.get("ownerHash") != owner_hash
            or not metadata.get("universalSource")
            or not metadata.get("completed")
        ):
            continue
        updated_at = parse_datetime(metadata.get("updatedAt")) or datetime.min.replace(
            tzinfo=UTC
        )
        candidates.append((updated_at, metadata, metadata_path))
    if not candidates:
        return None
    _, metadata, metadata_path = max(candidates, key=lambda item: item[0])
    rows_path = metadata_path.with_suffix(".jsonl")
    if not rows_path.is_file():
        return None
    return metadata, rows_path


def _optional_float(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def iter_universal_scan_markets(
    user_id: int,
    *,
    export_id: str | None = None,
) -> tuple[dict[str, Any], Iterator[Any]]:
    """Stream the latest completed Universal Scan as canonical ScannedMarket rows."""

    resolved = latest_completed_universal_export(user_id, export_id=export_id)
    if resolved is None:
        raise FileNotFoundError("No completed Universal Polymarket Scan is available.")
    metadata, rows_path = resolved

    def rows() -> Iterator[Any]:
        from app.domains.polymarket_auto_live.scanner import ScannedMarket

        with rows_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    envelope = json.loads(line)
                    if isinstance(envelope, dict) and isinstance(
                        envelope.get("compressedRowV1"), str
                    ):
                        payload = json.loads(
                            zlib.decompress(
                                base64.b64decode(envelope["compressedRowV1"])
                            ).decode("utf-8")
                        )
                    else:
                        payload = envelope
                    candidate = payload.get("candidate", {})
                    market = payload.get("market", {})
                    event = payload.get("event", {})
                    if not isinstance(candidate, dict) or not isinstance(market, dict):
                        continue
                    event = event if isinstance(event, dict) else {}
                    outcomes = candidate.get("outcomeLabels")
                    if not isinstance(outcomes, list):
                        outcomes = market.get("outcomes")
                    outcome_labels = (
                        [str(item) for item in outcomes]
                        if isinstance(outcomes, list)
                        else ["Yes", "No"]
                    )
                    market_id = str(
                        candidate.get("marketId")
                        or candidate.get("conditionId")
                        or candidate.get("id")
                        or ""
                    ).strip()
                    question = str(candidate.get("question") or "").strip()
                    if not market_id or not question:
                        continue
                    raw = {**market, "_export_event": event}
                    yield ScannedMarket(
                        market_id=market_id,
                        question=question,
                        market_url=candidate.get("marketUrl"),
                        slug=candidate.get("slug"),
                        close_time=candidate.get("closeTime"),
                        theme=str(candidate.get("category") or "Uncategorized"),
                        current_yes_odds=_optional_float(candidate.get("yesOdds")),
                        current_no_odds=_optional_float(candidate.get("noOdds")),
                        volume_usd=_optional_float(candidate.get("volume")),
                        liquidity_usd=_optional_float(candidate.get("liquidity")),
                        description=candidate.get("rules") or market.get("description"),
                        outcome_labels=outcome_labels,
                        event_slug=event.get("slug"),
                        best_bid_cents=_optional_float(candidate.get("bestBidCents")),
                        best_ask_cents=_optional_float(candidate.get("bestAskCents")),
                        spread_cents=_optional_float(candidate.get("spreadCents")),
                        volume_24hr_usd=_optional_float(candidate.get("volume24hr")),
                        force_include=False,
                        raw=raw,
                    )
                except (ValueError, TypeError, KeyError, zlib.error):
                    continue

    return metadata, rows()


class UniversalExportWriter:
    def __init__(self, user_id: int, *, started_at: datetime):
        self.user_id = user_id
        self.started_at = started_at
        self.export_id = str(uuid4())
        self.directory = export_directory()
        self.rows_path = self.directory / f"{self.export_id}.jsonl"
        self.filtered_path = self.directory / f"{self.export_id}.filtered.jsonl"
        self.metadata_path = self.directory / f"{self.export_id}.json"
        self.handle = None
        self.count = 0
        self.sample: list[dict[str, Any]] = []
        self.identity_keys: set[str] = set()
        self.pages = 0

    def __enter__(self) -> "UniversalExportWriter":
        self.directory.mkdir(parents=True, exist_ok=True)
        self.handle = self.rows_path.open("x", encoding="utf-8")
        self.filtered_path.write_text("", encoding="utf-8")
        return self

    def add(self, market: Any) -> None:
        raw = market.raw if isinstance(market.raw, dict) else {}
        event = raw.get("_export_event") if isinstance(raw.get("_export_event"), dict) else {}
        market_raw = {key: value for key, value in raw.items() if key not in {"_export_event", "events", "_scan_export_data"}}
        condition_id = market_raw.get("conditionId") or market_raw.get("condition_id")
        question_id = market_raw.get("questionID") or market_raw.get("question_id")
        close = parse_datetime(market.close_time)
        days = ((close - self.started_at).total_seconds() / 86400) if close else None
        candidate = {
            "id": str(question_id or condition_id or market.market_id),
            "question": market.question,
            "conditionId": str(condition_id) if condition_id else None,
            "marketId": market.market_id,
            "questionId": str(question_id) if question_id else None,
            "closeTime": market.close_time,
            "category": market.theme,
            "yesOdds": market.current_yes_odds,
            "noOdds": market.current_no_odds,
            "volume": str(market.volume_usd) if market.volume_usd is not None else None,
            "liquidity": str(market.liquidity_usd) if market.liquidity_usd is not None else None,
            "volume24hr": str(market.volume_24hr_usd) if market.volume_24hr_usd is not None else None,
            "spreadCents": market.spread_cents,
            "sourceUrl": "https://gamma-api.polymarket.com/events/keyset",
            "slug": market.slug,
            "marketUrl": market.market_url,
            "outcomeLabels": list(market.outcome_labels),
            "outcomeCount": len(market.outcome_labels),
            "isBinaryYesNo": {label.strip().lower() for label in market.outcome_labels} == {"yes", "no"},
            "daysUntilClose": days,
            "rules": market.description,
            "marketContext": market_raw.get("description"),
            "resolutionSource": market_raw.get("resolutionSource") or event.get("resolutionSource"),
        }
        row = {"candidate": candidate, "event": event, "market": market_raw,
               "scanStatus": "passed", "filterReasons": [],
               "forceIncluded": False, "forceIncludedPosition": False}
        encoded = base64.b64encode(zlib.compress(
            json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 1
        )).decode("ascii")
        assert self.handle is not None
        self.handle.write(json.dumps({"compressedRowV1": encoded}, separators=(",", ":")) + "\n")
        self.count += 1
        if len(self.sample) < 500:
            self.sample.append(candidate)
        for value in (condition_id, market.market_id, market.slug, candidate["id"]):
            if value:
                self.identity_keys.add(str(value).strip().lower())

    def set_pages(self, _count: int, pages: int) -> None:
        self.pages = pages

    def complete(self) -> None:
        assert self.handle is not None
        self.handle.flush()
        os.fsync(self.handle.fileno())
        self.handle.close()
        self.handle = None
        completed_at = utc_now().isoformat()
        metadata = {
            "exportId": self.export_id,
            "ownerHash": hashlib.sha256(f"{self.user_id}:universal".encode()).hexdigest(),
            "universalSource": True,
            "filterPending": False,
            "createdAt": self.started_at.isoformat(),
            "updatedAt": completed_at,
            "scannedAt": self.started_at.isoformat(),
            "rowCount": self.count,
            "completed": True,
            "processedPages": [f"__AUTO_{number:06d}__" for number in range(1, self.pages + 1)],
            "identityKeys": sorted(self.identity_keys),
            "mode": "30-days",
            "sourceUrl": "https://gamma-api.polymarket.com/events/keyset",
            "sourceLabel": "Polymarket Gamma API",
            "acceptedCount": self.count,
            "rejectedCount": 0,
            "acceptedSample": self.sample,
            "rejectedSample": [],
        }
        temporary = self.metadata_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(metadata, separators=(",", ":")), encoding="utf-8")
        temporary.replace(self.metadata_path)
        self._cleanup_previous()

    def _cleanup_previous(self) -> None:
        owner_hash = hashlib.sha256(f"{self.user_id}:universal".encode()).hexdigest()
        for metadata_path in self.directory.glob("*.json"):
            if metadata_path == self.metadata_path:
                continue
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if metadata.get("ownerHash") != owner_hash or not metadata.get("universalSource"):
                continue
            old_id = metadata_path.stem
            for suffix in (".json", ".jsonl", ".filtered.jsonl"):
                (self.directory / f"{old_id}{suffix}").unlink(missing_ok=True)

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if self.handle is not None:
            self.handle.close()
        if exc_type is not None:
            self.rows_path.unlink(missing_ok=True)
            self.filtered_path.unlink(missing_ok=True)
            self.metadata_path.unlink(missing_ok=True)
