import json
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.domains.ai_providers.base import AIProviderResponse
from app.domains.scorecards import rebalance_audit as audit, rebalance_output as out
from app.domains.scorecards import rebalance_evidence as evidence
from app.domains.scorecards.rebalance_worker import execute
from app.domains.scorecards.final import calculate_final, policy
from app.domains.scorecards.scoring import project
from app.domains.scorecards.prompts import HEADERS

KEY="NSE:EXAMPLE"
AS_OF="2026-08-14T12:00:00+00:00"


def packet():
    return {"units":0,"settled":0,"price":100,"allowed":{f:[f] for f in out.FACTORS},
            "refs":{f:{"url":"https://example.test/report","as_of":AS_OF} for f in out.FACTORS}}


def record():
    return {"listing":KEY,"action":"Hold","factors":{f:{"score":0,"why":"Verified neutral evidence","ref":f} for f in out.FACTORS}}


def test_job_repair_is_bounded_and_preserves_accepted_neutral_and_receipts():
    source=record()
    del source["factors"]["technical-short"]
    patch=record()
    patch["factors"]["cruxx"]["score"]=3
    payload={"as_of":AS_OF,"listings":{KEY:packet()}}
    prompt=out.instructions(11,payload)
    responses=[AIProviderResponse(json.dumps(r),9,20,.02,"sample","example") for r in (source,patch)]
    provider=Mock()
    provider.generate.side_effect=responses
    save=Mock()
    job_result,saved=execute(provider,"example",prompt,{"rebalance_v2":11,"listings":[KEY]},save)
    assert saved["first_rows"][KEY]["technical-short"] is None
    assert saved["rows"][KEY]["cruxx"]["score"]==0
    assert saved["calls"][1]["requested"]=={KEY:["technical-short"]}
    assert saved["missing"]=={} and job_result.cost==.04 and job_result.tokens_out==40
    repeated,again=execute(provider,"example",prompt,{"rebalance_v2":11,"listings":[KEY]},save,saved)
    assert provider.generate.call_count==2 and repeated.content==job_result.content and again==saved
    job=SimpleNamespace(id=42,model="example",status="completed",error_message=None,runtime_metadata_json={"rebalance_records":saved})
    result=project("rebalance",{"stocks":[{"listing":KEY}]},[(job,0,[KEY],[],{"version":4,"packets":{KEY:packet()}})])
    row=result["rows"][0]
    assert (row["score"],row["coverage"],row["available_weight"],row["model_count"])==(50,"Complete",17,1)
    assert row["raw_rows"][0]["Units Change"]==0
    review=audit.audit_job(result["model_tables"][0])
    assert review["counts"].get("trade input missing",0)==0
    assert review["counts"]["not applicable"]>=3


def test_partial_weight_aligned_with_score_and_unsupported_research_stays_null():
    p=packet()
    r=record()
    r.update(action="Buy New",delta=2,entry=100,stop=95,target=112)
    for k in ("technical-long","fundamentals-short","fundamentals-medium-long"):
        p["allowed"][k]=[]
    for f,v in zip(out.FACTORS,(2,3,2,1,1,1)):
        r["factors"][f]["score"]=v
    rows=out.validated(json.dumps(r),{KEY:p})
    assert not out.repairable(rows,{KEY:p})
    job=SimpleNamespace(id=3,status="partial",model="example",runtime_metadata_json={"rebalance_records":{"rows":rows}})
    result=project("rebalance",{"stocks":[{"listing":KEY}]},[(job,0,[KEY],[],{"version":4,"packets":{KEY:p}})])
    row=result["rows"][0]
    assert row["coverage"]=="Partial" and row["available_weight"]==12 and row["score"]==pytest.approx(84.7222,abs=.001)
    assert row["raw_rows"][0]["Total Buy Amount"]==200
    assert audit.coverage_counts(result["rows"])==dict(assessed=1,complete=0,provisional=1,unassessed=0)


