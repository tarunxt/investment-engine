"""Venue-session archives and point-in-time source reconciliation for Technical v3."""
import asyncio
import base64
import csv
import io
import json
import logging
import os
import re
import zipfile
from datetime import date, datetime, time, timedelta, timezone
from email.utils import parsedate_to_datetime
from statistics import mean

import httpx
from redis.exceptions import RedisError

from .rebalance_identity import SIEMENS_ALIAS, SIEMENS_IDENTITY, documented_alias
from .research import INDIA, bar, download, supplement_indian_bars
from .technical_v3 import BENCHMARK, calculate, normalise
from .universe import digest
from app.domains.zerodha.upstox_quote_guard import redis_client
from app.domains.zerodha.upstox_quotes import configured_for, technical_instruments

log = logging.getLogger(__name__)
HOLIDAYS = "https://api.upstox.com/v2/market/holidays"
MASTER = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz"
ERRORS = (httpx.HTTPError, ValueError, OSError, KeyError, TypeError, EOFError, RuntimeError, RedisError, zipfile.BadZipFile)
# Published 2026 Indian cash-equity calendar, including the Budget and Muhurat sessions.
CLOSED_2026 = set("01-15 01-26 03-03 03-26 03-31 04-03 04-14 05-01 05-28 06-26 09-14 10-02 10-20 11-10 11-24 12-25".split())
SPECIAL_2026 = {"02-01":time(15,30), "11-08":time(15,35)}


def session_calendar(cutoff, venue, holidays, sessions=60):
    local=cutoff.astimezone(INDIA)
    by_date={v["date"]:v for v in holidays if isinstance(v,dict) and v.get("date")}
    years={d[:4] for d in by_date}
    schedule={}
    for offset in range(max(105, sessions * 2),-1,-1):
        day=local.date()-timedelta(days=offset)
        if day.year!=2026 and str(day.year) not in years:
            schedule.clear()
            continue
        md=day.strftime("%m-%d")
        regular=day.weekday()<5 and (day.year!=2026 or md not in CLOSED_2026)
        close=time(15,30) if regular else None
        if day.year==2026 and md in SPECIAL_2026:
            close=SPECIAL_2026[md]
        event=by_date.get(day.isoformat(),{})
        if venue in event.get("closed_exchanges",[]):
            close=None
        for item in event.get("open_exchanges",[]):
            if item.get("exchange")==venue and item.get("end_time"):
                close=datetime.fromtimestamp(item["end_time"]/1000,INDIA).time()
        if close:
            end=datetime.combine(day,close,INDIA)
            if end<=local:
                schedule[day.isoformat()]=end.isoformat()
    return dict(list(schedule.items())[-sessions:])


# Legacy Swing exports used the escaped ticker M_M. The NSE filing identifies the
# ordinary equity share class; a current, matching same-venue master is required.
FILING = "https://nsearchives.nseindia.com/corporate/ixbrl/INTEGRATED_FILING_INDAS_180552_30072026161119_iXBRL_WEB.html"
VERIFIED_ALIASES = {"NSE:M_M": ("NSE:M&M", "INE101A01026", FILING), SIEMENS_ALIAS: SIEMENS_IDENTITY}


def resolve_aliases(keys, master, stocks=()):
    identity = {s["listing"]: s for s in stocks}
    aliases={}
    for key in keys:
        if key == SIEMENS_ALIAS and not documented_alias(identity.get(key, {"listing": key}), master):
            continue
        if key not in VERIFIED_ALIASES:
            continue
        target,isin,_=VERIFIED_ALIASES[key]
        if master.get(target,{}).get("isin")==isin and (key not in master or master[key]["isin"]==isin):
            aliases[key]=target
    return aliases


def eligible_vintage(row,cutoff):
    stamp=row.get("published_at") or row.get("received_at")
    try:
        observed=datetime.fromisoformat(stamp)
        return observed.tzinfo is not None and observed<=cutoff
    except (ValueError, TypeError):
        return False


def archive_url(venue, day):
    stamp=day.replace("-","")
    if venue=="NSE":
        return f"https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{stamp}_F_0000.csv.zip"
    return f"https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{stamp}_F_0000.CSV.ZIP"


