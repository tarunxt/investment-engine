from datetime import datetime
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from lxml import html
from pydantic import ValidationError
from app.domains.bottom_fishing import cloud_score, columns, market, store
from app.domains.bottom_fishing.column_facts import statement_columns
from app.domains.bottom_fishing.discovery import Discovery, at_close, daily_pattern


def test_catalog_and_session_specific_import_by_verified_identity():
    assert len(columns.CATALOG)==len(columns.NAMES)==378
    assert set(columns.DEFAULT)<=columns.NAMES
    assert len(set(g for _,gs,_,_ in columns.CATALOG for g in gs.split()))==8
    rows=[dict(name="First",exchange="NSE",symbol="A"),dict(name="First",exchange="BSE",symbol="B")]
    assert columns.read_export("NSE Code,Name,Industry PE,Sales Qtr Rs.Cr.\nA,First,14,0\nX,Unknown,50,6",rows)=={
        "NSE:A":{"Industry PE":14,"Sales latest quarter":0}}
    with pytest.raises(HTTPException):
        columns.read_export("Name,Industry PE\nFirst,14",rows)
    with pytest.raises(ValidationError):
        columns.Selection(names=["Sales","Sales"],version=0)


def test_quarterlies_use_correct_dated_cells_and_preserve_missing():
    root=html.fromstring('<section id="quarters"><table><thead><tr><th></th><th>Sep 2025</th><th>Sep 2026</th></tr></thead>'
        '<tbody><tr><td>Sales +</td><td>100</td><td>125</td></tr><tr><td>Net Profit</td><td>8</td><td>10</td></tr>'
        '</tbody></table></section>')
    facts=statement_columns(root)
    assert facts["Sales latest quarter"]==125 and facts["Net Profit latest quarter"]==10
    assert facts["YOY Quarterly sales growth"]==25
    assert "Profit after tax preceding year quarter" not in facts and "Sales preceding quarter" not in facts


def test_configured_formulas_and_unknowns_drive_threshold():
    bars=[dict(low=100 if i in (0,5) else 107,high=120,close=108,volume=250000,as_of=f"2026-10-{i+1:02}") for i in range(20)]
    rules=Discovery()
    flags,level=daily_pattern(bars,.05,"observed",True,rules)
    assert flags["touches"] and flags["rebound"] and at_close(level,102)
    custom=Discovery(minimum=3,formulas={**rules.formulas,"liquidity":"Mean turnover > 30000000","proximity":"Close <= L"})
    flags,level=daily_pattern(bars,.05,"observed",True,custom)
    assert not flags["liquidity"] and at_close(level,110)
    strict=custom.model_copy(update=dict(minimum=4))
    _,level=daily_pattern(bars,.05,"observed",True,strict)
    assert not at_close(level,110)
    alternate=Discovery(formulas={**rules.formulas,"universe":"Nifty 200 member = 1 AND NSE equity = 1"})
    assert alternate.indices()==[200] and alternate.check("universe",nifty_200_member=1,nse_equity=1) is True
    with pytest.raises(ValidationError):
        Discovery(formulas={**rules.formulas,"liquidity":"Close > 0"})


@pytest.mark.asyncio
@pytest.mark.parametrize("minimum,expected",[(5,0),(4,0),(3,1),(2,1)])
async def test_minimum_qualifies_stage_three_with_missing_candle(monkeypatch,minimum,expected):
    stamp=datetime(2026,11,26,15,30,tzinfo=market.INDIA)
    async def daily(client,cache,cutoff,rows,discovery=None):
        rows[0].update(universe=True,liquidity=True,touches=True,rebound=False,low=100,high=110)
        return {},None,dict(universe=1,covered=1)
    monkeypatch.setattr(market,"daily",daily)
    monkeypatch.setattr(market,"candles",AsyncMock(return_value=[]))
    report=dict(rows=[dict(exchange="NSE",symbol="X")],complete=True)
    settings=store.Settings(discovery=Discovery(minimum=minimum)).model_dump()
    result=await cloud_score.finish_screen(None,None,None,{"NSE:X":"instrument"},settings,stamp,{},report,{})
    assert result["scored_at"] and len(result["rows"])==expected
    assert report["rows"][0]["qualified"]==bool(expected)
    if expected:
        assert result["rows"][0]["reason"]=="Missing current closed candle"


def test_delayed_daily_close_preserves_observed_volume_without_inventing_a_dma():
    from datetime import date,timedelta
    last=date(2026,11,26)
    history={(last-timedelta(days=i)).isoformat():[10,100] for i in range(1,381)}
    history[last.isoformat()]=[None,240]
    data=columns.price_columns(history,last.isoformat())
    assert data["Volume 1week average"]==120 and "Volume 1year average" in data
    assert "DMA 200" not in data and data["DMA 200 previous day"]==10
    history[last.isoformat()]=[12,240]
    assert columns.price_columns(history,last.isoformat())["DMA 200"]==10.01