def test_bad_buy_sizing_cannot_make_a_trade_eligible_and_legacy_hold_replays():
    p=packet()
    r=record()
    r.update(action="Buy New",delta=4,target=110,entry=100,stop=101)
    for factor in r["factors"].values():
        factor["score"]=3
    saved=out.validated(json.dumps(r),{KEY:p})
    assert out.issues(saved,{KEY:p})=={KEY:["stop"]}
    job=SimpleNamespace(id=3,status="partial",model="example",runtime_metadata_json={"rebalance_records":{"rows":saved}})
    manifest={"stocks":[{"listing":KEY,"units":0,"settled":0}]}
    result=project("rebalance",manifest,[(job,0,[KEY],[],{"version":4,"packets":{KEY:p}})])
    final=calculate_final(manifest,{"rebalance":result},policy({"rebalance":100,"technical":0,"threats":0,"pairwise":0},{}))[0]
    assert final["status"]=="Complete" and not final["trade_eligible"] and final["suggested_units"] is None
    base=dict.fromkeys(HEADERS["rebalance"],1)
    base.update({"Exchange Symbol":"NSE","Stock Symbol":"EXAMPLE",out.ACTION_HEADER:"Hold","Upside Horizon (% return)":"-"})
    result={"card":"rebalance","rows":[],"model_tables":[{"job_id":1,"rows":[base]}]}
    assert audit.replay(result)["rebalance_audit"]["jobs"][0]["counts"]=={"not applicable":1}
    assert "rebalance_audit" not in result


def test_reject_duplicate_listing_boolean_score_and_cross_listing_source():
    p=packet()
    r=record()
    r["factors"]["cruxx"]["score"]=True
    r["factors"]["technical-short"]["ref"]="unrelated"
    accepted=out.validated(json.dumps(r),{KEY:p})[KEY]
    assert accepted["cruxx"] is None and accepted["technical-short"] is None
    assert not out.read_records(json.dumps([r,r]),{KEY:p})


@pytest.mark.anyio
async def test_source_date_and_nse_xbrl_financial_fields(monkeypatch):
    xml=b'<x><context id="q"><period><startDate>2026-04-01</startDate><endDate>2026-06-30</endDate></period></context><RevenueFromOperations contextRef="q" unitRef="INR">1234</RevenueFromOperations></x>'
    link="https://nsearchives.nseindia.com/corporate/xbrl/EXAMPLE.xml"
    async def download(client,url):
        if url==link:
            return xml
        return json.dumps({"data":[{"symbol":"EXAMPLE","xbrl":link,"broadcast_Date":"14-Aug-2026 14:00:00"},
                                   {"symbol":"EXAMPLE","xbrl":"https://nsearchives.nseindia.com/future.xml","broadcast_Date":"20-Aug-2026 14:00:00"}]}).encode()
    monkeypatch.setattr(evidence,"download",download)
    docs=await evidence.filings(None,"EXAMPLE",datetime.fromisoformat(AS_OF))
    assert docs[0]["url"]==link and docs[0]["facts"][0]["values"]["RevenueFromOperations"]==[1234.0,"INR"]


from test_auto_rebalance_audit_durability import audit_db, anyio_backend
from app.domains.scorecards import storage
from app.domains.scorecards.coverage import available


@pytest.mark.anyio
async def test_dashboard_uses_exact_saved_final_reference(audit_db):
    async with audit_db.sessions() as db:
        rev=await storage.append(db,7001,"revision","r",{"manifest":{"stocks":[{},{}]}})
        rows=[{"listing":KEY,"score":50,"coverage":"Partial","action":"Hold"}]
        def saved(rows):
            return {"card":"rebalance","result":{"rows":rows,"status":"partial"}}
        old=await storage.append(db,7001,"attempt","old",saved(rows),revision_id=rev.id)
        new=await storage.append(db,7001,"attempt","new",saved(rows+[{"score":0,"coverage":"Complete","action":"Sell All"}]),revision_id=rev.id)
        final=await storage.append(db,7001,"final","f",{"result":{"attempts":{"rebalance":old.id},
             "rows":[{"status":"Provisional","action":"Hold","sizing_reason":"Incomplete positive-weight scores"}]}},revision_id=rev.id)
        await db.commit()
        report=await available(db,7,"india",42)
        assert report["cards"]["rebalance"]["output_id"]==new.id
        assert report["final_summary"]==dict(id=final.id,rebalance_output=old.id,rebalance_inputs=1,assessed=1,complete=0,eligible=0,holds=0,blocked=1)