def extract_archive(data, venue, day, close, wanted, url):
    found={}
    by_isin={}
    if isinstance(wanted,dict):
        for listing,isin in wanted.items():
            if isin:
                by_isin.setdefault(isin,[]).append(listing)
    wanted_keys=set(wanted)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        files=[f for f in archive.infolist() if f.filename.lower().endswith(".csv") and f.file_size<=16_000_000]
        if len(files)!=1:
            raise ValueError("Unexpected exchange archive")
        with archive.open(files[0]) as stream:
            for row in csv.DictReader(io.TextIOWrapper(stream,encoding="utf-8-sig")):
                if row.get("TradDt")!=day or (venue=="NSE" and row.get("SctySrs")!="EQ"):
                    continue
                matches={f"{venue}:{symbol}" for symbol in (row.get("TckrSymb"),row.get("FinInstrmId"))} & wanted_keys
                aliases=by_isin.get(row.get("ISIN"),[])
                if len(aliases)==1:
                    matches.add(aliases[0])
                for key in matches:
                    if isinstance(wanted, dict) and wanted.get(key) and wanted[key] != row.get("ISIN"):
                        continue
                    values=[row.get(k) for k in ("OpnPric","HghPric","LwPric","ClsPric","TtlTradgVol")]
                    item=bar(date.fromisoformat(day),INDIA,values,url,datetime.max.replace(tzinfo=timezone.utc),optional_volume=True)
                    if item:
                        item.update(as_of=close,isin=row.get("ISIN"),basis="venue-raw")
                        found.setdefault(key,[]).append(item)
    return found


def action_ledger(rows, start, end):
    events=[]
    for r in rows:
        kind=str(r["name"]).lower()
        if "dividend" in kind or "interest" in kind:
            continue
        day=datetime.strptime(r["expiry_date"],"%d %b %Y").date().isoformat()
        if not start < day <= end:
            continue
        factor=None
        if "bonus" in kind:
            match=re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*",str(r.get("ratio")))
            if match and float(match[2])>0:
                factor=1+float(match[1])/float(match[2])
        if "split" in kind or "consolidat" in kind:
            # Face values specify the direction unambiguously, including reverse splits.
            details=" ".join(str(e.get("value","")) for e in (r.get("event_details") or []))
            match=re.search(r"from\s+(?:rs\.?|inr|₹)?\s*(\d+(?:\.\d+)?)(?:\s*/-)?\s*(?:each\s+)?to\s+(?:rs\.?|inr|₹)?\s*(\d+(?:\.\d+)?)",details,re.I)
            if match and float(match[2])>0:
                factor=float(match[1])/float(match[2])
        event={"date":day,"kind":kind,"multiplier":factor,"ratio":r.get("ratio")}
        if event not in events:
            events.append(event)
    return sorted(events,key=lambda a:a["date"])


def nse_actions(raw, wanted):
    if not isinstance(raw,list) or not raw or not all(isinstance(r,dict) and "exDate" in r and "subject" in r and r.get("isin") for r in raw):
        raise ValueError("Incomplete NSE action ledger")
    result={isin:[] for isin in wanted}
    for r in raw:
        isin=r.get("isin")
        if isin not in wanted:
            continue
        text=r["subject"]
        day=datetime.strptime(r["exDate"],"%d-%b-%Y").date().isoformat()
        if re.search(r"split|sub.division|consolidat|bonus|rights|merger|demerger|arrangement|reduction",text,re.I):
            ratio=None
            if re.search("bonus",text,re.I):
                pair=re.search(r"(\d+)\s*:\s*(\d+)",text)
                if pair and int(pair[2]):
                    ratio=1+int(pair[1])/int(pair[2])
            elif re.search(r"split|sub.division|consolidat",text,re.I):
                vals=re.search(r"from\s*(?:rs\.?|inr|₹)?\s*(\d+(?:\.\d+)?)(?:\s*/-)?(?:\s*each)?\s*to\s*(?:rs\.?|inr|₹)?\s*(\d+(?:\.\d+)?)",text,re.I)
                if vals and float(vals[2])>0:
                    ratio=float(vals[1])/float(vals[2])
            event={"date":day,"kind":text,"multiplier":ratio}
            if event not in result[isin]:
                result[isin].append(event)
    return result


