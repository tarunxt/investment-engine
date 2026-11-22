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
        def timestamp(value):
            for fmt in ("%d-%b-%Y %H:%M:%S","%d-%m-%Y %H:%M:%S","%Y-%m-%d %H:%M:%S","%d-%b-%Y %H:%M"):
                try:
                    return datetime.strptime(str(value),fmt).replace(tzinfo=INDIA)
                except ValueError:
                    pass
            try:
                stamp=datetime.fromisoformat(str(value))
                return stamp if stamp.tzinfo else stamp.replace(tzinfo=INDIA)
            except ValueError:
                return None
        stamp=timestamp(row.get("revised_Date") or row.get("broadcast_Date") or row.get("creation_Date"))
        if stamp and cutoff-timedelta(days=185)<=stamp<=cutoff:
            candidates.append((stamp,link))
    for stamp, link in sorted(set(candidates), reverse=True)[:2]:
        facts = result_facts(await download(client,link))
        if facts:
            return [{"kind":"results","as_of":stamp.isoformat(),"url":link,"facts":facts}]
    return []


def build(stocks, history, news, long_history, reports, as_of):
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
        calendar = history.get("calendars",{}).get(stock["exchange"],{})
        last_session = max(calendar, default=None)
        base = history.get("listings",{}).get(key,[]) or news.get("listings",{}).get(key,[])
        for factor, count in HORIZONS.items():
            for candidate in (base, long_history.get(key,[])):
                by_day = {r["as_of"][:10]:r for r in candidate if r.get("kind")=="daily_bar" and datetime.fromisoformat(r["as_of"])<=datetime.fromisoformat(as_of)}
                days = sorted(by_day)[-count:]
                if len(days)<count or days[-1]!=last_session:
                    continue
                checked=[dict(by_day[d],basis=by_day[d].get("basis","unverified-provider")) for d in days]
                series,faults=normalise(checked,days,src.get("actions",[]),as_of)
                if faults or len(series)!=count:
                    continue
                prices = [series[d][3] for d in days]
                # Mixed bases, missing recent sessions and unresolved price breaks need review.
                if (set(list(sorted(calendar))[-min(count,len(calendar)):])-set(days)
                    or any(max(a,b)/min(a,b)>1.35 for a,b in zip(prices,prices[1:]))):
                    continue
                first,last = by_day[days[0]],by_day[days[-1]]
                refs[factor] = {"kind":"history","as_of":last["as_of"],"url":last["url"],"start_url":first["url"],
                                "sessions":count,"from":days[0],"start":prices[0],"close":prices[-1],
                                "high_close":max(prices),"low_close":min(prices),"mean_close":round(sum(prices)/count,3)}
                break
        docs = reports.get(key,[]) or issuer_reports.get(src.get("instrument"),[])
        for i,item in enumerate(docs[:2]):
            refs[f"filing{i+1}"] = item
        news_items = [r for r in news.get("listings",{}).get(key,[]) if r["kind"]=="exchange_notice"]
        for i,item in enumerate(news_items[:3]):
            refs[f"notice{i+1}"] = item
        allowed = {factor:[factor] if factor in refs else [] for factor in HORIZONS}
        allowed["fundamentals-short"] = [k for k,v in refs.items() if v["kind"]=="results"]
        allowed["fundamentals-medium-long"] = [k for k,v in refs.items() if v["kind"]=="results" and len({p["period"][1] for p in v["facts"]})>=2]
        allowed["cruxx"] = list(refs)
        price = next((refs[f]["close"] for f in HORIZONS if f in refs),None)
        packets[key] = {"units":stock["units"],"settled":stock.get("settled"),"price":price,"last_session":last_session,
                        "refs":refs,"allowed":allowed}
    return packets


async def collect(manifest, username, cached_history=None):
    cutoff = datetime.fromisoformat(manifest["as_of"])
    stocks = manifest["stocks"]
    notices = []
    prices = {s["listing"]:[] for s in stocks}
    reports = {}
    async with httpx.AsyncClient(timeout=4.5,follow_redirects=False) as client:
        semaphore=asyncio.Semaphore(4)
        async def company(symbol,keys):
            async with semaphore:
                try:
                    docs=await filings(client,symbol,cutoff)
                    reports.update({k:docs for k in keys})
                except (OSError,httpx.HTTPError,ValueError,TypeError,KeyError,ElementTree.ParseError):
                    notices.append("Financial results unavailable: "+symbol)
        async def supplement():
            if configured_for(manifest["owner_id"],username):
                try:
                    await asyncio.wait_for(supplement_indian_bars(client,prices,cutoff,notices,manifest["owner_id"],sessions=201),15)
                except (OSError,httpx.HTTPError,ValueError,RuntimeError,RedisError):
                    notices.append("Long history incomplete")
        async def get_reports():
            try:
                try:
                    master=await asyncio.wait_for(technical_instruments(client),5)
                except (OSError,httpx.HTTPError,RuntimeError,ValueError,TimeoutError):
                    master={}
                nse=defaultdict(set)
                for k,meta in master.items():
                    if k.startswith("NSE:") and meta.get("isin"):
                        nse[meta["isin"]].add(k.split(":",1)[1])
                groups=defaultdict(list)
                for stock in stocks:
                    k=stock["listing"]
                    aliases=nse.get(master.get(k,{}).get("isin"),set())
                    if stock["exchange"]=="NSE":
                        groups[stock["symbol"]].append(k)
                    elif len(aliases)==1:
                        groups[next(iter(aliases))].append(k)
                await asyncio.wait_for(asyncio.gather(*(company(symbol,keys) for symbol,keys in groups.items())),16)
            except TimeoutError:
                notices.append("Financial results retrieval window elapsed")
        history,news,*_ = await asyncio.gather(
            asyncio.sleep(0,result=cached_history) if cached_history else collect_history(manifest,username),
            collect_news(manifest),supplement(),get_reports())
    return {"version":4,"packets":build(stocks,history,news,prices,reports,manifest["as_of"]),
            "notices":sorted(set(notices+news.get("notices",[])+history.get("notices",[])))}
