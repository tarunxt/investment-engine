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
        router.CreateRunUseCase.execute.assert_not_awaited()
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


def test_sensitivities_and_reserved_calibration():
    from app.domains.scorecards.technical_validation import calibration
    values=calc()
    assert len(values["sensitivities"])==9
    assert values["sensitivities"]["omit Trend"]==pytest.approx(values["score"]-values["factors"]["Trend"]["points"],abs=.1)
    def month(year):
        return {f"{year}-01-{day:02d}":[{"listing":"A","issuer":"A","candidate":10,"outcome":-1},
                                        {"listing":"B","issuer":"B","candidate":90,"outcome":1}] for day in range(1,32)}
    assert calibration(month(2025),{})["bins"]==[]
    calibrated=calibration(month(2025),month(2026))
    assert calibrated["brier"]==0 and calibrated["baseline_brier"]==.25
    assert sum(b["n"] for b in calibrated["bins"])==62

def test_realised_costs_require_matching_fills_and_keep_unfilled_counts():
    from app.domains.scorecards.technical_validation import execution_review
    entry,exit=date(2026,2,2),date(2026,2,27)
    signal={"candidate":70,"entry_session":str(entry),"label_end":str(exit),"share_multiplier":2}
    cohorts={"2026-01-30":[{**signal,"listing":"NSE:"+k} for k in ("A","B","C")]}
    observed=router.ExecutionObservation(decision="2026-01-30",listing="NSE:A",status="filled",entry_session=entry,
        exit_session=exit,entry_fill=100,exit_fill=55,entry_reference=99,exit_reference=56,entry_fees_per_share=1,exit_fees_per_share=.5)
    stats=execution_review(cohorts,[observed,observed.model_copy(update={"listing":"NSE:B","status":"skipped"})])
    assert stats["mean_net_return"]==pytest.approx(109/101-1)
    assert stats["mean_slippage_fraction_of_entry"]==pytest.approx(3/99)
    assert stats["filled"]==stats["skipped"]==stats["without_execution_record"]==1


def test_verified_technical_alias_keeps_source_rows_and_counts_the_venue_once():
    raw,canonical="NSE:M_M","NSE:M&M"
    master={canonical:{"isin":"INE101A01026"},"BSE:M&M":{"isin":"INE101A01026"}}
    assert sources.resolve_aliases([raw,canonical,"BSE:M_M"],master)=={raw:canonical}
    assert not sources.resolve_aliases([raw],{**master,raw:{"isin":"DIFFERENT"}})
    assert not sources.resolve_aliases([raw],{canonical:{"isin":"DIFFERENT"}})
    inputs=[canonical,raw,"BSE:M&M"]
    scores={k:{**calc(),"input_hash":k,"sources":{}} for k in inputs}
    scores[raw]["canonical_listing"]=canonical
    result=output.saved_rows({"stocks":[{"listing":k} for k in inputs]},
        {"technical":scores,"listings":{},"calendars":{}},{},[],[])
    assert result["technical_counts"]["source_rows"]==3
    assert result["technical_counts"]["expected"]==result["technical_counts"]["complete"]==2
    assert [r["listing"] for r in result["rows"]]==inputs


def test_work_queue_times_and_exhaustion_are_per_listing():
    from app.domains.scorecards import technical_queue as queue
    from datetime import datetime, timezone
    stamp=datetime(2026,11,22,14,tzinfo=timezone.utc)
    def row(k,wait=0):
        return {"listing":k,"score":None,"coverage":"Insufficient data","reason":"Missing actions",
                "technical_v3":{"provider_status":{"retry_after":wait}}}
    result={"rows":[row("A"),row("B",1800)]}
    items=queue.remaining(result,{},stamp)
    assert items["A"]["due"]<items["B"]["due"]
    updated=queue.remaining(result,items,stamp,["A"])
    assert updated["B"]==items["B"] and updated["A"]["attempts"]==1
    fake=storage.Document(SimpleNamespace(summary_json={},status=""))
    updated["A"]["attempts"]=queue.LIMIT
    queue.save(fake,{"pending":updated,"latest":123,"lease":None})
    assert fake.row.status==queue.WAIT and queue.summary(fake)["next_retry"]==items["B"]["due"]
    updated["B"]["attempts"]=queue.LIMIT
    queue.save(fake,{"pending":updated,"latest":123,"lease":None})
    assert fake.row.status=="exhausted" and queue.summary(fake)["next_retry"] is None


@pytest.mark.anyio
async def test_due_evidence_resumes_without_the_browser_or_a_second_model_call(audit_db,monkeypatch):
    from app.domains.scorecards import technical_queue as queue, technical_recovery
    from app.domains.auth.models import User
    from datetime import datetime, timezone, timedelta
    listing="NSE:TEST"
    stock={"listing":listing,"units":1,"exchange":"NSE","symbol":"TEST","origin":"holding"}
    ledger={**calc([]),"listing":listing,"input_hash":"old","sources":{}}
    result={"id":0,"scoring_version":3,"rows":[{"listing":listing,"technical_v3":ledger,"coverage":"Insufficient data","score":None,
             "reason":"Corporate-action history unavailable","raw_rows":[]}]}
    async with audit_db.sessions() as db:
        rev=await storage.append(db,7001,"revision","queue-test",{"manifest":{"market":"india","as_of":CUT,"owner_id":7,"stocks":[stock]}})
        source=await storage.append(db,7001,"attempt","queue-source",{"card":"technical","settings":{}},revision_id=rev.id)
        result["id"]=source.id
        source.row.summary_json={**source.data,"result":result}
        work=await queue.enqueue(db,source,result,immediate=True)
        wid=work.id
        assert (await queue.enqueue(db,source,result,immediate=True)).id==wid
        await db.commit()
    async def fixed(db,old,owner,username,*,only,commit):
        assert set(only)=={listing} and not commit
        child=await storage.append(db,7001,"attempt","queue-child",{"card":"technical","settings":{},"technical_root":old.id},revision_id=rev.id)
        out={**result,"id":child.id,"rows":[{**result["rows"][0],"score":0,"coverage":"Complete"}]}
        child.row.summary_json={**child.data,"result":out}
        return out
    monkeypatch.setattr(technical_recovery,"recover",fixed)
    assert await queue.run_due(audit_db.sessions)
    assert not await queue.run_due(audit_db.sessions)
    async with audit_db.sessions() as db:
        work=await queue.locked(db,wid)
        assert queue.summary(work)["state"]=="completed" and not queue.summary(work)["pending"]
        assert (await storage.lookup(db,7,"india","attempt",source.id)).result_json["rows"][0]["score"] is None


