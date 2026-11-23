import json
from types import SimpleNamespace

from app.domains.scorecards.prompts import HEADERS
from app.domains.scorecards.threat_output import new_evidence_targets, project, target_gaps
from app.domains.scorecards.threat_sources import CATEGORIES, feed_items, source_id
from datetime import datetime

CUTOFF = "2026-11-22T11:26:10+00:00"


def batch(mappings, job_id=1, targets=None):
    records, matrix, rows = {}, {}, []
    for key, cats in mappings.items():
        matrix[key] = {cat:[] for cat in CATEGORIES}
        values, evidence = {}, []
        for cat in cats:
            doc = {"url":"https://example.org/release/"+cat,"as_of":"2026-11-20T12:00:00+00:00","excerpt":cat}
            sid = source_id(doc)
            records[sid] = doc
            matrix[key][cat].append(sid)
            values[cat] = "24"
            evidence.append({"category":cat,"source_id":sid,"scenario_id":"scenario-"+cat,
                             "trigger":"Trigger","likelihood":3,"impact":2,"downside":"2-5%",
                             "confidence":"medium","rationale":"Exposure detailed in the frozen report"})
        rows.append([key,key.split(":")[1],*[values.get(c,"—") for c in CATEGORIES],
                     "Leading risk","2026-11-20",json.dumps(evidence)])
    header=HEADERS["threats"]
    response="\n".join("| "+" | ".join(r)+" |" for r in [header,["---"]*len(header),*rows])
    job=SimpleNamespace(id=job_id,status="completed",response=response)
    packet={"threat_version":2,"sources":records,"matrix":matrix,"targets":targets or {k:CATEGORIES for k in mappings}}
    return job,0,list(mappings),[],packet


def test_one_successful_job_with_34_rows_and_zero_scores_then_only_new_gaps():
    mappings={f"NSE:S{i}":["C2","C8"] if i<7 else ["C2"] for i in range(34)}
    manifest={"stocks":[{"listing":k} for k in mappings],"as_of":CUTOFF}
    first=batch(mappings)
    saved=project(manifest,[first])
    assert saved["threat_counts"]==dict(expected=34, returned=34, scored=0, complete=0, verified_cells=41, jobs_passed=1)
    assert all(r["coverage"]=="Unassessed" for r in saved["rows"])
    assert sum(len(gaps) for gaps in target_gaps(saved["rows"]).values())==231
    retry=batch({"NSE:S0":["C3"]},2,{"NSE:S0":["C3"]})
    previous={r["listing"]:r["source_ids"] for r in saved["rows"]}
    assert new_evidence_targets(first[-1],previous)=={}
    assert new_evidence_targets(retry[-1],previous)=={"NSE:S0":["C3"]}
    second=project(manifest,[first,retry])
    assert second["threat_counts"]["scored"]==1
    assert second["rows"][0]["score"]==76 and second["rows"][0]["coverage"]=="Partial"
    assert second["rows"][1:]==saved["rows"][1:]
    third=batch({"NSE:S0":["C1","C4","C5","C6","C7"]},3)
    assert project(manifest,[first,retry,third])["rows"][0]["coverage"]=="Complete"


def test_source_scope_and_historical_cutoff_are_enforced():
    manifest={"stocks":[{"listing":"NSE:A"}],"as_of":CUTOFF}
    job=batch({"NSE:A":["C1","C2","C3"]})
    packet=job[-1]
    packet["matrix"]["NSE:A"]["C1"]=[]
    for doc in packet["sources"].values():
        if doc["excerpt"]=="C3":
            doc["as_of"]="2026-11-22T11:26:11+00:00"
    row=project(manifest,[job])["rows"][0]
    assert row["assessed"]==1 and row["score"] is None
    assert len([r for r in row["evidence"] if r["Disposition"].startswith("Excluded")])==2
    feed=b"<rss><channel><item><title>Monetary policy</title><link>https://rbi.org.in/report</link><pubDate>Mon, 23 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>"
    assert feed_items(feed,datetime.fromisoformat(CUTOFF),("C3",))==[]