def test_legacy_repair_preserves_known_votes_and_complete_rows():
    from app.domains.scorecards.rebalance_recovery import combine, gaps, with_evidence
    base=dict.fromkeys(out.R_WEIGHTS,2)
    base.update({"fundamentals-short":None,"action":1.5})
    complete={"listing":"NSE:COMPLETE","signed_terms":dict.fromkeys(out.R_WEIGHTS,1),"coverage":"Complete","action":"Hold"}
    parent={"id":11,"rows":[{"listing":KEY,"signed_terms":base,"action":"Buy New","model_count":2},complete]}
    requested=gaps(parent)
    assert requested=={KEY:["fundamentals-short"]}
    assert with_evidence(requested,{KEY:packet()})==requested
    child={"rows":[{"listing":KEY,"signed_terms":{"fundamentals-short":0,"cruxx":-3,"action":-2.5},"action":"Sell All"}],"model_tables":[]}
    repaired=combine(parent,child,requested)
    row=repaired["rows"][0]
    assert row["coverage"]=="Complete" and row["model_count"]==2 and row["action"]=="Buy New"
    assert row["signed_terms"]["cruxx"]==2 and row["signed_terms"]["fundamentals-short"]==0
    assert repaired["rows"][1]==complete and parent["rows"][0]["signed_terms"]["fundamentals-short"] is None


def test_rebalance_source_readiness_reproduces_the_two_distinct_gap_patterns():
    from app.domains.scorecards.rebalance_readiness import checklist
    packets={}
    for i in range(34):
        p=packet()
        p["allowed"]={f:[f] if i<19 and f in ("cruxx","technical-short","technical-medium") else [] for f in out.FACTORS}
        packets[str(i)]=p
    check=checklist({"packets":packets})
    assert (check["ready"],check["provisional"],check["awaiting"])==(0,19,15)
    packets["0"]=packet()
    assert checklist({"packets":packets})["ready"]==1


def test_all_pages_repair_thesis_once_per_slot_and_do_not_recharge_checkpoints():
    keys=[f"NSE:T{i}" for i in range(34)]
    packets={k:packet() for k in keys}
    provider=Mock()
    requests=[]
    def generate(model,prompt):
        page=json.loads(prompt.splitlines()[-1])
        repair=page.get("repair_fields")
        items=[]
        for k in page["listings"]:
            r={**record(),"listing":k}
            if not repair:
                r["factors"].pop("cruxx")
            else:
                assert repair[k]==["cruxx"]
            items.append(r)
        requests.append(list(page["listings"]))
        return AIProviderResponse(json.dumps(items),1,1,0.01,"test",model)
    provider.generate.side_effect=generate
    opts={"rebalance_v2":1,"listings":keys}
    prompt=out.instructions(1,{"as_of":AS_OF,"listings":packets})
    _,saved=execute(provider,"fixture",prompt,opts,lambda _:None)
    assert list(map(len,requests))==[21,13,21,13] and not saved["missing"]
    replay,_=execute(provider,"fixture",prompt,opts,lambda _:None,saved)
    assert len(requests)==4 and replay.cost==pytest.approx(.04)


