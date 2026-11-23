"""Point-in-time evidence for Indian Rebalance. Price series stay listing-specific."""
import asyncio
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timedelta
from urllib.parse import urlencode
from xml.etree import ElementTree

import httpx
from redis.exceptions import RedisError

from .pair_evidence import news as collect_news
from .research import INDIA, download, supplement_indian_bars
from .technical_sources import collect as collect_history
from .technical_v3 import normalise
from .rebalance_filings import comparable, issuer_results, published, statement
from .rebalance_identity import aliases
from app.domains.zerodha.upstox_quote_guard import redis_client
from app.domains.zerodha.upstox_quotes import configured_for, technical_instruments

HORIZONS = {"technical-short": 20, "technical-medium": 60, "technical-long": 200}
RESULTS = "https://www.nseindia.com/api/integrated-filing-results"
FACT_TAGS = {"RevenueFromOperations", "ProfitLossForPeriod", "ProfitLossFromContinuingOperations",
             "ProfitBeforeTax", "ProfitLossForThePeriod", "ProfitLoss", "InterestEarned", "RevenueFromOperationsNet",
             "BasicEarningsLossPerShareFromContinuingOperations", "TotalIncome", "IncomeFromOperations"}


def result_facts(xml):
    root = ElementTree.fromstring(xml)
    periods = {}
    for context in root.findall(".//{*}context"):
        start = context.findtext(".//{*}startDate")
        end = context.findtext(".//{*}endDate")
        if start and end and not context.findall(".//{*}explicitMember") and not context.findall(".//{*}typedMember"):
            periods[context.get("id")] = (start, end)
    facts = {}
    for item in root.iter():
        tag = item.tag.rsplit("}", 1)[-1]
        period = periods.get(item.get("contextRef"))
        if tag not in FACT_TAGS or not period or not item.get("unitRef"):
            continue
        try:
            value = float(item.text)
        except (ValueError, TypeError):
            continue
        if math.isfinite(value):
            facts.setdefault(period, {})[tag] = [value, item.get("unitRef")]
    return [{"period": p, "values": facts[p]} for p in sorted(facts, key=lambda p:(p[1],p[0]), reverse=True)[:6]]


async def filings(client, symbol, cutoff):
    url = RESULTS+"?"+urlencode({"index":"equities","symbol":symbol,"type":"Integrated Filing- Financials",
                               "period_ended":"all","page":1,"size":20,
                               "from_date":(cutoff-timedelta(days=185)).strftime("%d-%m-%Y"),"to_date":cutoff.strftime("%d-%m-%Y")})
    data = json.loads(await download(client, url))
    candidates = []
    for row in data.get("data",[]) if isinstance(data,dict) else []:
        if not isinstance(row, dict) or str(row.get("symbol", "")).upper() != symbol:
            continue
        link = str(row.get("xbrl") or "")
        if not re.fullmatch(r"https://(?:nsearchives|archives)\.nseindia\.com/[A-Za-z0-9_./%+()-]+\.xml", link, re.I):
            continue
        stamp=published(row.get("revised_Date") or row.get("broadcast_Date") or row.get("creation_Date"))
        if stamp and cutoff-timedelta(days=185)<=stamp<=cutoff:
            candidates.append((stamp,link))
    docs = []
    for stamp, link in sorted(set(candidates), reverse=True)[:3]:
        doc = statement(await download(client,link),stamp,link)
        if doc["facts"]:
            docs.append(doc)
            if comparable(doc["facts"]):
                break
    return docs


