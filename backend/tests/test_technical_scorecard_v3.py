from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from app.domains.scorecards import technical_sources as sources
from app.domains.scorecards import technical_v3 as tech
from app.domains.scorecards import technical_output as output
from app.domains.scorecards.final import calculate_final, policy
from app.domains.scorecards.prompts import batches, build_prompt
from app.domains.scorecards.scoring import project
from app.domains.scorecards.technical_validation import assessment, correlation, report

CUT="2026-11-22T12:00:00+00:00"
DATES=list(sources.session_calendar(datetime.fromisoformat(CUT),"NSE",[]))
KEY="NSE:EXAMPLE"


def bars(last=None):
    return [{"kind":"daily_bar","as_of":d+"T15:30:00+05:30","open":p,"high":p+1,"low":p-1,"close":p,
             "volume":10000,"url":"https://example.org/venue/candles","basis":"venue-raw"} for d,p in zip(DATES,last or [100+i*.1 for i in range(60)])]


def calc(rows=None,index=None,actions=()):
    records=bars() if rows is None else rows
    series=tech.normalise(records,DATES,actions,CUT)
    benchmark=tech.normalise(bars() if index is None else index,DATES,[],CUT)
    out=tech.calculate(KEY,CUT,DATES,series,benchmark,tick=.05,sources={},issues=[])
    return out


def test_designed_examples_and_missing_core():
    def result(vals):
        return tech.summarize({k:{"value":v} for k,v in zip(tech.WEIGHTS,vals)})
    assert result([100,75,65,40,50])["score"]==69
    partial=result([100,75,None,40,50])
    assert (partial["score"],partial["coverage_pct"],partial["range"])==(66,80,[56,76])
    assert result([0]*5)["score"]==0
    assert result([None,50,50,50,50])["score"] is None
    assert result([0,25,35,60,50])["score"]==31


def test_trigger_boundaries_stale_duplicate_and_future_bars():
    for a,b,score,entry in [(105,107,75,"Triggered above"),(107,108,100,"Held above"),
                           (107,106,50,"Failed"),(95,93,25,"Triggered below"),(93,92,0,"Held below")]:
        rows=bars([100]*58+[a,b])
        for r in rows[:-2]:
            r.update(high=106,low=94)
        scored=calc(rows)
        assert scored["factors"]["Setup"]["value"]==score
        assert scored["readiness"]["entry"]==entry
    assert calc(bars()[:-1])["score"] is None
    assert calc(bars()+[{**bars()[-1],"volume":1}])["score"] is None
    assert calc(bars()+[{**bars()[-1],"as_of":"2029-01-01T15:30:00+05:30"}])==calc()
    assert calc(index=[])["coverage"]=="Provisional"
    assert calc(bars()[:20])["coverage"]=="Insufficient data"
    assert calc(bars()[:-1]+[{**bars()[-1],"volume":0}])["score"] is None


def test_price_volume_adjust_together_and_unresolved_actions_abstain():
    split=bars()
    for r in split[:35]:
        for p in ("open","high","low","close"):
            r[p]*=2
        r["volume"]/=2
    a=[{"date":DATES[35],"multiplier":2}]
    assert calc(split,actions=a)["factors"]==calc()["factors"]
    assert calc(split,actions=[{"date":DATES[35],"multiplier":None}])["score"] is None
    same=bars([100]*60)
    assert calc(same)["factors"]["Momentum"]["value"]==50
    unavailable=same.copy()
    unavailable[-2]={**same[-2],"volume":None}
    assert calc(unavailable)["factors"]["Volume"]["value"] is None
    assert DATES[-1]=="2026-11-20" and "2026-11-08" in DATES and "2026-11-10" not in DATES


def test_runtime_projection_full_manifest_without_llm_and_pairwise_compatibility():
    keys=[f"NSE:S{i}" for i in range(34)]
    manifest={"market":"india","stocks":[{"listing":k} for k in keys],"as_of":CUT}
    assert list(batches(manifest["stocks"],"technical",portfolio="india"))==[(keys,[])]
    ledger={k:{**calc(bars() if i<5 else []),"sources":{"stock":{"last_bar":bars()[-1] if i<5 else None}}} for i,k in enumerate(keys)}
    packet={"version":3,"technical":ledger,"listings":{k:bars() if i<5 else [] for i,k in enumerate(keys)},"calendars":{"NSE":dict.fromkeys(DATES)}}
    rev=SimpleNamespace(id=457,manifest=manifest,digest="hash")
    prompt=build_prompt(rev,"technical",keys,[],packet)
    assert output.HEADER in prompt and keys[-1] in prompt
    j=SimpleNamespace(id=7,response=None,status="failed")
    res=project("technical",manifest,[(j,0,keys,[],packet)])
    assert [r["listing"] for r in res["rows"]]==keys
    assert res["technical_counts"]=={"complete":5,"provisional":0,"insufficient":29,"expected":34,"commentary":0}
    key=keys[0]
    def text(k,ids):
        return "| "+" | ".join([k,"100","Complete","Range","Held","Trend","Volume","105",""+ids,"+1"])+" |"
    header=output.HEADER+"\n| "+" | ".join(["---"]*len(output.COLUMNS))+" |\n"
    j.response=header+text(key,"PRICE")
    j.status="partial"
    second=project("technical",manifest,[(j,0,keys,[],packet)])
    assert second["rows"][0]["score"]==res["rows"][0]["score"]
    assert second["rows"][0]["model_disagreement"]
    assert second["rows"][0]["legacy_score"]==pytest.approx(100*4/6)
    assert output.annotations(j.response+"\n"+text(key,"PRICE"),{key:["PRICE"]})[0]=={}
    assert output.annotations(header+text(key,"foreign"),{key:["PRICE"]})[0]=={}


