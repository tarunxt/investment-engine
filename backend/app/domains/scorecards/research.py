"""Public market evidence, fetched per attempt. External requests contain public identifiers only."""
import asyncio
import csv
import io
import html
import json
import math
import os
import re
import zipfile
from datetime import datetime, time, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote, urlsplit
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

import httpx
from redis.exceptions import RedisError


INDIA = ZoneInfo("Asia/Kolkata")
NEW_YORK = ZoneInfo("America/New_York")
MAX_BYTES = 6_000_000
NSE_NEWS = "https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml"
BSE_NEWS = "https://www.bseindia.com/data/xml/announcements.xml"
SEC_NAMES = "https://www.sec.gov/files/company_tickers_exchange.json"


async def download(client, url, limit=MAX_BYTES):
    async with client.stream("GET", url) as response:
        response.raise_for_status()
        data = bytearray()
        async for part in response.aiter_bytes():
            if len(data) + len(part) > limit:
                raise ValueError("Public source exceeded the response limit")
            data.extend(part)
        return bytes(data)


def price(value):
    result = float(str(value).replace(",", "").replace("$", "").strip())
    if not math.isfinite(result) or result <= 0:
        raise ValueError("Invalid daily price")
    return result


def bar(day, zone, values, url, cutoff):
    # Daily bars become usable only after that trading session has closed.
    close_time = time(15, 30) if zone == INDIA else time(16)
    stamp = datetime.combine(day, close_time, tzinfo=zone)
    if stamp > cutoff:
        return None
    try:
        op, hi, lo, cl = map(price, values[:4])
        if not (lo <= min(op, cl) <= max(op, cl) <= hi):
            return None
        volume = int(str(values[4]).strip().replace(",", ""))
        if volume < 0:
            return None
    except (ValueError, TypeError):
        return None
    return {"kind":"daily_bar", "as_of":stamp.isoformat(), "url":url,
            "open":op, "high":hi, "low":lo, "close":cl, "volume":volume}


def indian_bars(data, venue, day, lookup, url, cutoff):
    if venue == "BSE":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            files = [f for f in archive.infolist() if f.filename.lower().endswith(".csv") and f.file_size <= 12_000_000]
            if len(files) != 1:
                return []
            data = archive.read(files[0])
    found = []
    for raw in csv.DictReader(io.StringIO(data.decode("utf-8-sig"))):
        row = {k.strip(): (v or "").strip() for k,v in raw.items() if k}
        if venue == "NSE":
            if row.get("SERIES") != "EQ" or row.get("DATE1","").casefold() != day.strftime("%d-%b-%Y").casefold():
                continue
            ticker = row.get("SYMBOL")
            fields = ("OPEN_PRICE","HIGH_PRICE","LOW_PRICE","CLOSE_PRICE","TTL_TRD_QNTY")
        else:
            if row.get("TradDt") != day.isoformat():
                continue
            ticker = row.get("TckrSymb")
            if (venue,ticker) not in lookup:
                ticker = row.get("FinInstrmId")
            fields = ("OpnPric","HghPric","LwPric","ClsPric","TtlTradgVol")
        key = lookup.get((venue,ticker))
        if key:
            item = bar(day, INDIA, [row.get(f) for f in fields], url, cutoff)
            if item:
                found.append((key,item))
    return found


def indian_news(data, venue, stocks, cutoff):
    matches = []
    for element in ElementTree.fromstring(data).iter("item"):
        title = element.findtext("title") or ""
        summary = re.sub(r"<[^>]{1,200}>", " ", element.findtext("description") or "")[:1500]
        url = element.findtext("link") or ""
        try:
            stamp = parsedate_to_datetime(element.findtext("pubDate") or "")
            if not stamp.tzinfo or stamp > cutoff or urlsplit(url).scheme != "https":
                continue
        except (ValueError, TypeError):
            continue
        for stock in stocks:
            names = [stock["symbol"]]
            if len(stock["name"])>=5:
                names.append(stock["name"])
            if stock["exchange"]==venue and any(re.search(r"(?<![\w.-])"+re.escape(n)+r"(?![\w.-])",title+" "+summary,re.I) for n in names):
                matches.append((stock["listing"],{"kind":"exchange_notice","as_of":stamp.isoformat(),"title":title[:280],"summary":summary,"url":url}))
    return matches


def upstox_daily_bars(payload, cutoff, url, limit=10):
    sessions = {}
    for row in (payload.get("data") or {}).get("candles") or []:
        if not isinstance(row, list) or len(row) < 6:
            continue
        try:
            stamp = datetime.fromisoformat(row[0])
        except (TypeError, ValueError):
            continue
        if stamp.tzinfo is None:
            continue
        day = stamp.astimezone(INDIA).date()
        item = bar(day, INDIA, row[1:6], url, cutoff)
        if item:
            sessions[day] = item
    return [sessions[day] for day in sorted(sessions, reverse=True)[:limit]]


