import copy
import pytest
from app.domains.zerodha.portfolio import (
    _as_float, _as_int, normalize_holding, normalize_position, build_portfolio_snapshot,
)

@pytest.mark.parametrize("value", [None, "", "bad", True, float("nan"), float("inf"), float("-inf")])
def test_unknown_numbers_remain_unknown(value):
    assert _as_float(value) is None
    assert _as_int(value) is None
    holding = normalize_holding({"quantity": value, "last_price": value})
    assert holding["quantity"] is None
    assert holding["last_price"] is None
    assert holding["market_value"] is None
    assert normalize_position({"quantity": value})["quantity"] is None

@pytest.mark.parametrize("value, expected", [(0, 0), ("0", 0), (-3, -3), ("12", 12)])
def test_known_integer_boundaries(value, expected):
    assert _as_int(value) == expected
    assert _as_float(value) == expected

@pytest.mark.parametrize("value", [1.5, "1.5"])
def test_fractional_quantity_is_not_truncated(value):
    assert _as_int(value) is None

def valid_holding():
    return dict(quantity=2, t1_quantity=0, last_price=10, average_price=8, pnl=4, day_change=1)

@pytest.mark.parametrize("field", ["quantity", "t1_quantity", "last_price", "average_price", "pnl", "day_change"])
@pytest.mark.parametrize("value", [None, "bad", float("nan")])
def test_partial_holding_rejected_before_snapshot(field, value):
    holding = valid_holding()
    holding[field] = value
    original = copy.deepcopy(holding)
    for _ in range(2):
        with pytest.raises(ValueError, match=rf"holdings\[1\].{field}"):
            build_portfolio_snapshot([valid_holding(), holding], {}, {"equity": {"available_margin": 0}})
    assert holding.keys() == original.keys()

@pytest.mark.parametrize("margin", [None, {}, {"equity": {}}, {"equity": {"available": {}}}, {"equity": {"available_margin": "bad"}}])
def test_unknown_margin_rejected_without_inferring_cash(margin):
    with pytest.raises(ValueError, match="margins.equity.available_margin"):
        build_portfolio_snapshot([], {}, margin)

def test_explicit_zero_is_preserved_and_inputs_unchanged():
    holding = valid_holding()
    original = copy.deepcopy(holding)
    snapshot = build_portfolio_snapshot([holding], {}, {"equity": {"available": {"live_balance": 0}}})
    assert snapshot["available_margin"] == 0
    assert snapshot["holdings_market_value"] == 20
    assert snapshot["holdings"][0]["used_quantity"] is None
    assert holding == original

def test_unusable_net_exposure_rejected():
    with pytest.raises(ValueError, match="net_positions"):
        build_portfolio_snapshot([], {"net": [{"quantity": "bad"}]}, {"equity": {"available_margin": 0}})


def test_numeric_provenance_and_legacy_schema_defaults():
    from app.domains.zerodha.schemas import ZerodhaPortfolioHolding
    holding = normalize_holding({"quantity": "bad", "last_price": 0})
    assert holding["numeric_input_status"]["quantity"] == "invalid"
    assert holding["numeric_input_status"]["last_price"] == "known"
    assert holding["numeric_input_status"]["average_price"] == "missing"
    legacy = ZerodhaPortfolioHolding(tradingsymbol="SYNTH", exchange="NSE")
    assert legacy.quantity is None
    assert legacy.numeric_input_status == {}


def test_normalization_does_not_modify_source_records():
    source = {"quantity": "bad", "last_price": None, "raw_marker": "synthetic"}
    original = copy.deepcopy(source)
    normalize_holding(source)
    normalize_position(source)
    assert source == original


def test_repeated_invalid_sync_does_not_replace_saved_snapshot(monkeypatch):
    from datetime import datetime, timedelta, timezone
    from types import SimpleNamespace
    from app.domains.zerodha import tasks

    calls, events = [], []

    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def commit(self): pass

    class Credentials:
        def __init__(self, db): pass
        def get_by_user(self, user_id):
            return SimpleNamespace(expires_at=datetime.now(timezone.utc) + timedelta(hours=1))
        def get_plaintext_token(self, user_id): return "synthetic-unused-token"

    class Snapshots:
        def __init__(self, db): pass
        def upsert_snapshot(self, *args):
            calls.append(args)
            raise AssertionError("Invalid source must never reach persistence")

    class Audit:
        def __init__(self, db): pass
        def log(self, user_id, event, **kwargs): events.append((event, kwargs))

    class Service:
        def get_holdings_sync(self, token): return [{**valid_holding(), "quantity": "bad"}]
        def get_positions_sync(self, token): return {"net": [], "day": []}
        def get_margins_sync(self, token): return {"equity": {"available_margin": 0}}

    class RetryStopped(Exception): pass
    def retry(**kwargs): raise RetryStopped()
    monkeypatch.setattr(tasks, "SyncSessionLocal", Session)
    monkeypatch.setattr(tasks, "SyncZerodhaCredentialRepository", Credentials)
    monkeypatch.setattr(tasks, "SyncZerodhaPortfolioSnapshotRepository", Snapshots)
    monkeypatch.setattr(tasks, "SyncZerodhaAuditRepository", Audit)
    monkeypatch.setattr(tasks, "_svc", Service())
    monkeypatch.setattr(tasks.sync_portfolio_snapshot_task, "retry", retry)
    for _ in range(2):
        with pytest.raises(RetryStopped):
            tasks.sync_portfolio_snapshot_task.run(1, source="synthetic")
    assert calls == []
    assert [event for event, _ in events] == ["portfolio_sync_failed", "portfolio_sync_failed"]
    assert all("holdings[0].quantity" in details["details"]["error"] for _, details in events)


def test_integer_normalization_preserves_exact_source_units():
    assert _as_int(9007199254740993) == 9007199254740993
    assert _as_int("9007199254740993") == 9007199254740993


def test_overflowed_aggregate_is_rejected_before_persistence():
    huge = {**valid_holding(), "quantity": 1, "last_price": 1e308}
    with pytest.raises(ValueError, match="snapshot.holdings_market_value"):
        build_portfolio_snapshot([huge, huge], {}, {"equity": {"available_margin": 0}})


@pytest.mark.parametrize("margin", [None, 0])
def test_summary_and_detail_bindings_preserve_nullable_margin_and_numeric_provenance(margin):
    from datetime import date, datetime, timezone
    from types import SimpleNamespace
    from app.domains.zerodha.router import _snapshot_summary, _snapshot_detail
    holding = normalize_holding({"tradingsymbol": "SYNTH", "exchange": "NSE", "quantity": 0})
    snapshot = SimpleNamespace(
        snapshot_date=date(2026, 10, 20), captured_at=datetime(2026, 10, 20, tzinfo=timezone.utc),
        source="synthetic", holdings_count=1, net_positions_count=0, day_positions_count=0,
        holdings_market_value=0, holdings_invested_value=None, holdings_pnl=0,
        holdings_day_change_value=0, available_margin=margin, positions_pnl=0, positions_m2m=0,
        holdings=[holding], net_positions=[], day_positions=[],
    )
    assert _snapshot_summary(snapshot).available_margin == margin
    detail = _snapshot_detail(snapshot)
    assert detail.available_margin == margin
    assert detail.holdings[0].quantity == 0
    assert detail.holdings[0].last_price is None
    assert detail.holdings[0].numeric_input_status["last_price"] == "missing"