def test_stage4_frozen_shadow_and_provisional_policy():
    manifest={"stocks":[{"listing":KEY,"units":0,"settled":0}]}
    weights={"technical":100,"pairwise":0,"threats":0,"rebalance":0}
    row={"listing":KEY,"technical_v3":{"range":[56,76],"flags":[]},"coverage":"Provisional","score":66,"legacy_score":50}
    attempt={"rows":[row],"stage4_method":"legacy"}
    cfg=policy(weights,{"technical":{"candles":1}})
    assert calculate_final(manifest,{"technical":attempt},cfg)[0]["final"]==50
    attempt["stage4_method"]="v3"
    r=calculate_final(manifest,{"technical":attempt},cfg)[0]
    assert (r["final"],r["status"],r["action"],r["suggested_units"])==(66,"Provisional",None,None)
    row.update(score=0,coverage="Complete")
    assert calculate_final(manifest,{"technical":attempt},cfg)[0]["contributions"]["technical"]==0


def test_validation_counts_unknowns_and_does_not_promote_fixtures():
    assert correlation([1,1,2,3],[1,1,2,3])==1
    assert correlation([1]*5,list(range(5))) is None
    assert assessment({},date.today())["status"]=="Unproven"
    rs=[{"listing":str(i),"issuer":str(i),"candidate":i*20,"legacy":100-i*20,"momentum":i,"outcome":(i-2)*.01,
         "direction":"Bullish","venue":"NSE","coverage":"Complete"} for i in range(6)]
    rs.append({**rs[0],"issuer":"missing","outcome":None})
    out=report({"2026-01-01":rs})
    assert out["unknown_outcomes"]==1 and out["mean_rank_ic"]["candidate"]==1

from test_auto_rebalance_audit_durability import audit_db, anyio_backend
from app.domains.scorecards import router, storage
from app.shared.exceptions import ValidationException
from unittest.mock import AsyncMock


@pytest.mark.anyio
async def test_route_keeps_data_without_available_provider_and_recovers_without_mutating_output(audit_db,monkeypatch):
    stock={"listing":KEY,"exchange":"NSE","symbol":"EXAMPLE","price":106,"origin":"holding","units":1}
    manifest={"stocks":[stock],"as_of":CUT,"market":"india","owner_id":7}
    async with audit_db.sessions() as db:
        rev=await storage.append(db,7001,"revision","v3-test",{"manifest":manifest,"digest":"base"})
        await db.commit()
        def packet(has_data):
            ledger=calc(bars() if has_data else [])
            ledger.update(listing=KEY,sources={"stock":{"last_bar":(bars()[-1] if has_data else None)}},
                          input_hash="full" if has_data else "empty",vintage="later reconstruction",session=DATES[-1])
            return {"version":3,"technical":{KEY:ledger},"listings":{KEY:bars() if has_data else []},"benchmark":[],
                    "calendars":{"NSE":dict.fromkeys(DATES)},"notices":[]}
        monkeypatch.setattr(sources,"collect",AsyncMock(return_value=packet(False)))
        monkeypatch.setattr(router,"_get_redis",lambda:AsyncMock())
        monkeypatch.setattr(router.CreateRunUseCase,"execute",AsyncMock(side_effect=ValidationException("A selected scorecard model is temporarily unavailable")))
        owner=SimpleNamespace(id=7,username="owner")
        req=router.Start(request_key="technical",sequence=42,targets=[{"provider":"deepseek","model":"deepseek-v4-flash"}])
        queued=await router.start("india",rev.id,"technical",req,db,owner)
        assert queued["run_id"] is None and queued["scoring_version"]==3
        saved=await router.attempt_result("india",queued["id"],db,owner)
        assert saved["status"]=="unassessed" and len(saved["rows"])==1
        assert await router.start("india",rev.id,"technical",req,db,owner)==queued
        from app.domains.scorecards import technical_recovery
        monkeypatch.setattr(technical_recovery,"collect",AsyncMock(return_value=packet(True)))
        recovered=await router.recover_pairs("india",queued["id"],db,owner)
        assert recovered["id"]!=queued["id"] and recovered["scored"]==1
        assert (await router.recover_pairs("india",queued["id"],db,owner))["id"]==recovered["id"]
        assert (await router.attempt_result("india",queued["id"],db,owner))["scored"]==0
        assert (await router.technical_validation(db,owner))["status"]=="Unproven"


def test_final_archive_identity_dates_and_split_ledger():
    import io,zipfile
    data=io.BytesIO()
    with zipfile.ZipFile(data,"w") as z:
        z.writestr("bhav.csv","TradDt,SctySrs,TckrSymb,FinInstrmId,ISIN,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol\n"+
                   "2026-11-20,EQ,EXAMPLE,1,INE123,100,101,98,99,50\n"+
                   "2026-11-19,EQ,EXAMPLE,1,INE123,40,50,20,47,50\n")
    found=sources.extract_archive(data.getvalue(),"NSE","2026-11-20","2026-11-20T15:30:00+05:30",{KEY},"https://example.org/a")
    assert len(found[KEY])==1 and found[KEY][0]["close"]==99
    actions=sources.action_ledger([{"name":"Bonus","expiry_date":"03 Nov 2026","ratio":"1:2"},
                                   {"name":"Rights","expiry_date":"05 Nov 2026"}],"2026-10-01","2026-11-20")
    assert [a["multiplier"] for a in actions]==[1.5,None]
