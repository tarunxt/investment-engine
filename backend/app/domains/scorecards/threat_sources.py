"""Frozen, category-scoped evidence for the Indian 90-day Threats assessment."""
import asyncio
from collections import defaultdict
import hashlib
import json
import math
import re
import subprocess
import zipfile
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo
from urllib.parse import quote, urlencode, urljoin, urlsplit
from xml.etree import ElementTree

import httpx
from lxml import html

from app.domains.zerodha.upstox_quotes import technical_instruments
from . import threat_archive
from .threat_recovery import filing_facts, technical_sessions
from .threat_issuer import indexed_filings, primary_filing
from .research import INDIA, BSE_NEWS, NSE_NEWS, download, indian_bars, indian_news, supplement_indian_bars
from redis.exceptions import RedisError
from .technical_sources import archive_url, extract_archive, session_calendar

FX_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml"
FEEDS = {
    "https://rbi.org.in/pressreleases_rss.xml": ("C3",),
    "https://rbi.org.in/notifications_rss.xml": ("C4",),
    "https://www.federalreserve.gov/feeds/press_monetary.xml": ("C2",),
    "https://www.sebi.gov.in/sebirss.xml": ("C4",),
    "https://www.wto.org/library/rss/latest_news_e.xml": (),
    "https://cap-sources.s3.amazonaws.com/in-imd-en/rss.xml": ("C7",),
    "https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=1": (),
}
CATEGORIES = tuple(f"C{i}" for i in range(1, 9))
KEYWORDS = {
    "C1": r"tariff|trade (agreement|dispute|restriction)|export (restriction|control)|import duty|sanction",
    "C2": r"exchange rate|currency fluctuation|foreign exchange|crude oil|global interest rate",
    "C3": r"inflation|monetary|repo rate|industrial production|gross domestic product",
    "C4": r"regulat|notification|amendment|guideline|licen[cs]",
    "C5": r"sector|technology|industry|production.linked|manufactur|semiconductor|renewable energy|pharmaceutical",
    "C7": r"disruption|cyclone|flood|shutdown|fire|outage|strike",
}
HOSTS = {"rbi.org.in", "www.rbi.org.in", "pib.gov.in", "www.pib.gov.in",
         "www.federalreserve.gov", "www.nseindia.com", "nsearchives.nseindia.com",
         "archives.nseindia.com", "www.bseindia.com", "www.sebi.gov.in", "www.wto.org","www.ecb.europa.eu",
         "mausam.imd.gov.in", "cap-sources.s3.amazonaws.com"}
ERRORS = (httpx.HTTPError, ValueError, OSError, ElementTree.ParseError)


def public_document(url):
    parsed = urlsplit(url)
    if parsed.hostname=="cap-sources.s3.amazonaws.com" and not parsed.path.startswith("/in-imd-en/"):
        return False
    return parsed.scheme == "https" and parsed.hostname in HOSTS and not parsed.username and parsed.port in (None, 443) and bool(parsed.path.strip("/"))


def feed_items(data, cutoff, default):
    results = []
    root = ElementTree.fromstring(data)
    for node in root.iter():
        if node.tag.split("}")[-1] not in ("entry","item"):
            continue
        fields = {child.tag.split("}")[-1]:child for child in node}
        def field(name):
            return (fields[name].text or "").strip() if name in fields else ""
        try:
            stamp = field("pubDate") or field("published") or field("date") or field("updated")
            try:
                date = parsedate_to_datetime(stamp)
            except (ValueError, TypeError):
                date = datetime.fromisoformat(stamp)
            url = field("link") or (fields["link"].get("href","") if "link" in fields else "")
            title = field("title")
            if not date.tzinfo or not cutoff-timedelta(days=90) <= date <= cutoff or not public_document(url):
                continue
            cats = default or tuple(k for k, pat in KEYWORDS.items() if re.search(pat, title, re.I))
            if cats and title:
                results.append(dict(url=url, title=title, as_of=date.isoformat(), categories=cats))
        except (TypeError, ValueError):
            continue
    return sorted(results, key=lambda x:x["as_of"], reverse=True)


