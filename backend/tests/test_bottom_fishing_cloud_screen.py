from datetime import datetime
from unittest.mock import AsyncMock

import pytest

from app.domains.bottom_fishing import cloud_screen


def test_cloud_universe_is_independent_of_index_and_deduplicates():
    ordinary = {"isin":"INE179A01014","series":"EQ"}
    assert cloud_screen.listings({"BSE:A":ordinary, "NSE:A":ordinary,
                                 "BSE:ONLY":{"isin":"INE121A01024","series":"A"},
                                 "NSE:BOND":{"isin":"INE179A07020","series":"EQ"}}) == ["NSE:A","BSE:ONLY"]


@pytest.mark.asyncio
async def test_cloud_scans_query_before_discovery_and_removes_old_matches(monkeypatch):
    stamp = datetime(2026,11,26,14,45,tzinfo=cloud_screen.INDIA)
    master = {"NSE:FIRST":{"isin":"INE179A01014","series":"EQ","name":"First"},
              "NSE:SECOND":{"isin":"INE121A01024","series":"EQ","name":"Second"}}
    monkeypatch.setattr(cloud_screen, "technical_instruments", AsyncMock(return_value=master))
    quotes = {"NSE_EQ|INE179A01014":{"price":120}, "NSE_EQ|INE121A01024":{"price":80}}
    monkeypatch.setattr(cloud_screen,"quotes",AsyncMock(return_value=quotes))
    async def daily(client,cache,stamp,rows):
        for row in rows:
            row.update(universe=False,low=90,high=200,liquidity=True,touches=True,rebound=True)
    monkeypatch.setattr(cloud_screen.market,"daily",daily)
    monkeypatch.setattr(cloud_screen.market,"candles",AsyncMock(return_value=[]))
    async def scan():
        return await cloud_screen.scan(None,AsyncMock(),1,{"screen_query":"Current price > 100"},stamp,{"2026-11-25":""})
    assert [r["symbol"] for r in (await scan())["rows"]] == ["FIRST"]
    quotes["NSE_EQ|INE179A01014"]["price"] = 99
    quotes["NSE_EQ|INE121A01024"]["price"] = 101
    assert [r["symbol"] for r in (await scan())["rows"]] == ["SECOND"]
