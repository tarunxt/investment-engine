import asyncio
import base64
from datetime import UTC, datetime, timedelta
import hashlib
import json
import zlib

from app.domains.polymarket_auto_live.console_profile import scan_console_profile_markets
from app.domains.trading_bots.universal_scan import next_scheduled_time


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
