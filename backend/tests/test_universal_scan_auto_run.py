import asyncio
import base64
from datetime import UTC, datetime, timedelta
import hashlib
import json
import zlib
from pathlib import Path
from types import SimpleNamespace

from app.domains.polymarket_auto_live.console_profile import scan_console_profile_markets
from app.domains.polymarket_auto_live.scanner import ScannedMarket
from app.domains.trading_bots.universal_scan import (
    UniversalExportWriter,
    _readable_export_directories,
    latest_completed_universal_export,
    next_scheduled_time,
    read_state,
    run_exceeded_recovery_window,
)


def test_readable_export_directories_include_stable_deploy_roots(tmp_path, monkeypatch):
    app_root = tmp_path / "current-app"
    monkeypatch.setenv("APP_ROOT", str(app_root))
    monkeypatch.delenv("BULLPEN_STAGE_ONE_EXPORT_DIRECTORY", raising=False)

    directories = _readable_export_directories()

    assert app_root / "backend/.stage-one-exports" in directories
    assert Path("/srv/investor/backend/.stage-one-exports") in directories
    assert Path("/srv/investment-engine/backend/.stage-one-exports") in directories


def test_completed_universal_export_writes_sports_participant_index(tmp_path, monkeypatch):
    monkeypatch.setenv("BULLPEN_STAGE_ONE_EXPORT_DIRECTORY", str(tmp_path))
    started_at = datetime(2026, 9, 16, tzinfo=UTC)
    market = ScannedMarket(
        market_id="lal-1",
        question="Will Real Racing Club win on 2026-09-18?",
        market_url="https://polymarket.com/event/lal-rac-bar-2026-09-18",
        slug="lal-real-racing-win",
        close_time="2026-09-18T20:00:00+00:00",
        theme="Sports",
        current_yes_odds=50,
        current_no_odds=50,
        volume_usd=1000,
        liquidity_usd=1000,
        description=None,
        outcome_labels=["Yes", "No"],
        event_slug="lal-rac-bar-2026-09-18",
        best_bid_cents=49,
        best_ask_cents=51,
        spread_cents=2,
        raw={
            "feeType": "sports_fees_v2",
            "sportsMarketType": "moneyline",
            "_export_event": {
                "slug": "lal-rac-bar-2026-09-18",
                "title": "Real Racing Club vs. FC Barcelona",
            },
        },
    )

    with UniversalExportWriter(42, started_at=started_at) as writer:
        writer.add(market)
        writer.complete()

    payload = json.loads(
        (tmp_path / f"{writer.export_id}.sports-participants.json").read_text(encoding="utf-8")
    )
    assert payload["codes"]["lal"]["participants"] == ["FC Barcelona", "Real Racing Club"]


def test_universal_scan_schedule_stays_anchored_to_configured_start():
    start = "2026-08-22T12:30:00+00:00"

    assert next_scheduled_time(
        datetime(2026, 8, 22, 12, 29, tzinfo=UTC),
        start_at=start,
        refresh_minutes=360,
    ) == datetime(2026, 8, 22, 12, 30, tzinfo=UTC)
    assert next_scheduled_time(
        datetime(2026, 8, 22, 12, 30, tzinfo=UTC),
        start_at=start,
        refresh_minutes=360,
    ) == datetime(2026, 8, 22, 18, 30, tzinfo=UTC)
    assert next_scheduled_time(
        datetime(2026, 9, 15, 13, 0, tzinfo=UTC),
        start_at=start,
        refresh_minutes=360,
    ) == datetime(2026, 9, 15, 18, 30, tzinfo=UTC)


def test_universal_scan_status_rejects_orphaned_running_state():
    now = datetime(2026, 9, 18, 10, 0, tzinfo=UTC)

    assert run_exceeded_recovery_window(
        {"running": True, "last_run_at": "2026-09-18T09:04:59+00:00"},
        now=now,
    )
    assert not run_exceeded_recovery_window(
        {"running": True, "last_run_at": "2026-09-18T09:05:01+00:00"},
        now=now,
    )
    assert run_exceeded_recovery_window(
        {"running": True, "last_run_at": None},
        now=now,
    )
    assert not run_exceeded_recovery_window(
        {"running": False, "last_run_at": "2026-09-16T00:00:00+00:00"},
        now=now,
    )


