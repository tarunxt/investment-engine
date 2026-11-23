"""Dated, issuer-specific official financial statements for the Rebalance packet."""
import asyncio
import json
import re
from datetime import datetime, timedelta
from urllib.parse import urljoin, urlsplit
from xml.etree import ElementTree

import httpx
from redis.exceptions import RedisError

from .research import INDIA, download


def published(value):
    for fmt in ("%d-%b-%Y %H:%M:%S", "%d-%m-%Y %H:%M:%S", "%d-%b-%Y %H:%M", "%d/%m/%Y %H:%M:%S", "%d %b %Y %H:%M:%S"):
        try:
            return datetime.strptime(str(value), fmt).replace(tzinfo=INDIA)
        except ValueError:
            pass
    try:
        stamp = datetime.fromisoformat(str(value))
        return stamp if stamp.tzinfo else stamp.replace(tzinfo=INDIA)
    except ValueError:
        return None


def recent(rows, cutoff):
    return [r for r in rows if cutoff-timedelta(days=185) <= datetime.fromisoformat(r["as_of"]) <= cutoff
            and datetime.fromisoformat((r.get("comparison_source") or r)["as_of"]) <= cutoff]


def comparable(facts):
    for i, a in enumerate(facts):
        a0,a1 = map(datetime.fromisoformat, a["period"])
        for b in facts[i+1:]:
            b0,b1 = map(datetime.fromisoformat, b["period"])
            if a1==b1 or abs(((a1-a0)-(b1-b0)).days)>8 or not (a1<b0 or b1<a0):
                continue
            if any(f in b["values"] and b["values"][f][1]==v[1] for f,v in a["values"].items()):
                return True
    return False


def statement(xml, stamp, url):
    from .rebalance_evidence import result_facts
    root=ElementTree.fromstring(xml)
    scope={e.text.strip().lower() for e in root.iter() if e.tag.split("}")[-1]=="NatureOfReportStandaloneConsolidated" and e.text}
    facts=result_facts(xml)
    facts=[f for f in facts if f["period"][1] <= stamp.date().isoformat()]
    return {"kind":"results","as_of":stamp.isoformat(),"url":url,"facts":facts,
            "scope":scope.pop() if len(scope)==1 else None}


def period_documents(docs):
    single=next((d for d in docs if comparable(d["facts"])),None)
    if single:
        return docs
    for i, new in enumerate(docs):
        for old in docs[i+1:]:
            if new.get("scope") not in ("standalone","consolidated") or new["scope"]!=old.get("scope"):
                continue
            facts=new["facts"]+old["facts"]
            if comparable(facts):
                joined={**new,"facts":facts,"comparison_source":{"url":old["url"],"as_of":old["as_of"]}}
                return [joined,*[d for d in docs if d["url"]!=new["url"]]]
    return docs


async def bse_filings(client, code, isin, cutoff):
    if not re.fullmatch(r"\d{6}", str(code)):
        return []
    response = await client.get("https://api.bseindia.com/BseIndiaAPI/api/Integratedfinancedata/w",
                                params={"scripcode":code}, headers={"Referer":"https://www.bseindia.com/","Origin":"https://www.bseindia.com"})
    response.raise_for_status()
    payload = response.json()
    rows = payload.get("Table",payload.get("Data",[])) if isinstance(payload,dict) else payload
    candidates = []
    for row in rows:
        if not isinstance(row,dict):
            continue
        revised=row.get("revised_date_time")
        stamp = published(revised) if revised and str(revised).strip() not in ("-","NA") else published(row.get("filing_date_time"))
        if not stamp or not cutoff-timedelta(days=185)<=stamp<=cutoff:
            continue
        path = str(row.get("xbrlurl") or row.get("XbrlFile") or "")
        url = urljoin("https://www.bseindia.com/", re.sub(r"\.html?$",".xml",path,flags=re.I))
        parts = urlsplit(url)
        if parts.scheme=="https" and parts.netloc=="www.bseindia.com" and re.fullmatch(r"/XBRLFILES/[a-zA-Z0-9_./%()+-]+\.xml",parts.path,re.I) and not parts.query:
            candidates.append((stamp,url))
    docs=[]
    for stamp,url in sorted(set(candidates), reverse=True)[:3]:
        xml = await download(client,url)
        root=ElementTree.fromstring(xml)
        declared={e.text.strip() for e in root.iter() if e.tag.split("}")[-1].lower() in ("isin","isinofcompany","isinofcompanysequityshares") and e.text and re.fullmatch(r"IN[A-Z0-9]{10}",e.text.strip())}
        if declared and isin not in declared:
            continue
        doc=statement(xml,stamp,url)
        if doc["facts"]:
            docs.append(doc)
            if comparable(doc["facts"]):
                break
    return docs


async def issuer_results(client, cache, isin, nse, bse, cutoff):
    from .rebalance_evidence import filings
    key = f"rebalance:filings:v2:{isin or nse}:{cutoff.date()}"
    docs, reasons = [], []
    archive = "rebalance:filing-history:"+str(isin or nse)
    saved=None
    if cache:
        try:
            saved=await cache.get(key)
            if not saved:
                prior=await cache.get(archive)
                if prior:
                    docs=recent(json.loads(prior),cutoff)
            if saved:
                docs=recent(json.loads(saved),cutoff)
        except (RedisError,ValueError):
            pass
    for source, identifier, fetch in (("NSE",nse,lambda:filings(client,nse,cutoff)),
                                       ("BSE",bse,lambda:bse_filings(client,bse,isin,cutoff))):
        docs=period_documents(docs)
        if (source=="BSE" or (cache and saved)) and any(comparable(d["facts"]) for d in docs):
            break
        if not identifier:
            reasons.append(source+" issuer identifier unavailable")
            continue
        try:
            records=await asyncio.wait_for(fetch(),timeout=10)
            docs.extend(records)
            if not records:
                reasons.append(source+" returned no dated readable financial results")
        except httpx.HTTPStatusError as exc:
            reasons.append(f"{source} HTTP {exc.response.status_code}")
        except (httpx.TimeoutException, TimeoutError):
            reasons.append(source+" filing request timed out")
        except (ValueError,TypeError,KeyError,ElementTree.ParseError,httpx.HTTPError,OSError) as exc:
            reasons.append(f"{source} filing unavailable ({type(exc).__name__})")
    from .filing_archive import lookup
    docs.extend(await lookup(cache, isin, cutoff))
    docs=sorted({d["url"]:d for d in recent(docs,cutoff)}.values(),key=lambda d:(comparable(d["facts"]),d["as_of"]),reverse=True)[:3]
    docs=period_documents(docs)
    if docs and cache:
        try:
            await cache.set(key,json.dumps(docs),ex=21600)
            await cache.set(archive,json.dumps(docs),ex=86400*185)
        except RedisError:
            pass
    return docs, reasons