def resolve_history_instruments(stocks, master, previous):
    """Keep venue identity fixed, including when a source escaped punctuation."""
    aliases = {}
    for stock in stocks:
        key = stock["listing"]
        if key in master:
            continue
        venue, symbol = key.split(":", 1)
        prior = previous.get("technical", {}).get(key, {}).get("sources", {}).get("stock", {})
        known = {r["isin"] for r in previous.get("listings", {}).get(key, []) if r.get("isin")}
        known.update(i for i in (stock.get("isin"), prior.get("instrument")) if i)
        name = lambda value: re.sub(r"[^a-z0-9]", "", re.sub(r"\b(?:limited|ltd)\.?$", "", (value or "").casefold().strip()).replace("&","and"))
        verified = documented_alias(stock, master)
        if verified and (not known or known == {master[verified]["isin"]}):
            aliases[key] = verified
            continue
        # Swing descriptive tickers require corroboration from the frozen issuer or ISIN.
        canonical = {
            "NSE:ICICIBC": ("NSE:ICICIBANK", "INE090A01021", "icicibank"),
            "NSE:PBFINTECH": ("NSE:POLICYBZR", "INE417T01026", "pbfintech"),
            "NSE:RIL": ("NSE:RELIANCE", "INE002A01018", "relianceindustries"),
        }.get(key)
        if canonical:
            candidate, isin, issuer = canonical
            if master.get(candidate, {}).get("isin") == isin and (
                known == {isin} or (not known and name(stock.get("name")) == issuer)
            ):
                aliases[key] = candidate
                continue
        matches = []
        for candidate, meta in master.items():
            if not candidate.startswith(venue + ":") or not meta.get("isin"):
                continue
            same_isin = known == {meta["isin"]}
            same_alias = ("_" in symbol and candidate.split(":",1)[1].replace("&","_") == symbol
                          and name(stock.get("name")) and name(stock["name"]) == name(meta.get("name")))
            if same_isin or (not known and same_alias):
                matches.append(candidate)
        if len(matches) == 1:
            aliases[key] = matches[0]
    return aliases


