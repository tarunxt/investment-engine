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
    stocks=[dict(listing=k,exchange=k.split(":")[0],symbol=k.split(":")[1],name="ABC Limited" if k.endswith(":ABC") else "DD Limited") for k in ("BSE:ABC","NSE:ABC","NSE:DD")]
    packet=asyncio.run(src.collect({"as_of":CUTOFF,"stocks":stocks,"owner_id":1},None,{s["listing"]:["C3","C6"] for s in stocks}))
    assert len(packet["sources"])==2
    assert all(v["C3"] for v in packet["matrix"].values())
    assert packet["matrix"]["BSE:ABC"]["C6"]==packet["matrix"]["NSE:ABC"]["C6"]
    assert packet["matrix"]["BSE:ABC"]["C6"] and not packet["matrix"]["NSE:DD"]["C6"]