def test_collects_dated_official_release_and_scopes_issuer_documents(monkeypatch):
    import asyncio
    from app.domains.scorecards import threat_sources as src

    title="Policy rate review"
    text=(title+" A dated official release describing the policy decision and the expected transmission to the domestic economy. ")*3
    macro="https://rbi.org.in/Scripts/Release.aspx?id=123"
    filing="https://www.bseindia.com/filings/announcement-123"
    def feed(name,url):
        return f"<rss><channel><item><title>{name}</title><description>Disclosed results</description><link>{url}</link><pubDate>Fri, 20 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>".encode()
    payloads={"https://rbi.org.in/pressreleases_rss.xml":feed(title,macro),macro:("<html>"+text+"</html>").encode(),
              src.BSE_NEWS:feed("ABC Limited results",filing),filing:("<html>"+("ABC Limited results published for this quarter, including changes in borrowing costs and covenants. "*4)+"</html>").encode()}
    async def download(client,url,limit):
        return payloads.get(url,b"<rss/>")
    from functools import partial
    monkeypatch.setattr(src.httpx,"AsyncClient",partial(src.httpx.AsyncClient,trust_env=False))
    monkeypatch.setattr(src,"download",download)
    monkeypatch.setattr(src,"technical_instruments",AsyncMock(return_value={}))
    stocks=[dict(listing=k,exchange=k.split(":")[0],symbol=k.split(":")[1],name="ABC Limited" if k.endswith(":ABC") else "DD Limited") for k in ("BSE:ABC","NSE:ABC","NSE:DD")]
    packet=asyncio.run(src.collect({"as_of":CUTOFF,"stocks":stocks,"owner_id":1},None,{s["listing"]:["C3","C6"] for s in stocks}))
    assert len(packet["sources"])==2
    assert all(v["C3"] for v in packet["matrix"].values())
    assert packet["matrix"]["BSE:ABC"]["C6"]==packet["matrix"]["NSE:ABC"]["C6"]
    assert packet["matrix"]["BSE:ABC"]["C6"] and not packet["matrix"]["NSE:DD"]["C6"]


def test_run_247_scores_supported_cells_once_without_inventing_consolidated_scores():
    from app.domains.scorecards.threat_coverage import plan, confidence_label
    mappings = {f"NSE:S{i}": ["C8"] if i < 20 else [] for i in range(34)}
    job = batch(mappings)
    job[0].response = job[0].response.replace('"confidence": "medium"', '"confidence": 0.80')
    saved = project({"stocks":[{"listing":k} for k in mappings],"as_of":CUTOFF},[job])
    assert saved["threat_diagnostics"] == dict(without_sources=14,scoreable=0,confidence_rejected=0,confidence_recovered=20)
    assert saved["threat_counts"]["verified_cells"] == 20 and saved["threat_counts"]["scored"] == 0
    assert plan(job[-1]) == {key: cats for key, cats in mappings.items() if cats}
    assert plan(job[-1], saved["rows"]) == {}
    assert all(confidence_label(x)=="" for x in (None,False,1.01,-1,"nan","inf","80%"))
    assert [confidence_label(x) for x in (0,.49,.50,.74,.75,1)] == ["low","low","medium","medium","high","high"]
    good = batch({"NSE:S0":["C1","C5"]})[-1]
    assert plan(good, saved["rows"]) == {"NSE:S0":["C1","C5"]}


def test_official_source_requires_issuer_exposure_and_exact_excerpt():
    from app.domains.scorecards.threat_coverage import plan
    run=batch({"NSE:S":["C1","C2","C8"]})
    packet=run[-1]
    macro=packet["sources"][packet["matrix"]["NSE:S"]["C2"][0]]
    macro["kind"]="official_release"
    packet.update(exposure_required=True,issuer_sources={})
    manifest={"stocks":[{"listing":"NSE:S"}],"as_of":CUTOFF}
    assert plan(packet)=={"NSE:S":["C1","C8"]} and project(manifest,[run])["threat_counts"]["scored"]==0
    anchor=packet["matrix"]["NSE:S"]["C1"][0]
    packet["sources"][anchor]["excerpt"]="Issuer revenues come from exports to the affected market."
    packet["issuer_sources"]["NSE:S"]=[anchor]
    assert plan(packet)=={"NSE:S":["C1","C2","C8"]}
    assert project(manifest,[run])["threat_counts"]["scored"]==0
    run[0].response=run[0].response.replace('"category": "C2"', '"exposure_source_id":"'+anchor+'","exposure_quote":"exports to the affected market","category":"C2"')
    assert project(manifest,[run])["threat_counts"]["scored"]==1