async def supplement_indian_bars(client, result, cutoff, notices, owner, *, sessions=5, diagnostics=None):
    from app.domains.zerodha.upstox_quote_guard import QuoteGuard, redis_client
    from app.domains.zerodha.upstox_quotes import load_instruments
    missing = [key for key, items in result.items() if len({r["as_of"][:10] for r in items if r["kind"] == "daily_bar"}) < sessions]
    if not missing:
        return
    mapping = await load_instruments(client)
    end = cutoff.astimezone(INDIA).date()
    semaphore = asyncio.Semaphore(4)

    async def fetch(key, guard):
        instrument = mapping.get(key)
        if not instrument:
            if diagnostics is not None:
                diagnostics[key]={"reason":"Exact venue instrument unavailable"}
            return
        url = f"https://api.upstox.com/v3/historical-candle/{quote(instrument, safe='')}/days/1/{end}/{end-timedelta(days=100 if sessions>5 else 24)}"
        async with semaphore:
            try:
                if not await guard.admit():
                    if diagnostics is not None:
                        ttl=await redis.pttl(guard.cooldown)
                        diagnostics[key]={"reason":"Upstox history quota", "retry_after":max(60,(ttl+999)//1000)}
                    notices.append("Upstox historical requests limited")
                    return
                response = await client.get(url, headers={"Authorization": "Bearer " + os.environ["UPSTOX_ANALYTICS_TOKEN"]})
                if response.status_code == 429:
                    await guard.backoff(response.headers.get("Retry-After"))
                    if diagnostics is not None:
                        from app.domains.zerodha.upstox_quote_guard import retry_after_seconds
                        diagnostics[key]={"reason":"Upstox HTTP 429","retry_after":retry_after_seconds(response.headers.get("Retry-After"))}
                response.raise_for_status()
                bars = upstox_daily_bars(response.json(), cutoff, url, limit=max(10,sessions))
                if len(bars) >= max(5, len({r["as_of"][:10] for r in result[key] if r["kind"]=="daily_bar"})):
                    result[key] = [r for r in result[key] if r["kind"] != "daily_bar"] + bars
            except (ValueError, TypeError, AttributeError, httpx.HTTPError):
                if diagnostics is not None:
                    diagnostics.setdefault(key,{"reason":"Upstox historical candles unavailable"})
                notices.append("Historical candles unavailable: " + key)
    async with redis_client() as redis:
        guard = QuoteGuard(redis, os.getenv("UPSTOX_LTP_OWNER_USER_ID") or owner, "history", missing)
        await asyncio.gather(*(fetch(key, guard) for key in missing))


async def collect(manifest, card, *, username=None):
    stocks, cutoff = manifest["stocks"], datetime.fromisoformat(manifest["as_of"])
    result = {s["listing"]:[] for s in stocks}
    extended = manifest["market"]=="india" and card in ("technical","pairwise")
    benchmark_key = "NSE:NIFTYBEES"
    if extended:
        result.setdefault(benchmark_key, [])
    lookup = {(s["exchange"],s["symbol"]):s["listing"] for s in stocks}
    if extended:
        lookup[("NSE","NIFTYBEES")] = benchmark_key
    semaphore = asyncio.Semaphore(5)
    notices = []
    async with httpx.AsyncClient(timeout=4.5, follow_redirects=False, headers={"User-Agent":"Cred-X market research (https://cred-x.in)",
                                  "Accept":"application/json, text/csv, application/xml, */*"}) as client:
        async def task(url, parser):
            try:
                async with semaphore:
                    data = await download(client,url)
                for key, item in parser(data):
                    if key in result:
                        result[key].append(item)
            except (httpx.HTTPError, OSError, ValueError, KeyError, TypeError, ElementTree.ParseError, zipfile.BadZipFile):
                notices.append("Source unavailable: "+urlsplit(url).hostname)
        requests = []
        if manifest["market"] == "india":
            venues = {s["exchange"] for s in stocks}
            if extended:
                venues.add("NSE")
            for offset in range(12):
                day = cutoff.astimezone(INDIA).date()-timedelta(days=offset)
                if day.weekday()>=5:
                    continue
                for venue in venues:
                    url = (f"https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{day:%d%m%Y}.csv" if venue=="NSE" else
                           f"https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{day:%Y%m%d}_F_0000.CSV.ZIP")
                    requests.append(task(url,lambda data,v=venue,d=day,u=url:indian_bars(data,v,d,lookup,u,cutoff)))
            if card!="technical":
                for venue,url in (("NSE",NSE_NEWS),("BSE",BSE_NEWS)):
                    if venue in venues:
                        requests.insert(0,task(url,lambda data,v=venue:indian_news(data,v,stocks,cutoff)))
        else:
            # Resolve the company against a public exchange directory before sending a ticker or CIK to a data source.
            try:
                directory=json.loads(await download(client,SEC_NAMES))
                fields=directory["fields"]
                public=[dict(zip(fields,row)) for row in directory["data"]]
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                public=[]
                notices.append("SEC listing directory unavailable")
            aliases={"Nasdaq":"NASDAQ","NYSE":"NYSE","NYSEArca":"NYSEARCA","NYSE American":"NYSEAMERICAN"}
            for company in public:
                ticker=str(company.get("ticker","")).upper()
                key=lookup.get((aliases.get(company.get("exchange")),ticker))
                if not key or not re.fullmatch(r"[A-Z0-9.-]{1,24}",ticker):
                    continue
                end=cutoff.astimezone(NEW_YORK).date()
                url=f"https://api.nasdaq.com/api/quote/{ticker}/historical?assetclass=stocks&fromdate={end-timedelta(days=24)}&todate={end}&limit=30"
                def bars(data,k=key,u=url):
                    rows=(json.loads(data).get("data") or {}).get("tradesTable") or {}
                    for r in rows.get("rows") or []:
                        day=datetime.strptime(r["date"],"%m/%d/%Y").date()
                        item=bar(day,NEW_YORK,[r.get(f) for f in ("open","high","low","close","volume")],u,cutoff)
                        if item:
                            yield k,item
                requests.append(task(url,bars))
                if card!="technical" and str(company.get("cik","")).isdigit():
                    cik=int(company["cik"])
                    url=f"https://data.sec.gov/submissions/CIK{cik:010}.json"
                    def filings(data,k=key,c=cik):
                        recent=json.loads(data)["filings"]["recent"]
                        for stamp,form,number,doc in zip(*(recent[name] for name in ("acceptanceDateTime","form","accessionNumber","primaryDocument"))):
                            at=datetime.fromisoformat(stamp)
                            if not at.tzinfo or not cutoff-timedelta(days=90)<=at<=cutoff or not re.fullmatch(r"[\w./-]+",doc):
                                continue
                            yield k,{"kind":"filing_index","form":form,"as_of":at.isoformat(),"url":f"https://www.sec.gov/Archives/edgar/data/{c}/{number.replace('-','')}/{doc}"}
                    requests.append(task(url,filings))
        try:
            await asyncio.wait_for(asyncio.gather(*requests),timeout=19)
        except TimeoutError:
            notices.append("Research time limit reached")
        if manifest["market"] == "india":
            from app.domains.zerodha.upstox_quotes import configured_for
            if configured_for(manifest["owner_id"], username):
                try:
                    await asyncio.wait_for(supplement_indian_bars(client, result, cutoff, notices, manifest["owner_id"], sessions=60) if extended else supplement_indian_bars(client, result, cutoff, notices, manifest["owner_id"]), timeout=17)
                except (TimeoutError, httpx.HTTPError, ValueError, OSError, KeyError, EOFError, RuntimeError, RedisError):
                    notices.append("Upstox historical candles unavailable")
        if manifest["market"]=="us" and card!="technical":
            documents=[]
            for key,items in result.items():
                filings = sorted((i for i in items if i["kind"]=="filing_index"),key=lambda i:i["as_of"],reverse=True)
                if not filings:
                    continue
                item=filings[0]
                def filing_text(data,k=key,entry=item):
                    if not data.lstrip().startswith(b"<"):
                        return []
                    text=data.decode("utf-8",errors="replace")
                    text=re.sub(r"(?is)<(?:script|style|ix:header)\b[^>]*>.*?</(?:script|style|ix:header)>"," ",text)
                    text=" ".join(html.unescape(re.sub(r"<[^>]*>"," ",text)).split())
                    if len(text)<100:
                        return []
                    start=re.search(r"\bItem (?:1\.01|2\.02|7\.01|8\.01|1A)\b",text,re.I)
                    pos=start.start() if start else 0
                    return [(k,{**entry,"kind":"filing_excerpt","text":text[pos:pos+2000]})]
                documents.append(task(item["url"],filing_text))
            try:
                await asyncio.wait_for(asyncio.gather(*documents),timeout=8)
            except TimeoutError:
                notices.append("Filing retrieval time limit reached")
    for key,items in result.items():
        ordered=sorted(items,key=lambda i:i["as_of"],reverse=True)
        result[key]=[i for i in ordered if i["kind"]=="daily_bar"][:60 if extended else 10]+[i for i in ordered if i["kind"]!="daily_bar"][:6]
    payload = {"listings":result, "notices":sorted(set(notices))}
    if extended:
        payload["version"] = 2
        payload["benchmark"] = list(result.get(benchmark_key, []))
        if benchmark_key not in {s["listing"] for s in stocks}:
            result.pop(benchmark_key, None)
        from .pair_records import evidence_packets
        payload["packets"] = evidence_packets(payload, manifest["as_of"])
    return payload