def build(stocks, history, news, long_history, reports, as_of, diagnostics=None):
    packets = {}
    issuer_reports = defaultdict(list)
    for stock in stocks:
        key = stock["listing"]
        isin = history.get("technical",{}).get(key,{}).get("sources",{}).get("stock",{}).get("instrument")
        if isin and re.fullmatch(r"IN[A-Z0-9]{10}",isin):
            issuer_reports[isin].extend(reports.get(key,[]))
    for stock in stocks:
        key = stock["listing"]
        src = history.get("technical",{}).get(key,{}).get("sources",{}).get("stock",{})
        refs = {}
        reasons = {}
        day_counts = {}
        diag = (diagnostics or {}).get(key,{})
        calendar = history.get("calendars",{}).get(stock["exchange"],{})
        last_session = max(calendar, default=None)
        base = history.get("listings",{}).get(key,[]) or news.get("listings",{}).get(key,[])
        for factor, count in HORIZONS.items():
            day_counts[factor] = 0
            reasons[factor] = "No verified venue calendar" if not calendar else f"Fewer than {count} sessions"
            for candidate in (base, long_history.get(key,[])):
                by_day = {r["as_of"][:10]:r for r in candidate if r.get("kind")=="daily_bar" and datetime.fromisoformat(r["as_of"])<=datetime.fromisoformat(as_of)}
                days = sorted(by_day)[-count:]
                day_counts[factor]=max(day_counts[factor],len(days))
                if len(days) == count and days[-1] != last_session:
                    reasons[factor] = f"Missing latest completed venue session · required {last_session}, latest saved {days[-1]}"
                if len(days)<count or days[-1]!=last_session:
                    continue
                if diagnostics is not None and (not src.get("instrument") or not src.get("action_url")):
                    reasons[factor] = "Instrument identity or corporate-action ledger unavailable"
                    continue
                checked=[dict(by_day[d],basis=by_day[d].get("basis","unverified-provider")) for d in days]
                series,faults=normalise(checked,days,src.get("actions",[]),as_of)
                if faults or len(series)!=count:
                    reasons[factor] = next(iter(faults.values()), "Incomplete adjusted history")
                    continue
                prices = [series[d][3] for d in days]
                # Mixed bases, missing recent sessions and unresolved price breaks need review.
                if (set(list(sorted(calendar))[-min(count,len(calendar)):])-set(days)
                    or any(max(a,b)/min(a,b)>1.35 for a,b in zip(prices,prices[1:]))):
                    reasons[factor] = "Venue session gap or unresolved price discontinuity"
                    continue
                first,last = by_day[days[0]],by_day[days[-1]]
                refs[factor] = {"kind":"history","as_of":last["as_of"],"url":last["url"],"start_url":first["url"],
                                "sessions":count,"from":days[0],"start":prices[0],"close":prices[-1],
                                "high_close":max(prices),"low_close":min(prices),"mean_close":round(sum(prices)/count,3)}
                if last.get("recovered_close"):
                    refs[factor]["close_recovered_at"] = last["received_at"]
                break
        docs = reports.get(key,[]) or issuer_reports.get(src.get("instrument"),[])
        for i,item in enumerate(docs[:2]):
            refs[f"filing{i+1}"] = item
        news_items = [r for r in news.get("listings",{}).get(key,[]) if r["kind"]=="exchange_notice"]
        for i,item in enumerate(news_items[:3]):
            refs[f"notice{i+1}"] = item
        allowed = {factor:[factor] if factor in refs else [] for factor in HORIZONS}
        allowed["fundamentals-short"] = [k for k,v in refs.items() if v["kind"]=="results"]
        allowed["fundamentals-medium-long"] = [k for k,v in refs.items() if v["kind"]=="results" and comparable(v["facts"])]
        allowed["cruxx"] = list(refs)
        for factor in HORIZONS:
            if not allowed[factor] and diag.get("history"):
                reasons[factor] += " · "+diag["history"]
        listed=published(diag.get("listed_on"))
        if listed and last_session:
            for factor,count in HORIZONS.items():
                dates=sorted(calendar)[-count:]
                if dates and listed.date().isoformat()>dates[0] and not allowed[factor]:
                    reasons[factor]=f"Insufficient listing history · listed {listed.date()} · {count} sessions required"
        filing_reason = " · ".join(diag.get("filings",[])) or "No qualifying issuer filing"
        if not allowed["fundamentals-short"]:
            reasons["fundamentals-short"] = filing_reason
        if not allowed["fundamentals-medium-long"]:
            reasons["fundamentals-medium-long"] = "No comparable financial periods" if docs else filing_reason
        if not refs:
            reasons["cruxx"] = "No dated source for a thesis"
        if stock.get("units") is None:
            reasons["action"] = "Position quantity unavailable"
        price = next((refs[f]["close"] for f in HORIZONS if f in refs),None)
        packets[key] = {"units":stock["units"],"settled":stock.get("settled"),"price":price,"last_session":last_session,
                        "refs":refs,"allowed":allowed,"history_sessions":day_counts,
                        "source_gaps":{k:v for k,v in reasons.items() if not allowed.get(k)},
                        "verified_listing":diag.get("verified_listing",key)}
    return packets