def test_status_pairs_the_latest_successful_scan_with_its_own_start_time():
    state = read_state(
        SimpleNamespace(
            payload={
                "universal_scan_auto_run": {
                    "last_run_at": "2026-09-15T18:03:44+00:00",
                    "last_completed_at": "2026-09-15T12:11:26+00:00",
                    "history": [
                        {
                            "id": "failed-later",
                            "status": "failed",
                            "started_at": "2026-09-15T18:03:44+00:00",
                        },
                        {
                            "id": "successful-source",
                            "status": "completed",
                            "started_at": "2026-09-15T12:03:41+00:00",
                            "completed_at": "2026-09-15T12:11:26+00:00",
                        },
                    ],
                }
            }
        )
    )

    assert state["last_run_at"] == "2026-09-15T18:03:44+00:00"
    assert (
        state["last_completed_run_started_at"]
        == "2026-09-15T12:03:41+00:00"
    )


def test_state_bound_export_id_recovers_historical_owner_hash(tmp_path, monkeypatch):
    monkeypatch.setenv("BULLPEN_STAGE_ONE_EXPORT_DIRECTORY", str(tmp_path))
    export_id = "00000000-0000-0000-0000-000000000042"
    metadata = {
        "exportId": export_id,
        "ownerHash": "historical-owner-hash",
        "universalSource": True,
        "completed": True,
        "createdAt": "2026-09-19T05:46:37+00:00",
        "updatedAt": "2026-09-19T06:07:02+00:00",
        "scannedAt": "2026-09-19T05:46:37+00:00",
        "rowCount": 207252,
    }
    (tmp_path / f"{export_id}.json").write_text(json.dumps(metadata), encoding="utf-8")
    (tmp_path / f"{export_id}.jsonl").write_text("{}\n", encoding="utf-8")

    assert latest_completed_universal_export(42, export_id=export_id) is None
    recovered = latest_completed_universal_export(
        42,
        export_id=export_id,
        trusted_export_id=True,
    )
    assert recovered is not None
    assert recovered[0]["rowCount"] == 207252


def test_workflow_stage1_filters_the_saved_universal_scan(tmp_path, monkeypatch):
    monkeypatch.setenv("BULLPEN_STAGE_ONE_EXPORT_DIRECTORY", str(tmp_path))
    user_id = 42
    export_id = "universal-test"
    now = datetime.now(UTC)
    metadata = {
        "exportId": export_id,
        "ownerHash": hashlib.sha256(f"{user_id}:universal".encode()).hexdigest(),
        "universalSource": True,
        "completed": True,
        "createdAt": now.isoformat(),
        "updatedAt": now.isoformat(),
        "scannedAt": now.isoformat(),
        "rowCount": 2,
    }
    (tmp_path / f"{export_id}.json").write_text(json.dumps(metadata), encoding="utf-8")

    def encoded_row(*, market_id: str, question: str, category: str) -> str:
        row = {
            "candidate": {
                "id": market_id,
                "marketId": market_id,
                "question": question,
                "closeTime": (now + timedelta(days=1)).isoformat(),
                "category": category,
                "yesOdds": 95,
                "noOdds": 5,
                "volume": "10000",
                "liquidity": "10000",
                "volume24hr": "10000",
                "spreadCents": 1,
                "outcomeLabels": ["Yes", "No"],
            },
            "event": {},
            "market": {},
        }
        compressed = base64.b64encode(
            zlib.compress(json.dumps(row).encode("utf-8"), 1)
        ).decode("ascii")
        return json.dumps({"compressedRowV1": compressed})

    (tmp_path / f"{export_id}.jsonl").write_text(
        "\n".join(
            [
                encoded_row(
                    market_id="sports-1",
                    question="Will Team A beat Team B?",
                    category="Sports",
                ),
                encoded_row(
                    market_id="politics-1",
                    question="Will the bill pass?",
                    category="Politics",
                ),
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    completed_export = latest_completed_universal_export(
        user_id,
        export_id=export_id,
    )
    assert completed_export is not None
    assert completed_export[0]["scannedAt"] == now.isoformat()

    result = asyncio.run(
        scan_console_profile_markets(
            now=now,
            universal_scan_user_id=user_id,
            universal_scan_export_id=export_id,
            exclude_sports=True,
        )
    )

    assert result.source_label == "Universal Polymarket Scan"
    assert result.total_candidates == 2
    assert [market.market_id for market in result.accepted] == ["politics-1"]
    assert [market.market_id for market in result.rejected] == ["sports-1"]