def source_id(record):
    digest = hashlib.sha256(json.dumps(record, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return "S" + digest[:20]


def excerpt(data, title):
    if data.startswith(b"%PDF-"):
        try:
            result = subprocess.run(["pdftotext","-f","1","-l","3","-","-"],input=data,
                                    capture_output=True,timeout=3,check=True)
        except (OSError, subprocess.SubprocessError):
            return None
        words = " ".join(result.stdout.decode("utf-8",errors="replace").split())
        return words[:1300] if len(words)>=100 else None
    if b"urn:oasis:names:tc:emergency:cap:" in data[:2000]:
        root = ElementTree.fromstring(data)
        words = " ".join(n.text or "" for n in root.iter() if n.tag.split("}")[-1] in
                         {"headline", "description", "areaDesc", "effective", "expires"})
        return words[:1800] if len(words) >= 100 else None
    if not data or not data.lstrip().startswith(b"<"):
        return None
    try:
        tree = html.fromstring(data)
    except (ValueError, TypeError):
        return None
    for node in tree.xpath("//script|//style|//nav|//header|//footer"):
        node.drop_tree()
    words = " ".join(" ".join(tree.itertext()).split())
    offset = words.casefold().find(title.casefold()[:55])
    if offset < 0:
        return None
    body = words[offset:offset + 1300]
    return body if len(body) >= len(title) + 80 else None


def filings(data, stock, cutoff):
    """Select underlying dated issuer attachments from the exchange's symbol search."""
    try:
        rows = json.loads(data)
    except (ValueError, UnicodeError):
        return []
    result = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or row.get("symbol") != stock["symbol"]:
            continue
        try:
            date = datetime.strptime(row["an_dt"], "%d-%b-%Y %H:%M:%S").replace(tzinfo=INDIA)
            url = row["attchmntFile"]
            if not public_document(url) or not cutoff-timedelta(days=90) <= date <= cutoff:
                continue
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        result.append((stock["listing"], {"kind":"exchange_notice","url":url,"as_of":date.isoformat(),
                       "title":str(row.get("desc") or row.get("attchmntText") or stock["name"])[:280]}))
    return sorted(result, key=lambda item:item[1]["as_of"], reverse=True)[:3]


def bse_announcements(data, stock, code, cutoff):
    """Read attachments published by this exact BSE scrip before decision time."""
    try:
        payload = json.loads(data)
    except (ValueError, UnicodeError):
        return []
    records = []
    rows = payload.get("Table") if isinstance(payload, dict) else None
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or str(row.get("SCRIP_CD")) != code:
            continue
        filename = str(row.get("ATTACHMENTNAME") or "")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+\.pdf", filename, re.I):
            continue
        try:
            stamp = datetime.fromisoformat(str(row.get("DissemDT") or row.get("NEWS_DT")))
        except ValueError:
            continue
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=INDIA)
        if not cutoff-timedelta(days=90) <= stamp <= cutoff:
            continue
        folder = "AttachHis" if str(row.get("OLD")) == "1" else "AttachLive"
        url = f"https://www.bseindia.com/xml-data/corpfiling/{folder}/{filename}"
        records.append((stock["listing"], {"kind":"exchange_notice", "url":url, "as_of":stamp.isoformat(),
                        "title":str(row.get("NEWSSUB") or row.get("HEADLINE") or stock["symbol"])[:280]}))
    return sorted(records, key=lambda item:item[1]["as_of"], reverse=True)[:3]


def fx_observation(data, cutoff):
    observations = []
    for group in ElementTree.fromstring(data).iter():
        if "time" not in group.attrib:
            continue
        try:
            day = datetime.strptime(group.attrib["time"], "%Y-%m-%d").replace(tzinfo=ZoneInfo("Europe/Berlin"))
            # This historical feed gives dates only. Use a completed publication day.
            available = day + timedelta(days=1)
            if not cutoff-timedelta(days=90) <= available <= cutoff:
                continue
            rates = {r.get("currency"):float(r.get("rate")) for r in group}
            usd, inr = rates["USD"], rates["INR"]
            if all(math.isfinite(rate) and rate > 0 for rate in (usd,inr)):
                observations.append((day.date().isoformat(),available.isoformat(),inr/usd))
        except (TypeError, KeyError, ValueError):
            continue
    sample = sorted(observations)[-5:]
    if not sample:
        return None
    body = "ECB reference observations, INR per USD derived from the two EUR reference rates. " + ", ".join(
        f"{day}: {rate:.4f}" for day, _, rate in sample)
    return {"kind":"official_release","url":FX_URL,"as_of":sample[-1][1],"title":"INR per USD reference observations",
            "excerpt":body,"document_hash":hashlib.sha256(body.encode()).hexdigest()}


async def collect(manifest, username, wanted=None, *, previous=None, venue_history=None):

    cutoff = datetime.fromisoformat(manifest["as_of"])
    stocks = [s for s in manifest["stocks"] if wanted is None or s["listing"] in wanted]
    targets = {s["listing"]: list(wanted[s["listing"]] if wanted is not None else CATEGORIES) for s in stocks}
    matrix = {k:{c:[] for c in CATEGORIES} for k in targets}
    docs, notices = {}, set()
    by_key = {s["listing"]:s for s in stocks}
    archived = defaultdict(list)
    history = {key:{} for key in targets}
    gaps = {}
    issuer_ids = defaultdict(list)
    trace = {key:{"identity":"Exchange symbol", "lookup":"Pending", "attachment":"Pending", "excerpt":"Pending"} for key in targets}
    peers = defaultdict(set)
    for key, filings_by_url in (venue_history or {}).get("issuer_filings", {}).items():
        if key in targets:
            for record in filings_by_url.values():
                doc = filing_facts(record, cutoff)
                if doc:
                    sid = source_id(doc)
                    issuer_ids[key].append(sid)
                    docs[sid] = doc
                    if "C6" in targets[key]:
                        matrix[key]["C6"].append(sid)
                    trace[key]["lookup"] = "Saved exchange filing"

    prior = previous or {}
    scopes = ["official:"+cat for cat in CATEGORIES[:-1]] + [threat_archive.scope_for(s) for s in stocks]
    scopes.extend("bars:"+k for k in targets if "C8" in targets[k])
    def add(doc, keys, categories):
        sid = source_id(doc)
        for key in keys:
            if doc["kind"] == "exchange_notice" and sid not in issuer_ids[key]:
                issuer_ids[key].append(sid)
                docs[sid] = doc
            for cat in categories:
                if cat in targets[key] and sid not in matrix[key][cat]:
                    docs[sid] = doc
                    matrix[key][cat].append(sid)
    for key in targets:
        if "C8" in targets[key]:
            days = list(session_calendar(cutoff, key.partition(":")[0], []))[-5:]
            records = (venue_history or {}).get("listings", {}).get(key, [])
            accepted, rejected = technical_sessions(records, key, days, cutoff)
            history[key].update(accepted)
            trace[key]["technical_history"] = f"{len(accepted)}/{len(days)} sessions reused" + "".join(
                f" · {day}: {reason}" for day, reason in rejected.items())
    for scope, item in await threat_archive.load(scopes, cutoff):
        doc = item["doc"]
        kind, key = scope.split(":",1)
        if kind == "bars":
            vintage = doc.get("published_at") or doc.get("received_at")
            if doc.get("volume") is not None and (not vintage or datetime.fromisoformat(vintage) <= cutoff):
                history[key].setdefault(doc["as_of"][:10], doc)
        else:
            add(doc, targets if kind == "official" else [key], item["categories"])
    for key in targets:
        for cat, ids in prior.get("matrix", {}).get(key, {}).items():
            for sid in ids:
                doc = prior["sources"].get(sid)
                if doc:
                    add(doc, [key], [cat])
                    if cat == "C8":
                        history[key].update({r["as_of"][:10]:r for r in doc.get("sessions", [])})
        for sid in prior.get("issuer_sources", {}).get(key, []):
            if sid in prior["sources"]:
                add(prior["sources"][sid], [key], [])
    async with httpx.AsyncClient(timeout=4, follow_redirects=False, headers={"User-Agent":"Cred-X research (https://cred-x.in)"}) as client:
        gate = asyncio.Semaphore(6)
        failures = {}
        price_gate = asyncio.Semaphore(5)
        async def fetch(url, limit, source_client=client, *, lane=None):
            for attempt in range(2):
                try:
                    async with (lane or gate):
                        current = url
                        for _ in range(4):
                            try:
                                return await download(source_client, current, limit)
                            except httpx.HTTPStatusError as exc:
                                if not exc.response.is_redirect:
                                    raise
                                current = urljoin(current, exc.response.headers.get("location", ""))
                                if not public_document(current):
                                    raise ValueError("Unsupported release redirect")
                        raise ValueError("Redirect limit exceeded")
                except ERRORS as exc:
                    failures[url] = f"HTTP {exc.response.status_code}" if isinstance(exc,httpx.HTTPStatusError) else type(exc).__name__
                    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (401, 403, 404, 429):
                        notices.add("Source unavailable: " + urlsplit(url).hostname)
                        break
                    if attempt:
                        notices.add("Source unavailable: " + urlsplit(url).hostname)
            return b""
        async def feed(url, cats):
            if cats and not any(set(cats).intersection(req) for req in targets.values()):
                return []
            try:
                items = feed_items(await fetch(url, 1_000_000), cutoff, cats)
            except ERRORS:
                notices.add("Feed unreadable: " + urlsplit(url).hostname)
                return []
            return items[:8]
        async def currencies():
            if any("C2" in cats for cats in targets.values()):
                try:
                    doc = fx_observation(await fetch(FX_URL, 1_000_000), cutoff)
                except ERRORS:
                    doc = None
                if doc:
                    archived["official:C2"].append({"doc":doc,"categories":["C2"]})
                    add(doc,targets,["C2"])
        async def official():
            async def open_item(item):
                data = await fetch(item["url"], 1_500_000)
                body = await asyncio.to_thread(excerpt,data,item["title"])
                if body:
                    doc = {k:item[k] for k in ("url","title","as_of")}
                    doc.update(kind="official_release", excerpt=body, document_hash=hashlib.sha256(body.encode()).hexdigest())
                    for category in item["categories"]:
                        archived["official:"+category].append({"doc":doc,"categories":[category]})
                    add(doc, targets, item["categories"])
                else:
                    notices.add("Underlying release unavailable: " + item["url"])
            async def process_feed(url, cats):
                items = await feed(url, cats)
                unique = {item["url"]:item for item in items if any(set(item["categories"]).intersection(req) for req in targets.values())}
                await asyncio.gather(*(open_item(item) for item in unique.values()))
            await asyncio.gather(*(process_feed(url, cats) for url, cats in FEEDS.items()))
        async def listed():
            attachments = {}
            async def announcements(venue, url):
                relevant = [s for s in stocks if s["exchange"]==venue and set(targets[s["listing"]])-{"C8"}]
                if not relevant:
                    return
                try:
                    records = indian_news(await fetch(url,1_500_000),venue,relevant,cutoff)
                except ERRORS:
                    notices.add("Announcement feed unavailable: "+venue)
                    return
                candidates = {}
                for key,record in records:
                    if public_document(record["url"]) and cutoff-timedelta(days=90) <= datetime.fromisoformat(record["as_of"]) <= cutoff:
                        entry = candidates.setdefault(record["url"],(record,set()))
                        entry[1].add(key)
                await asyncio.gather(*(filing(rec,keys) for rec,keys in list(candidates.values())[:48]))
            # The latest announcement stream can omit an issuer altogether on a quiet day.
            async def lookup(stock):
                params = {"index":"equities","symbol":stock["symbol"],
                          "from_date":(cutoff-timedelta(days=90)).strftime("%d-%m-%Y"),"to_date":cutoff.strftime("%d-%m-%Y")}
                url = "https://www.nseindia.com/api/corporate-announcements?"+urlencode(params)
                # Consume each issuer as soon as its index returns, before slower issuers time out.
                raw = await fetch(url, 2_000_000)
                records = filings(raw, stock, cutoff)
                trace[stock["listing"]]["lookup"] = "Dated filing located" if records else "No dated filing returned" if raw else "Issuer index unavailable · "+failures.get(url,"empty response")
                for key, rec in records:
                    await filing(rec,{key})
            async def read_attachment(record):
                data = await fetch(record["url"],2_500_000)
                body = await asyncio.to_thread(excerpt, data, record["title"])
                fingerprint = hashlib.sha256(data).hexdigest()
                if body:
                    await asyncio.to_thread(threat_archive.store_attachment, data, fingerprint)
                return body, fingerprint, bool(data)
            async def filing(record,keys):
                key = (record["url"], record["title"])
                if key not in attachments:
                    attachments[key] = asyncio.create_task(read_attachment(record))
                for listing in keys:
                    trace[listing]["lookup"] = "Dated filing located"
                body, fingerprint, downloaded = await attachments[key]
                for listing in keys:
                    trace[listing]["attachment"] = "Downloaded" if downloaded else "Download failed · "+failures.get(record["url"],"empty response")
                    trace[listing]["excerpt"] = "Extracted" if body else "Unreadable" if downloaded else "Pending"
                if not body:
                    notices.add("Underlying issuer document unavailable: "+record["url"])
                    return
                recipients = set(keys)
                for listing in keys:
                    recipients.update(peers[listing])
                cats = ["C6"] + [c for c,p in KEYWORDS.items() if re.search(p,record["title"]+" "+body,re.I)]
                doc = {**record,"excerpt":body,"document_hash":fingerprint}
                for k in recipients:
                    archived[threat_archive.scope_for(by_key[k])].append({"doc":doc,"categories":cats})
                add(doc,recipients,cats)
            async def recent():
                await asyncio.gather(announcements("NSE",NSE_NEWS),announcements("BSE",BSE_NEWS))
            async def dated():
                await asyncio.gather(*(lookup(s) for s in stocks if s["exchange"]=="NSE"
                                       and set(targets[s["listing"]])-{"C8"} and not issuer_ids[s["listing"]]))
            async def dated_bse():
                if not any(set(categories) - {"C8"} for categories in targets.values()):
                    return
                try:
                    master = await technical_instruments(client)
                except ERRORS + (RuntimeError,):
                    notices.add("BSE issuer identifiers unavailable")
                    return
                issuers = defaultdict(set)
                bse_codes = defaultdict(set)
                for key, meta in master.items():
                    isin = meta.get("isin")
                    if not re.fullmatch(r"IN[A-Z0-9]{10}", isin or ""):
                        continue
                    if key in targets:
                        issuers[isin].add(key)
                        trace[key]["identity"] = isin
                    if key.startswith("BSE:") and meta.get("exchange_token"):
                        bse_codes[isin].add(meta["exchange_token"])
                for group in issuers.values():
                    for key in group:
                        peers[key].update(group)
                for isin, group in issuers.items():
                    document = primary_filing(isin, cutoff)
                    if document:
                        add(document, group, ["C6"])
                for scope, entry in await threat_archive.load(["isin:"+isin for isin in issuers], cutoff):
                    add(entry["doc"], issuers[scope.removeprefix("isin:")], entry["categories"])
                async def alternate(code, recipients):
                    stock = by_key[sorted(recipients)[0]]
                    raw = await fetch("https://www.screener.in/company/"+quote(stock["symbol"], safe="")+"/", 1_500_000, lane=index_gate)
                    records = indexed_filings(raw, code, cutoff)
                    for record in records:
                        await filing(record, recipients)
                index_gate = asyncio.Semaphore(3)
                async def by_scrip(stock, bse_client):
                    codes = bse_codes.get(master.get(stock["listing"], {}).get("isin"), set())
                    code = next(iter(codes)) if len(codes)==1 else ""
                    if not re.fullmatch(r"\d{6}", code):
                        notices.add("BSE issuer identifier unavailable for "+stock["listing"])
                        return
                    params = {"pageno":1, "strCat":-1, "subcategory":-1, "strSearch":"P", "strType":"C",
                              "strScrip":code, "strPrevDate":(cutoff-timedelta(days=90)).astimezone(INDIA).strftime("%Y%m%d"),
                              "strToDate":cutoff.astimezone(INDIA).strftime("%Y%m%d")}
                    url = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?"+urlencode(params)
                    raw = await fetch(url, 2_000_000, bse_client)
                    records = bse_announcements(raw, stock, code, cutoff)
                    trace[stock["listing"]]["bse_lookup"] = "Dated filing located" if records else "No matching dated filing" if raw else "BSE index unavailable · "+failures.get(url,"empty response")
                    for key, rec in records:
                        await filing(rec, {key})
                headers = {"Referer":"https://www.bseindia.com/", "Origin":"https://www.bseindia.com"}
                async with httpx.AsyncClient(timeout=4, headers=headers) as bse_client:
                    searches = []
                    for isin, group in issuers.items():
                        if not any(set(targets[k]) - {"C8"} for k in group):
                            continue
                        stock = by_key[sorted(group)[0]]
                        searches.append(by_scrip(stock, bse_client))
                        codes = bse_codes[isin]
                        if len(codes) == 1 and re.fullmatch(r"\d{6}", str(next(iter(codes)))):
                            searches.append(alternate(str(next(iter(codes))), group))
                    await asyncio.gather(*searches)
            await asyncio.gather(recent(), dated(), dated_bse())
        async def bars():
            found = history
            async def day(venue, date, close, keys):
                keys = {k for k in keys if date not in found[k]}
                if not keys:
                    return
                url = archive_url(venue,date)
                try:
                    rows = await asyncio.to_thread(extract_archive, await fetch(url,6_000_000,lane=price_gate),venue,date,close,keys,url)
                    for key, values in rows.items():
                        if len(values)==1 and values[0].get("volume") is not None:
                            found[key][date] = values[0]
                except (OSError, ValueError, zipfile.BadZipFile):
                    pass
                remaining = {k for k in keys if date not in found[k]}
                if remaining and venue == "NSE":
                    day_value = datetime.fromisoformat(date).date()
                    alt = f"https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{day_value:%d%m%Y}.csv"
                    lookup = {(venue,k.split(":",1)[1]):k for k in remaining}
                    raw = await fetch(alt,6_000_000,lane=price_gate)
                    for key, item in indian_bars(raw,venue,day_value,lookup,alt,cutoff):
                        found[key][date] = item
            tasks=[]
            for venue in sorted({s["exchange"] for s in stocks}):
                keys = {s["listing"] for s in stocks if s["exchange"]==venue and "C8" in targets[s["listing"]]}
                if keys:
                    tasks.extend(day(venue, date, close, keys) for date,close in list(session_calendar(cutoff,venue,[]).items())[-5:])
            await asyncio.gather(*tasks)
            from app.domains.zerodha.upstox_quotes import configured_for
            needed = {k:list(session_calendar(cutoff,k.split(":")[0],[]))[-5:] for k in targets if "C8" in targets[k]}
            missing = {k:[] for k,days in needed.items() if set(days)-found[k].keys()}
            if missing and configured_for(manifest["owner_id"],username):
                messages=[]
                try:
                    await supplement_indian_bars(client,missing,cutoff,messages,manifest["owner_id"],diagnostics=gaps, calendars={v:session_calendar(cutoff,v,[],5) for v in ("NSE","BSE")})
                except (httpx.HTTPError,OSError,ValueError,RuntimeError,RedisError):
                    messages.append("Broker history unavailable")
                notices.update(messages)
                for key,items in missing.items():
                    fallback = {r["as_of"][:10]:r for r in items if r["kind"]=="daily_bar"}
                    days = list(session_calendar(cutoff,key.split(":")[0],[]))[-5:]
                    found[key].update({d:fallback[d] for d in days if d in fallback and d not in found[key]})
            return found
        async def bounded(task, seconds, reason):
            try:
                await asyncio.wait_for(task, seconds)
            except TimeoutError:
                notices.add(reason)
        await asyncio.gather(bounded(bars(),60,"Price history recovery deadline"),
                             bounded(listed(),46,"Issuer filing recovery deadline"),
                             bounded(asyncio.gather(official(),currencies()),35,"Official release deadline"))
    for key, group in peers.items():
        for peer in group - {key}:
            for sid in list(issuer_ids[peer]):
                cats = [cat for cat, ids in matrix[peer].items() if sid in ids]
                add(docs[sid], [key], cats)
    for stock in stocks:
        key = stock["listing"]
        if "C8" not in targets[key]:
            continue
        days = list(session_calendar(cutoff,stock["exchange"],[]))[-5:]
        series = history.get(key,{})
        archived["bars:"+key].extend({"doc":series[d]} for d in days if d in series)
        if len(days)==5 and all(d in series for d in days):
            gaps.pop(key, None)
            ordered = [series[d] for d in days]
            add({"kind":"venue_sessions","listing":key,"title":"Five completed sessions","as_of":ordered[-1]["as_of"],
                 "url":ordered[-1]["url"],"sessions":ordered}, [key], ["C8"])
        else:
            gap = gaps.setdefault(key, {"reason":"Collection deadline" if "Price history recovery deadline" in notices
                                        else "Missing completed venue sessions"})
            gap["missing_sessions"] = [d for d in days if d not in series]
    # Keep the model request bounded even when the rolling archive is full.
    def recent(ids, limit):
        return sorted(set(ids), key=lambda sid:(docs[sid]["as_of"],sid), reverse=True)[:limit]
    retained = set()
    for key,categories in matrix.items():
        issuer_ids[key] = recent(issuer_ids[key],3)
        retained.update(issuer_ids[key])
        if issuer_ids[key]:
            isin = trace[key]["identity"]
            if re.fullmatch(r"IN[A-Z0-9]{10}", isin):
                for sid in issuer_ids[key]:
                    cats = [cat for cat, ids in categories.items() if sid in ids]
                    archived["isin:"+isin].append({"doc":docs[sid],"categories":cats})
            doc = docs[issuer_ids[key][0]]
            trace[key].update(lookup="Dated filing located",attachment="Available",excerpt="Extracted",
                              url=doc["url"],as_of=doc["as_of"],text=doc["excerpt"])
        elif trace[key]["lookup"] == "Pending":
            trace[key]["lookup"] = "Issuer collection deadline" if "Issuer filing recovery deadline" in notices else "No dated issuer filing"

        for cat, ids in categories.items():
            issuer = [sid for sid in ids if docs[sid]["kind"]=="exchange_notice"]
            categories[cat] = list(dict.fromkeys(recent(issuer,1)+recent(ids,3)))[:3]
            retained.update(categories[cat])
    await threat_archive.save(archived)
    docs = {sid:docs[sid] for sid in sorted(retained)}
    return {"threat_version":2,"exposure_required":True,"issuer_sources":dict(issuer_ids),
            "issuer_trace":trace,"history_gaps":gaps,"sources":docs,"matrix":matrix,"targets":targets,"notices":sorted(notices)}