async def collect(manifest, username, previous=None, requested=None, *, sessions=60, pair_repair=False, action_only=(), recovery_as_of=None):
    cutoff=datetime.fromisoformat(manifest["as_of"])
    receipt=datetime.now(timezone.utc)
    availability_cutoff = recovery_as_of or (receipt if pair_repair else cutoff)
    ids=[s["listing"] for s in manifest["stocks"]]
    keys=set(requested if requested is not None else ids)|{BENCHMARK}
    venues={k.split(":")[0] for k in keys}
    previous=previous or {}
    records={k:list(previous.get("listings",{}).get(k,[])) for k in keys}
    notices=[]
    provider_status={k:v for k,v in previous.get("provider_status",{}).items() if k not in keys} if pair_repair else {}
    per_key={k:[] for k in keys}
    actions={}
    action_urls={}
    calendars=dict(previous.get("calendars",{})) if pair_repair else {}
    master={}
    sources={}
    eligible_token=configured_for(manifest["owner_id"],username)
    auth={"Authorization":"Bearer "+os.environ["UPSTOX_ANALYTICS_TOKEN"]} if eligible_token else {}
    redis=None
    try:
        redis=redis_client()
    except RuntimeError:
        pass
    async def cached(key):
        if redis is not None:
            try:
                value=await redis.get("tech3:"+key)
                return json.loads(value) if value else None
            except (RedisError,ValueError):
                pass
        return None
    async def cache(key,value,ttl):
        if redis is not None:
            try:
                await redis.set("tech3:"+key,json.dumps(value,separators=(",",":")),ex=ttl)
            except RedisError:
                pass
    async with httpx.AsyncClient(timeout=5,headers={"User-Agent":"Cred-X market research (https://cred-x.in)"}) as client:
        async def calendar():
            try:
                saved=await cached("holidays:"+str(receipt.year))
                if saved is None:
                    response=await client.get(HOLIDAYS,headers=auth)
                    response.raise_for_status()
                    saved=response.json()["data"]
                    if not isinstance(saved,list):
                        raise ValueError("Malformed trading calendar")
                    await cache("holidays:"+str(receipt.year),saved,21600)
            except ERRORS:
                saved=[]
            for venue in venues:
                calendars[venue]=session_calendar(cutoff,venue,saved,sessions)
        async def instruments():
            nonlocal master
            try:
                master=await technical_instruments(client)
            except ERRORS:
                notices.append("Instrument master unavailable")
        await asyncio.gather(calendar(),instruments())
        aliases={} if pair_repair else resolve_aliases(ids,master,manifest["stocks"])
        original_keys=keys.copy()
        keys={aliases.get(k,k) for k in keys}
        for key in keys:
            records.setdefault(key,list(previous.get("listings",{}).get(key,[])))
            per_key.setdefault(key,[])
        for key,evidence in previous.get("prior_bars",{}).items():
            if key not in keys or master.get(key,{}).get("isin")!=evidence["instrument"]:
                continue
            known={r["as_of"][:10] for r in records[key]}
            schedule=calendars.get(key.partition(":")[0],{})
            records[key].extend(r for r in evidence["bars"] if r.get("kind")=="daily_bar" and r["as_of"][:10] in schedule
                                and r["as_of"][:10] not in known and eligible_vintage(r,availability_cutoff))
            stock=evidence["stock"]
            if (evidence.get("as_of") and datetime.fromisoformat(evidence["as_of"]).astimezone(INDIA).date()==cutoff.astimezone(INDIA).date()
                    and stock.get("action_url")):
                actions[evidence["instrument"]]=stock["actions"]
                action_urls[evidence["instrument"]]=stock["action_url"]
        pair_aliases = resolve_history_instruments(manifest["stocks"], master, previous) if pair_repair else {}
        master = {**master, **{k: master[v] for k,v in pair_aliases.items()}}
        if pair_repair:
            for key, row in previous.get("technical", {}).items():
                source = row.get("sources", {}).get("stock", {})
                isin = source.get("instrument")
                if not isin or (key in master and master[key]["isin"] != isin):
                    continue
                master.setdefault(key, {"isin":isin, "tick":source.get("tick")})
                if source.get("action_url"):
                    actions[isin] = source["actions"]
                    action_urls[isin] = source["action_url"]
        archive_status = {}
        semaphore=asyncio.Semaphore(8)
        async def history(venue,day,close):
            subset={k:master.get(k,{}).get("isin") for k in keys if k.startswith(venue+":")}
            subset={k:v for k,v in subset.items() if not any(r.get("basis")=="venue-raw" and r.get("isin")==v and r["as_of"][:10]==day for r in records[k])}
            if pair_repair:
                subset = {k:i for k,i in subset.items() if k not in action_only and not any(
                    r["as_of"][:10] == day and (r.get("basis") == "venue-raw" or
                    (r.get("basis") == "unverified-provider" and i)) for r in records[k])}
            if not subset:
                return
            # Share each verified venue/instrument/session across overlapping universes.
            ck="tech3:bars:"+venue+":"+day
            fields={k:k+"|"+(isin or "") for k,isin in subset.items()}
            found={}
            if redis is not None and fields:
                try:
                    values=await redis.hmget(ck,list(fields.values()))
                    found={k:json.loads(v) for k,v in zip(fields,values) if v}
                except (RedisError,ValueError):
                    pass
            subset={k:v for k,v in subset.items() if k not in found}
            if subset:
                # Store the complete public exchange file once per venue/session. Its
                # publication vintage follows the file even when the requested universe changes.
                file_key=f"venue-file:v1:{venue}:{day}"
                url=archive_url(venue,day)
                async with semaphore:
                    try:
                        saved=await cached(file_key)
                        if saved:
                            compressed=base64.b64decode(saved["zip"],validate=True)
                            stamp=saved["received_at"]
                            published=saved.get("published_at")
                        else:
                            # Only one worker downloads this public venue/session file at a time.
                            # The short lease also bounds repeat requests after an exchange error.
                            if redis is not None:
                                try:
                                    acquired = await redis.set("tech3:fetch:"+file_key, "1", nx=True, ex=25)
                                except RedisError:
                                    acquired = True
                                if not acquired:
                                    if day == max(calendars[venue]):
                                        archive_status[venue] = "Archive fetch already requested"
                                    return
                            async with client.stream("GET",url) as response:
                                response.raise_for_status()
                                modified=response.headers.get("last-modified")
                                chunks=bytearray()
                                async for chunk in response.aiter_bytes():
                                    chunks.extend(chunk)
                                    if len(chunks)>6_000_000:
                                        raise ValueError("Oversized archive")
                            compressed=bytes(chunks)
                            stamp=datetime.now(timezone.utc).isoformat()
                            published=parsedate_to_datetime(modified).isoformat() if modified else None
                        if day == max(calendars[venue]):
                            archive_status[venue] = "Cached daily file" if saved else "Daily file received"
                        downloaded=await asyncio.to_thread(extract_archive,compressed,venue,day,close,subset,url)
                        if not saved:
                            await cache(file_key,{"zip":base64.b64encode(compressed).decode("ascii"),"received_at":stamp,
                                            "published_at":published},86400*7)
                        for rows in downloaded.values():
                            for item in rows:
                                item.update(received_at=stamp,published_at=published)
                        found.update(downloaded)
                        if downloaded and redis is not None:
                            async with redis.pipeline(transaction=True) as pipe:
                                pipe.hset(ck,mapping={fields[k]:json.dumps(rows) for k,rows in downloaded.items()})
                                pipe.expire(ck,86400*(400 if sessions>60 else 7))
                                await pipe.execute()
                    except ERRORS as exc:
                        if day == max(calendars[venue]):
                            archive_status[venue] = (f"Exchange HTTP {exc.response.status_code}"
                                if isinstance(exc,httpx.HTTPStatusError) else type(exc).__name__)
            for key,rows in found.items():
                rows=[r for r in rows if not r.get("published_at") or datetime.fromisoformat(r["published_at"])<=availability_cutoff]
                by_day={r["as_of"][:10] for r in rows}
                records[key]=[r for r in records[key] if r["as_of"][:10] not in by_day]+rows
        start_day=cutoff.astimezone(INDIA).date()-timedelta(days=max(105, sessions * 2))
        end_day=cutoff.astimezone(INDIA).date()
        exchange_actions=("https://www.nseindia.com/api/corporates-corporateActions?index=equities"
                          +f"&from_date={start_day:%d-%m-%Y}&to_date={end_day:%d-%m-%Y}")
        isins={master[k]["isin"] for k in keys if k in master}
        dual_listed=isins & {i["isin"] for k,i in master.items() if k.startswith("NSE:")}
        try:
            wanted_actions = dual_listed - actions.keys()
            bulk=await cached(f"nse-actions:{start_day}:{end_day}") if wanted_actions else []
            if bulk is None:
                bulk=json.loads(await download(client,exchange_actions))
                if isinstance(bulk,list) and bulk:
                    await cache(f"nse-actions:{start_day}:{end_day}",bulk,3600)
            if wanted_actions:
                actions.update(nse_actions(bulk,wanted_actions))
                action_urls.update({isin:exchange_actions for isin in wanted_actions})
        except ERRORS:
            notices.append("NSE corporate-action ledger unavailable")
        async def ledger(isin):
            key=f"actions:{isin}:{start_day}:{end_day}"
            data=await cached(key)
            url=f"https://api.upstox.com/v2/fundamentals/{isin}/corporate-actions"
            if data is None:
                async with semaphore:
                    try:
                        response=await client.get(url,headers=auth)
                        response.raise_for_status()
                        body=response.json()
                        if body.get("status")!="success" or not isinstance(body.get("data"),list):
                            raise ValueError("Malformed action ledger")
                        data=action_ledger(body["data"],(cutoff.date()-timedelta(days=max(110, sessions * 2))).isoformat(),cutoff.astimezone(INDIA).date().isoformat())
                        await cache(key,data,3600)
                    except ERRORS:
                        return
            actions[isin]=data
            action_urls[isin]=url
        for key in keys:
            prior=previous.get("technical",{}).get(key,{})
            for source in (prior.get("sources") or {}).values():
                isin=source.get("instrument")
                if prior.get("as_of")==manifest["as_of"] and isin in isins and isin not in actions and source.get("action_url"):
                    actions[isin]=source["actions"]
                    action_urls[isin]=source["action_url"]
        tasks=[asyncio.create_task(ledger(i)) for i in isins-actions.keys()]
        # Start with newest sessions. A bounded cold fetch retains all completed days.
        for days_ago in range(sessions):
            for venue,cal in calendars.items():
                dates=list(cal.items())
                if days_ago<len(dates):
                    day,close=dates[-1-days_ago]
                    tasks.append(asyncio.create_task(history(venue,day,close)))
        if tasks:
            _,pending=await asyncio.wait(tasks,timeout=22)
            for t in pending:
                t.cancel()
            outcomes=await asyncio.gather(*tasks,return_exceptions=True)
            if pending or any(isinstance(v,Exception) for v in outcomes):
                notices.append("Exchange history or actions incomplete within the retrieval window")
        if pair_repair:
            from .rebalance_close import recover_closes
            selected = [stock for stock in manifest["stocks"] if stock["listing"] in keys - set(action_only)]
            await recover_closes(client, redis, {**manifest, "stocks": selected}, username,
                                 {"calendars": calendars, "listings": records}, master,
                                 refresh=True, optional_volume=True)
        if eligible_token:
            def broker_key(k):
                return f"broker-bars:v1:{manifest['owner_id']}:{k}:{master[k]['isin']}"
            # Broker data is account-scoped. Reuse only exact-identity candles known at cutoff.
            async def reuse(k):
                if k not in master:
                    return
                saved=await cached(broker_key(k)) or []
                existing={r["as_of"][:10] for r in records[k]}
                schedule=calendars[k.partition(":")[0]]
                records[k].extend(r for r in saved if r["as_of"][:10] in schedule
                                  and r["as_of"][:10] not in existing and eligible_vintage(r,availability_cutoff))
            await asyncio.gather(*(reuse(k) for k in keys))
            supplement={k:[] for k in sorted(keys) if k not in action_only and set(list(calendars[k.partition(":")[0]])[-(sessions if sessions>60 else 55):])-
                         {r["as_of"][:10] for r in records[k]}}
            if supplement:
                try:
                    await asyncio.wait_for(supplement_indian_bars(client,supplement,cutoff,notices,manifest["owner_id"],sessions=sessions,diagnostics=provider_status,
                        **({"optional_volume":True} if pair_repair else {}), **({"verified_keys":pair_aliases} if pair_aliases else {}), **({"calendars":calendars} if sessions>60 or pair_repair else {})),25 if sessions>60 else 10)
                except (*ERRORS,TimeoutError):
                    notices.append("Alternate history unavailable")
                for k,rows in supplement.items():
                    official={r["as_of"][:10] for r in records[k] if r.get("basis")=="venue-raw"}
                    dates=calendars.get(k.split(":")[0],{})
                    for r in rows:
                        day=r["as_of"][:10]
                        if day in dates and day not in official:
                            records[k]=[v for v in records[k] if v["as_of"][:10]!=day]
                            records[k].append({**r,"as_of":dates[day],"received_at":receipt.isoformat(),"basis":"unverified-provider"})
                    if rows and k in master:
                        await cache(broker_key(k),[r for r in records[k] if r.get("basis")=="unverified-provider"],86400*7)
    if redis is not None:
        await redis.aclose()
    series={}
    for k in keys:
        meta=master.get(k,{})
        isin=meta.get("isin")
        if not isin:
            per_key[k].append("Exact venue instrument unavailable")
        if not isin or isin not in actions:
            per_key[k].append("Corporate-action history unavailable for this instrument")
        wrong=any(r.get("isin") and r["isin"]!=isin for r in records[k])
        if wrong:
            per_key[k].append("Instrument identity changed within the lookup window")
        days=list(calendars[k.split(":")[0]])
        # Retain a verified action ledger from the identical frozen packet on a transient outage.
        prior=previous.get("technical",{}).get(k,{})
        prior_stock=(prior.get("sources") or {}).get("stock",{})
        if isin and isin not in actions and prior.get("as_of")==manifest["as_of"] and prior_stock.get("instrument")==isin and prior_stock.get("action_url"):
            actions[isin]=prior_stock["actions"]
            action_urls[isin]=prior_stock["action_url"]
            per_key[k].remove("Corporate-action history unavailable for this instrument")
        events=actions.get(isin,[])
        scoring_bars = records[k]
        if days and not pair_repair:
            # Keep the raw archive for provenance. A final candle first observed after
            # the decision cutoff becomes eligible in a separate recovery revision.
            scoring_bars = [bar for bar in scoring_bars if bar["as_of"][:10] != days[-1]
                            or eligible_vintage(bar, datetime.now(timezone.utc) if recovery_as_of else cutoff)]
        series[k]=normalise(scoring_bars,days,events,manifest["as_of"])
        # A large unaccounted change of share basis must be reviewed before scoring.
        observed=[series[k][0][d] for d in days if d in series[k][0]]
        if (any(max(a[3],b[0])/min(a[3],b[0])>1.45 for a,b in zip(observed,observed[1:]))
                and any(r.get("basis")!="venue-raw" for r in records[k])):
            per_key[k].append("Exceptional price gap requires source reconciliation")
        sources[k]={"instrument":isin,"tick":meta.get("tick"),"master":MASTER,"calendar":HOLIDAYS,
                    "action_url":action_urls.get(isin),
                    "actions":events,"history_hash":digest(sorted(({a:b for a,b in r.items() if a!="received_at"} for r in records[k]),key=lambda r:(r["as_of"],r["url"]))),
                    "last_bar":max(records[k],key=lambda r:r["as_of"],default=None)}
    scoring_started = datetime.now(timezone.utc)
    index_prices=series[BENCHMARK][0]
    index_dates=list(calendars["NSE"])[-50:]
    if not per_key[BENCHMARK] and len(index_dates)==50 and all(d in index_prices for d in index_dates):
        closes=[index_prices[d][3] for d in index_dates]
        sources[BENCHMARK]["regime"]="Above SMA50" if closes[-1]>=mean(closes) else "Below SMA50"
    ledgers=dict(previous.get("technical",{}))
    for k in sorted(keys):
        if k not in {aliases.get(raw,raw) for raw in ids}:
            continue
        dates=list(calendars[k.split(":")[0]])
        row=calculate(k,manifest["as_of"],dates,series[k],({}, {}) if per_key[BENCHMARK] else series[BENCHMARK],
                      tick=sources[k]["tick"],sources={"stock":sources[k],"benchmark":sources[BENCHMARK]},
                      issues=per_key[k],benchmark_sessions=list(calendars["NSE"]))
        row["provider_status"]=provider_status.get(k, {})
        row["benchmark_missing_sessions"] = [d for d in list(calendars["NSE"])[-41:] if d not in index_prices]
        row["archive_status"] = archive_status.get(k.split(":")[0])
        row["stock_close_missing"] = bool(dates and dates[-1] not in series[k][0])
        provider_reason = row["provider_status"].get("reason")
        if row["score"] is None and provider_reason and provider_reason not in per_key[k]:
            row["reason"] = " · ".join(filter(None, (row["reason"], provider_reason)))
        row["observed_at"]=datetime.now(timezone.utc).isoformat()
        # A later history download without a pre-cutoff vintage remains a reconstruction.
        stock_bars=records[k]
        latest_source=all(
            (r.get("published_at") and datetime.fromisoformat(r["published_at"])<=cutoff)
            or (r.get("received_at") and datetime.fromisoformat(r["received_at"])<=cutoff)
            for r in stock_bars+records[BENCHMARK])
        row["vintage"]="prospective" if abs((receipt-cutoff).total_seconds())<=300 and latest_source else "later reconstruction"
        row["input_hash"]=digest([k,manifest["as_of"],dates,sources[k]["instrument"],sources[k]["history_hash"],sources[k]["actions"],
                                  sources[BENCHMARK]["history_hash"],sources[BENCHMARK]["actions"],row["factors"],row["reason"]])
        ledgers[k]=row
    for raw,target in aliases.items():
        if raw in original_keys and target in ledgers:
            prior=previous.get("technical",{}).get(target,{})
            verified=prior if prior.get("coverage")=="Complete" and prior.get("as_of")==manifest["as_of"] and prior.get("sources",{}).get("stock",{}).get("instrument")==VERIFIED_ALIASES[raw][1] else ledgers[target]
            ledgers[raw]={**verified,"listing":raw,"canonical_listing":target,"identity_source":VERIFIED_ALIASES[raw][2],
                          "input_hash":digest([verified["input_hash"],raw,target,VERIFIED_ALIASES[raw]])}
            records[raw]=previous["listings"][target] if verified is prior else records[target]
            if target not in original_keys and prior:
                ledgers[target]=prior
                records[target]=previous["listings"][target]
    finished = datetime.now(timezone.utc)
    score_times = [row["observed_at"] for row in ledgers.values() if row.get("score") is not None and row.get("observed_at")]
    timing = {"retrieval_started": receipt.isoformat(), "scoring_started": scoring_started.isoformat(),
              "first_score": min(score_times, default=None), "last_score": max(score_times, default=None),
              "evidence_seconds": round((scoring_started-receipt).total_seconds(), 2),
              "score_seconds": round((finished-scoring_started).total_seconds(), 3)}
    return {"version":3,"timing":timing,"technical":ledgers,"notices":sorted(set(notices)),"calendars":calendars,"provider_status":provider_status,
            "listings":{**previous.get("listings",{}),**records},"benchmark":records[BENCHMARK]}
