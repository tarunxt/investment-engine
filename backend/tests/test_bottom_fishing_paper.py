from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

from app.domains.bottom_fishing.engine import paper_cycle, roll
from app.domains.bottom_fishing.store import Settings
from app.domains.bottom_fishing.strategy import WEIGHTS, evaluate, exit_fill, quantity, support

ZONE = ZoneInfo("Asia/Kolkata")
T = datetime(2026,11,25,9,30,tzinfo=ZONE)


def pattern():
    bars = [dict(as_of=(T-timedelta(days=21-i)).isoformat(), low=104, high=108, close=106, volume=1000000)
            for i in range(20)]
    bars[1].update(high=125)
    bars[2].update(low=100)
    bars[5].update(high=120)
    bars[10].update(low=101)
    return dict(support(bars,.05), member=True, isin="INE000000001")


def candle(t,close,low=None):
    return dict(end=t.isoformat(),open=close,low=low or close,high=close,close=close)


def cycle(state,t,price,previous,*,settings=None,scan=None):
    frames = {"NSE:A":[candle(t-timedelta(minutes=5),previous),candle(t,price)],
              "NSE:NIFTYBEES":[candle(t,100)]}
    return paper_cycle(state,settings or Settings().model_dump(),t,{"NSE:A":pattern()} if scan else {},
                       frames,{"NSE:A":dict(roce=30,sales=30,profit=30,leverage=0)},100,scan,
                       {t.date().isoformat():t.isoformat()})


def test_source_isolation_and_morning_setup_survives_recovery():
    with pytest.raises(ValidationError):
        Settings(inputs=["swing"])
    s=cycle(roll({},T),T,101,102,scan={"covered":500})
    assert s["setups"]["NSE:A"]["discovery"]==101
    later=T.replace(hour=13,minute=15)
    s=cycle(s,later,105,104,scan={"covered":500})
    assert s["setups"]["NSE:A"]["discovered"]==T.isoformat()
    assert len(s["scans"])==2
    s=cycle(s,later+timedelta(minutes=5),99,105)
    assert s["rows"][0]["reason"]=="Support broken"


def test_risk_combines_pending_and_open_and_requires_fresh_crossing():
    assert quantity(100000,{"A":{"qty":100,"risk":10,"price":200}},
                    {"B":{"qty":20,"risk":10,"price":200}},200,8)==37
    setup=dict(pattern(),discovery=101)
    f=dict(roce=25,sales=25,profit=25,leverage=0)
    row=evaluate(setup,109,109,0,f,WEIGHTS)
    assert row["reason"]=="Waiting for fresh breakout"
    assert evaluate(setup,109,107,0,f,WEIGHTS)["reason"]=="Reward/risk below 2 after costs"


def test_empty_inputs_keep_existing_exit_and_gap_loss():
    s=roll({},T)
    s["positions"]["NSE:A"]=dict(qty=10,price=102,stop=99,target=115,entry=T.isoformat(),checked=T.isoformat())
    s=cycle(s,T+timedelta(minutes=5),95,102,settings=Settings(inputs=[]).model_dump())
    assert not s["rows"] and not s["positions"]
    assert s["closed"][0]["price"]==95 and s["realized"]< -70
    assert exit_fill(dict(stop=99,target=115),dict(low=98,high=116,open=102,close=114),False)==(99,"Stop")


def test_breakout_creates_only_one_paper_reservation_and_preserves_frozen_levels():
    s=roll({},T)
    setup=dict(pattern(),breakout=104.05,discovery=100,discovered=T.isoformat())
    s["setups"]["NSE:A"]=setup
    bar_time=T+timedelta(minutes=10)
    cycle(s,bar_time,104.1,103.5)
    assert s["rows"][0]["reason"]=="Paper limit pending"
    assert 0<s["pending"]["NSE:A"]["qty"]<=96
    cycle(s,bar_time,104.1,103.5)
    assert not s["pending"] and s["rows"][0]["reason"]=="Already held or attempted today"
    assert "score" not in evaluate(setup,104.1,103.5,0,None,WEIGHTS)