def test_same_venue_alias_verified_and_financial_periods_compatible():
    from app.domains.scorecards.rebalance_identity import aliases
    from app.domains.scorecards.rebalance_filings import comparable,period_documents
    listings=[{"listing":"NSE:A_B","name":"A & B Limited"}]
    master={"NSE:A&B":{"isin":"INE123456789","name":"A and B Ltd"},"BSE:A&B":{"isin":"INE123456789","name":"A and B Ltd"}}
    assert aliases(listings,master)=={"NSE:A_B":"NSE:A&B"}
    assert not aliases([{"listing":"NSE:A_B","name":"Different issuer"}],master)
    one={"period":["2026-04-01","2026-06-30"],"values":{"Revenue":[1,"INR"]}}
    two={"period":["2026-01-01","2026-03-31"],"values":{"Revenue":[2,"INR"]}}
    assert comparable([one,two])
    a={"scope":"standalone","url":"a","as_of":AS_OF,"facts":[one]}
    b={**a,"url":"b","facts":[two]}
    assert period_documents([a,b])[0]["comparison_source"]["url"]=="b"
    assert not comparable(period_documents([a,{**b,"scope":"consolidated"}])[0]["facts"])


@pytest.mark.anyio
async def test_free_recovery_publishes_child_once_without_touching_scores(audit_db,monkeypatch):
    from app.domains.scorecards import rebalance_readiness as ready
    async with audit_db.sessions() as db:
        rev=await storage.append(db,7001,"revision","source",{"manifest":{"stocks":[{"listing":KEY}]}})
        packet_doc=await storage.append(db,7001,"packet","prepared",{"research":{"packets":{KEY:packet()}}},revision_id=rev.id)
        old=await storage.append(db,7001,"attempt","old",{"card":"rebalance","settings":{"targets":[]},
            "result":{"id":0,"card":"rebalance","status":"unassessed","rows":[{"listing":KEY,"score":None,"coverage":"Unassessed"}]}},revision_id=rev.id)
        await db.commit()
        from unittest.mock import AsyncMock
        monkeypatch.setattr(ready,"prepare",AsyncMock(return_value=packet_doc))
        child=await ready.recover(db,old,7,"fixture")
        assert child["rebalance_readiness"]["ready"]==1 and child["rebalance_readiness"]["repairable"]==1
        assert child["jobs"]==0 and child["rows"]==old.result_json["rows"] and child["id"]!=old.id
        assert (await ready.recover(db,old,7,"fixture"))["id"]==child["id"]


@pytest.mark.anyio
async def test_bse_fallback_filters_publication_time_and_preserves_period_sources(monkeypatch):
    from unittest.mock import AsyncMock
    from app.domains.scorecards import rebalance_filings as feeds
    xml=b'<x><context id="q"><period><startDate>2026-04-01</startDate><endDate>2026-06-30</endDate></period></context><RevenueFromOperations contextRef="q" unitRef="INR">123</RevenueFromOperations><ISIN>INE123456789</ISIN></x>'
    response=Mock()
    response.json.return_value={"Table":[{"filing_date_time":"2026-08-14T09:33:12.12","xbrlurl":"/XBRLFILES/finance/a.html"},
        {"filing_date_time":"2026-08-15T09:30:00","xbrlurl":"/XBRLFILES/finance/future.html"}]}
    client=Mock(get=AsyncMock(return_value=response))
    fetch=AsyncMock(return_value=xml)
    monkeypatch.setattr(feeds,"download",fetch)
    docs=await feeds.bse_filings(client,"500000","INE123456789",datetime.fromisoformat(AS_OF))
    assert len(docs)==1 and docs[0]["url"]=="https://www.bseindia.com/XBRLFILES/finance/a.xml"
    assert fetch.await_count==1


def test_buy_plan_is_required_for_full_completion_even_with_all_factors():
    p=packet()
    job_record=record()
    job_record.update(action="Buy New",delta=1,entry=100,stop=105,target=120)
    accepted=out.validated(json.dumps(job_record),{KEY:p})
    job=SimpleNamespace(id=1,model="fake",status="partial",runtime_metadata_json={"rebalance_records":{"rows":accepted}})
    result=out.project({"stocks":[{"listing":KEY}]},[(job,0,[KEY],[],{"packets":{KEY:p}})])
    assert result["rows"][0]["available_weight"]==17 and result["rows"][0]["coverage"]=="Partial"
