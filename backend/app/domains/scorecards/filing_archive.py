"""Point-in-time index of issuer statements independently collected from the exchange."""
import asyncio
import json
import re
from datetime import date, datetime, timedelta, timezone
from lxml import html

import httpx
from redis.exceptions import RedisError

from app.domains.zerodha.upstox_quote_guard import redis_client
from app.domains.zerodha.upstox_quotes import technical_instruments
from .rebalance_filings import published, recent, statement
from .research import download

INDEX = "https://www.nseindia.com/api/corporates-financial-results"
LINK = re.compile(r"https://(?:nsearchives|archives)\.nseindia\.(?:com|in)/corporate/[A-Za-z0-9_./%+()-]+\.xml", re.I)
PREFIX = "rebalance:issuer-statements:v1:"
# Reviewed issuer release. Use the end of publication day for date-only releases.
REVIEWED = {"INE090A01021": [{
    "kind":"results", "scope":"standalone", "as_of":"2026-10-17T23:59:59.999999+05:30",
    "url":"https://www.icici.bank.in/about-us/news-room/2026/performance-review-quarter-ended-september-30-2026",
    "facts":[{"period":["2026-07-01","2026-09-30"],"values":{"ProfitLossForPeriod":[14843,"INR crore"]}},
             {"period":["2025-07-01","2025-09-30"],"values":{"ProfitLossForPeriod":[12359,"INR crore"]}}]
}]}


async def lookup(cache, isin, cutoff):
    docs = recent(REVIEWED.get(isin, []), cutoff)
    if cache is not None and isin:
        try:
            items = await cache.zrevrangebyscore(PREFIX + isin, cutoff.timestamp(),
                (cutoff-timedelta(days=185)).timestamp(), start=0, num=24)
            docs.extend(json.loads(item) for item in items)
        except (RedisError, ValueError, OSError):
            pass
    return docs


async def icici_release(client, observed):
    """Read the issuer's standalone quarterly table and date new observations conservatively."""
    start = date(observed.year, 3 * ((observed.month - 1) // 3) + 1, 1)
    end = start - timedelta(days=1)
    url = ("https://www.icici.bank.in/about-us/news-room/" + str(end.year) +
           "/performance-review-quarter-ended-" + end.strftime("%B-%d-%Y").lower())
    root = html.fromstring(await download(client, url))
    tables = root.xpath("//*[normalize-space(text())='Summary Profit and Loss Statement (as per standalone Indian GAAP accounts)']/following::table[1]")
    if not tables:
        return None
    rows = [[" ".join(c.text_content().split()) for c in r.xpath("./th|./td")]
            for r in tables[0].xpath(".//tr")]
    header = next((r for r in rows if any(re.fullmatch(r"Q[1-4]-[0-9]{4}", c) for c in r)), [])
    values = next((r for r in rows if r and r[0].lower()=="profit after tax"), [])
    if len(header)!=len(values) or not any("crore" in c.lower() for row in rows for c in row):
        return None
    facts = []
    for label, value in zip(header, values):
        m = re.fullmatch(r"Q([1-4])-([0-9]{4})", label)
        if not m or not re.fullmatch(r"-?[0-9][0-9,]*", value):
            continue
        quarter, year = map(int, m.groups())
        first = date(year if quarter==4 else year-1, (quarter*3)%12+1, 1)
        after = first+timedelta(days=93)
        last = after.replace(day=1)-timedelta(days=1)
        if last<=end:
            facts.append({"period":[first.isoformat(),last.isoformat()],
                          "values":{"ProfitLossForPeriod":[int(value.replace(",","")),"INR crore"]}})
    if not any(f["period"][1]==end.isoformat() for f in facts):
        return None
    return {"kind":"results","scope":"standalone","as_of":observed.isoformat(),"facts":facts,"url":url}


async def refresh(stocks):
    from .rebalance_identity import aliases
    cutoff = datetime.now(timezone.utc)
    async with redis_client() as cache, httpx.AsyncClient(timeout=12, follow_redirects=False) as client:
        master = await technical_instruments(client)
        canonical = aliases(stocks, master)
        wanted = {master.get(canonical.get(s["listing"],s["listing"]),{}).get("isin") for s in stocks}
        if "INE090A01021" in wanted:
            try:
                release = await icici_release(client, cutoff)
                if release:
                    # Keep the earliest verified observation of this exact release.
                    key = PREFIX + "INE090A01021"
                    existing = await lookup(cache, "INE090A01021", cutoff)
                    if not any(d["url"]==release["url"] and d["facts"]==release["facts"] for d in existing):
                        await cache.zadd(key,{json.dumps(release,sort_keys=True):cutoff.timestamp()})
                        await cache.expire(key,371*86400)
            except (httpx.HTTPError, OSError, ValueError, SyntaxError):
                pass
        response = await client.get(INDEX, params={"index":"equities",
            "from_date":(cutoff-timedelta(days=185)).strftime("%d-%m-%Y"),"to_date":cutoff.strftime("%d-%m-%Y")})
        response.raise_for_status()
        payload = response.json()
        rows = payload.get("data",[]) if isinstance(payload,dict) else payload
        candidates = {}
        for row in rows:
            isin, url = row.get("isin"), row.get("xbrl") or ""
            stamp = published(row.get("exchdisstime") or row.get("filingDate"))
            if not isin or isin not in wanted or not LINK.fullmatch(url) or not stamp or not cutoff-timedelta(days=185)<=stamp<=cutoff:
                continue
            if master.get("NSE:"+str(row.get("symbol")),{}).get("isin") != isin:
                continue
            candidates.setdefault(isin, {})[url] = stamp
        semaphore = asyncio.Semaphore(5)
        async def save(isin, url, stamp):
            async with semaphore:
                try:
                    doc = statement(await download(client,url), stamp, url)
                except (httpx.HTTPError, OSError, ValueError, SyntaxError):
                    return 0
                if not doc["facts"]:
                    return 0
                async with cache.pipeline(transaction=True) as pipe:
                    key = PREFIX + isin
                    pipe.zadd(key,{json.dumps(doc,sort_keys=True):stamp.timestamp()})
                    pipe.zremrangebyscore(key, "-inf", (cutoff-timedelta(days=370)).timestamp())
                    pipe.expire(key, 371*86400)
                    await pipe.execute()
                return 1
        return sum(await asyncio.gather(*(save(isin,url,stamp) for isin,docs in candidates.items()
            for url,stamp in sorted(docs.items(),key=lambda item:item[1],reverse=True)[:3])))