async def collect(manifest, username, cached_history=None, *, refresh=False):
    cutoff = datetime.fromisoformat(manifest["as_of"])
    stocks = manifest["stocks"]
    try:
        cache = redis_client()
    except RuntimeError:
        cache = None
    try:
        async with httpx.AsyncClient(timeout=6, follow_redirects=False,
                                     headers={"User-Agent":"Cred-X financial research (https://cred-x.in)","Accept":"*/*"}) as client:
            try:
                master=await technical_instruments(client)
            except (OSError,httpx.HTTPError,ValueError,RuntimeError):
                master={}
            resolved=aliases(stocks,master)
            canonical={s["listing"]:resolved.get(s["listing"],s["listing"]) for s in stocks}
            listing_stocks={k:{**s,"listing":k,"symbol":k.split(":",1)[1]} for s in stocks for k in [canonical[s["listing"]]]}
            history_manifest={**manifest,"stocks":list(listing_stocks.values())}
            by_isin=defaultdict(lambda:defaultdict(set))
            for k,meta in master.items():
                if meta.get("isin"):
                    by_isin[meta["isin"]][k[:3]].add(k)
            async def get_reports():
                sem=asyncio.Semaphore(6)
                issuers={}
                for k in listing_stocks:
                    isin=master.get(k,{}).get("isin")
                    group=by_isin.get(isin,{})
                    nse=sorted(group.get("NSE",[]))
                    bse=sorted({master[b].get("exchange_token") for b in group.get("BSE",[]) if master[b].get("exchange_token")})
                    issuers[isin or k]=(isin,k.split(":",1)[1] if k.startswith("NSE:") else nse[0][4:] if len(nse)==1 else None,
                                       bse[0] if len(bse)==1 else None)
                async def fetch(key,info):
                    async with sem:
                        return key,await issuer_results(client,cache,*info,cutoff)
                return dict(await asyncio.gather(*(fetch(k,v) for k,v in issuers.items())))
            history,news,reports=await asyncio.gather(collect_history(history_manifest,username,previous=cached_history,sessions=210),
                                                    collect_news(history_manifest),get_reports())
            from .rebalance_close import recover_closes
            await recover_closes(client, cache, history_manifest, username, history, master, refresh=refresh)
            diagnostics,filings_by_key={},{}
            for k in listing_stocks:
                data,reasons=reports.get(master.get(k,{}).get("isin") or k,([],[]))
                filings_by_key[k]=data
                diagnostics[k]={"history":history.get("provider_status",{}).get(k,{}).get("reason"),"filings":reasons,"listed_on":master.get(k,{}).get("listed_on")}
            packets=build(listing_stocks.values(),history,news,{},filings_by_key,manifest["as_of"],diagnostics)
            original={s["listing"]:{**packets[canonical[s["listing"]]],"units":s["units"],"settled":s.get("settled"),
                                    "verified_listing":canonical[s["listing"]]} for s in stocks}
            return {"version":4,"readiness_version":1,"packets":original,"notices":sorted(set(history["notices"]+news.get("notices",[])))}
    finally:
        if cache is not None:
            await cache.aclose()
