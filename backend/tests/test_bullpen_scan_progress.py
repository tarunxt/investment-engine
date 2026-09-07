import pytest
from app.domains.polymarket_auto_live.scanner import ScannedMarket, scan_candidate_markets

@pytest.mark.asyncio
async def test_keyset_scan_preserves_successful_pages_after_later_page_failure(
    monkeypatch,
):
    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

    market = ScannedMarket(
        market_id="preserved-market",
        question="Will the first page be preserved?",
        market_url=None,
        slug="preserved-market",
        close_time="2026-09-30T00:00:00Z",
        theme="Other",
        current_yes_odds=50,
        current_no_odds=50,
        volume_usd=None,
        liquidity_usd=None,
        description=None,
        outcome_labels=["Yes", "No"],
        event_slug=None,
        best_bid_cents=None,
        best_ask_cents=None,
        spread_cents=None,
        raw={"id": "preserved-market"},
    )
    calls = 0

    async def fake_keyset_page(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return [{"id": "preserved-market"}], "page-2"
        raise RuntimeError("page 2 unavailable")

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.scanner.httpx.AsyncClient",
        lambda **_kwargs: FakeClient(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.scanner._fetch_gamma_keyset_page",
        fake_keyset_page,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.scanner._normalize_market",
        lambda *_args, **_kwargs: market,
    )

    progress = []
    result = await scan_candidate_markets(
        min_liquidity_usd=0,
        apply_base_filters=False,
        use_keyset_pagination=True,
        preserve_partial_on_error=True,
        progress_callback=lambda markets, pages: progress.append((markets, pages)),
    )

    assert [row.market_id for row in result.accepted] == ["preserved-market"]
    assert progress == [(1, 1)]
    assert result.complete_universe is False
    assert result.warning is not None
    assert result.details == "page 2 unavailable"