@pytest.mark.anyio
async def test_venue_archive_reused_when_second_run_adds_a_stock(monkeypatch):
    import io,zipfile,json,httpx
    from unittest.mock import AsyncMock,MagicMock
    from datetime import datetime
    day=DATES[-1]
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,"w",compression=zipfile.ZIP_DEFLATED) as archive:
        csv="TradDt,SctySrs,TckrSymb,FinInstrmId,ISIN,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol\n"
        for i,key in enumerate(("A","B","NIFTYBEES")):
            csv+=f"{day},EQ,{key},{i},ID{i},100,101,98,99,50\n"
        archive.writestr("data.csv",csv)
    calls=[]
    def reply(req):
        if ".zip" in str(req.url):
            calls.append(str(req.url))
            return httpx.Response(200,content=stream.getvalue())
        if "/corporates-" in str(req.url):
            return httpx.Response(200,json=[{"isin":"OTHER","exDate":"01-Nov-2026","subject":"Dividend"}])
        return httpx.Response(200,json={"data":[]})
    client=httpx.AsyncClient
    monkeypatch.setattr(sources.httpx,"AsyncClient",lambda **options:client(transport=httpx.MockTransport(reply),**options))
    data={}
    redis=MagicMock()
    async def get(k): return data.get(k)
    async def put(k,v,ex): data[k]=v
    redis.get=get
    redis.set=put
    redis.aclose=AsyncMock()
    redis.hmget=AsyncMock(return_value=[])
    pipe=MagicMock()
    pipe.execute=AsyncMock()
    redis.pipeline.return_value.__aenter__.return_value=pipe
    monkeypatch.setattr(sources,"redis_client",lambda:redis)
    monkeypatch.setattr(sources,"configured_for",lambda *args:False)
    monkeypatch.setattr(sources,"session_calendar",lambda *args:{day:day+"T15:30:00+05:30"})
    master={f"NSE:{k}":{"isin":f"ID{i}","tick":.05} for i,k in enumerate(("A","B","NIFTYBEES"))}
    monkeypatch.setattr(sources,"technical_instruments",AsyncMock(return_value=master))
    for symbol in ("A","B"):
        listing="NSE:"+symbol
        packet=await sources.collect({"as_of":CUT,"stocks":[{"listing":listing}],"owner_id":7},"owner")
        assert packet["listings"][listing][0]["isin"]==master[listing]["isin"]
    assert len(calls)==1


def test_siemens_energy_uses_only_the_verified_nse_equity():
    from app.domains.scorecards import rebalance_identity as identity
    raw, target = identity.SIEMENS_ALIAS, identity.SIEMENS_IDENTITY[0]
    isin = identity.SIEMENS_IDENTITY[1]
    row = {"listing":raw, "name":"Siemens Energy India Ltd.", "origin":"contender"}
    master = {target:{"isin":isin}}
    assert sources.resolve_aliases([raw],master,[row]) == {raw:target}
    assert sources.resolve_history_instruments([row],master,{}) == {raw:target}
    assert identity.aliases([row],master) == {raw:target}
    assert identity.aliases([{**row,"origin":"holding"}],master) == {}
    for instrument, stocks in (({target:{"isin":"OTHER"}},[row]), (master,[{**row,"name":"Siemens Ltd."}]),
                              ({**master,raw:{"isin":"OTHER"}},[row]), (master,[{**row,"isin":"OTHER"}])):
        assert sources.resolve_aliases([raw],instrument,stocks) == {}


@pytest.mark.anyio
async def test_pending_close_keeps_verified_zero_separate_from_current_score(audit_db):
    from app.domains.scorecards.technical_history import closing_display
    async with audit_db.sessions() as db:
        ledger = {"score": 0, "coverage": "Complete", "session": "2026-11-20",
                  "sources": {"stock": {"instrument": "verified-id"}}}
        packet = await storage.append(db, 7001, "packet", "dated-close-test",
                                      {"research": {"technical": {KEY: ledger}}})
        result = {"id": packet.id + 1, "rows": [{"listing": KEY, "score": None, "technical_v3": {
            **ledger, "session": "2026-11-23", "score": None, "reason": "Decision-session candle missing"}}]}
        displayed = (await closing_display(db, 7, result))["rows"][0]
        assert displayed["score"] is None
        assert displayed["closing_pending"] == "2026-11-23"
        assert displayed["previous_close_score"] == {"session": "2026-11-20", "score": 0}
        assert (await closing_display(db, 8, result))["rows"][0]["previous_close_score"] is None