def test_fx_snapshot_filters_future_dates():
    from app.domains.scorecards.threat_sources import fx_observation
    data=b'<root><Cube time="2026-11-20"><Cube currency="USD" rate="1.2"/><Cube currency="INR" rate="108"/></Cube><Cube time="2026-11-22"><Cube currency="USD" rate="1"/><Cube currency="INR" rate="500"/></Cube></root>'
    doc=fx_observation(data,datetime.fromisoformat(CUTOFF))
    assert "90.0000" in doc["excerpt"] and "500" not in doc["excerpt"]


from unittest.mock import AsyncMock
import pytest
from test_auto_rebalance_audit_durability import audit_db, anyio_backend


@pytest.mark.anyio
async def test_start_and_repair_only_charge_when_new_sources_can_score(audit_db, monkeypatch):
    from app.domains.scorecards import router, storage, threat_sources
    keys=["NSE:A","NSE:B"]
    manifest={"market":"india","as_of":CUTOFF,"owner_id":7,"stocks":[
        {"listing":k,"exchange":"NSE","symbol":k[-1],"units":1,"origin":"holding","name":k} for k in keys]}
    owner=SimpleNamespace(id=7,username="owner")
    req=router.Start(request_key="coverage1",sequence=42,targets=[{"provider":"deepseek","model":"deepseek-v4-flash"}])
    def packet(mapping):
        return {**batch(mapping)[-1],"history_gaps":{},"notices":[]}
    sparse=packet({keys[0]:["C8"],keys[1]:[]})
    sparse.update(exposure_required=True,issuer_sources={})
    for doc in sparse["sources"].values():
        doc["kind"]="official_release"
    ready=packet({keys[0]:["C8"],keys[1]:[]})
    collector=AsyncMock(return_value=sparse)
    launch=AsyncMock(return_value=SimpleNamespace(id=50))
    monkeypatch.setattr(threat_sources,"collect",collector)
    monkeypatch.setattr(router,"_get_redis",lambda:AsyncMock())
    monkeypatch.setattr(router.CreateRunUseCase,"execute",launch)
    async with audit_db.sessions() as db:
        rev=await storage.append(db,7001,"revision","threats-plan",{"manifest":manifest,"digest":"s"})
        await db.commit()
        first=await router.start("india",rev.id,"threats",req,db,owner)
        assert first["run_id"] is None
        initial=await router.attempt_result("india",first["id"],db,owner)
        assert initial["threat_diagnostics"]["without_sources"]==1
        collector.return_value=ready
        recovered=await router.repair_threat_evidence(first["id"],db,owner)
        assert recovered["id"]!=first["id"] and recovered["threat_diagnostics"]["scoreable"]==0
        assert (await router.repair_threat_evidence(first["id"],db,owner))["id"]==recovered["id"]
        launch.assert_not_awaited()
        paid=await router.start("india",rev.id,"threats",req.model_copy(update={"retry_attempt_id":recovered["id"],"request_key":"resume"}),db,owner)
        assert paid["run_id"]==50 and launch.await_count==1
        assert launch.await_args.args[0].scorecard_batches[0]["scorecard_batch"]["listings"]==["NSE:A"]

def test_dated_bse_announcement_requires_matching_scrip_and_decision_time():
    from app.domains.scorecards.threat_sources import bse_announcements
    stock = {"listing":"BSE:ABC", "symbol":"ABC"}
    record = {"SCRIP_CD":123456, "ATTACHMENTNAME":"report.pdf", "DissemDT":"2026-11-20T12:00:00",
              "NEWSSUB":"Plant shutdown", "OLD":1}
    rows = [record, {**record,"SCRIP_CD":654321}, {**record,"DissemDT":"2026-11-23T12:00:00"},
            {**record,"ATTACHMENTNAME":"../wrong.pdf"}]
    [(listing, doc)] = bse_announcements(json.dumps({"Table":rows}), stock, "123456", datetime.fromisoformat(CUTOFF))
    assert listing == stock["listing"] and doc["url"].endswith("/AttachHis/report.pdf")
