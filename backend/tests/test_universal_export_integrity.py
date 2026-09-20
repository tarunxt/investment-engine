import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from app.domains.trading_bots.universal_scan import (
    UniversalExportWriter, archive_directory, iter_universal_scan_markets,
    latest_completed_universal_export, validate_export,
)


@pytest.fixture
def storage(tmp_path, monkeypatch):
    monkeypatch.setenv("BULLPEN_STAGE_ONE_EXPORT_DIRECTORY", str(tmp_path / "exports"))
    monkeypatch.setenv("UNIVERSAL_SCAN_ARCHIVE_DIRECTORY", str(tmp_path / "archive"))
    return tmp_path


def capture():
    now = datetime.now(UTC)
    market = SimpleNamespace(
        market_id="test-market", question="Will the proposal pass?", raw={},
        close_time=(now + timedelta(days=1)).isoformat(), theme="Politics",
        current_yes_odds=95, current_no_odds=5, volume_usd=10000,
        liquidity_usd=10000, volume_24hr_usd=10000, spread_cents=1,
        slug="proposal", market_url=None, outcome_labels=["Yes", "No"], description="rules",
    )
    with UniversalExportWriter(42, started_at=now) as writer:
        pending = json.loads(writer.metadata_path.read_text())
        assert pending["universalSource"] and not pending["completed"]
        writer.add(market)
        writer.complete()
    return writer


def test_capture_publishes_validated_manifest_and_retains_previous(storage):
    first = capture()
    second = capture()
    assert first.rows_path.exists() and second.rows_path.exists()
    metadata = json.loads(first.metadata_path.read_text())
    assert metadata["manifestVersion"] == 2
    assert validate_export(metadata, first.rows_path)
    assert validate_export(metadata, archive_directory() / first.rows_path.name)


def test_missing_primary_recovers_exact_archive(storage):
    writer = capture()
    writer.rows_path.unlink()
    metadata, rows = iter_universal_scan_markets(42, export_id=writer.export_id)
    assert metadata["exportId"] == writer.export_id
    assert len(list(rows)) == 1


def test_same_size_corruption_recovers_archive(storage):
    writer = capture()
    original = writer.rows_path.read_bytes()
    writer.rows_path.write_bytes(b"x" * (len(original) - 1) + b"\n")
    _, rows = iter_universal_scan_markets(42, export_id=writer.export_id)
    assert len(list(rows)) == 1


def test_bad_source_never_becomes_zero_filters(storage):
    writer = capture()
    for directory in (writer.directory, archive_directory()):
        rows_path = directory / writer.rows_path.name
        rows_path.write_text("{}\n")
    assert latest_completed_universal_export(42, export_id=writer.export_id) is None
    with pytest.raises(FileNotFoundError, match="UPS_SOURCE_UNAVAILABLE"):
        iter_universal_scan_markets(42, export_id=writer.export_id)


def test_owner_isolation_and_no_fallback_to_older_id(storage):
    first = capture()
    second = capture()
    assert latest_completed_universal_export(43, export_id=second.export_id) is None
    second.rows_path.unlink()
    (archive_directory() / second.rows_path.name).unlink()
    assert latest_completed_universal_export(42, export_id=second.export_id) is None
    assert latest_completed_universal_export(42, export_id=first.export_id) is not None


def test_filter_ledger_reconciles_every_source_row(storage):
    import asyncio
    from app.domains.polymarket_auto_live.console_profile import scan_console_profile_markets
    writer = capture()
    result = asyncio.run(scan_console_profile_markets(
        now=datetime.now(UTC), universal_scan_user_id=42, universal_scan_export_id=writer.export_id,
    ))
    ledger = result.filter_ledger
    assert ledger["expected_rows"] == ledger["evaluated_rows"] == 1
    assert ledger["accepted_rows"] + ledger["rejected_rows"] == 1
    assert ledger["source_sha256"] == writer.rows_sha256
