"""Frozen, category-scoped evidence for the Indian 90-day Threats assessment."""
import asyncio
import hashlib
import json
import re
import subprocess
import zipfile
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit
from xml.etree import ElementTree

import httpx
from lxml import html

from .research import BSE_NEWS, NSE_NEWS, download, indian_news, supplement_indian_bars
from redis.exceptions import RedisError
from .technical_sources import archive_url, extract_archive, session_calendar

FEEDS = {
    "https://rbi.org.in/pressreleases_rss.xml": ("C3",),
    "https://rbi.org.in/notifications_rss.xml": ("C4",),
    "https://www.federalreserve.gov/feeds/press_monetary.xml": ("C2",),
    "https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=1": (),
}
CATEGORIES = tuple(f"C{i}" for i in range(1, 9))
KEYWORDS = {
    "C1": r"tariff|trade agreement|export restriction|import duty|sanction",
    "C3": r"inflation|monetary|repo rate|industrial production|gross domestic product",
    "C4": r"regulat|notification|amendment|guideline|licen[cs]",
    "C5": r"sector|technology|industry|production.linked|manufactur",
    "C7": r"disruption|cyclone|flood|shutdown|fire|outage|strike",
}
HOSTS = {"rbi.org.in", "www.rbi.org.in", "pib.gov.in", "www.pib.gov.in",
         "www.federalreserve.gov", "www.nseindia.com", "nsearchives.nseindia.com",
         "archives.nseindia.com", "www.bseindia.com"}
ERRORS = (httpx.HTTPError, ValueError, OSError, ElementTree.ParseError)


def public_document(url):
    parsed = urlsplit(url)
    return parsed.scheme == "https" and parsed.hostname in HOSTS and not parsed.username and parsed.port in (None, 443) and bool(parsed.path.strip("/"))


def feed_items(data, cutoff, default):
    results = []
    for node in ElementTree.fromstring(data).iter("item"):
        try:
            date = parsedate_to_datetime(node.findtext("pubDate") or "")
            url = (node.findtext("link") or "").strip()
            title = (node.findtext("title") or "").strip()
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


async def collect(manifest, username, wanted=None):
    cutoff = datetime.fromisoformat(manifest["as_of"])
    stocks = [s for s in manifest["stocks"] if wanted is None or s["listing"] in wanted]
    targets = {s["listing"]: list(wanted[s["listing"]] if wanted is not None else CATEGORIES) for s in stocks}
    matrix = {k:{c:[] for c in CATEGORIES} for k in targets}
    docs, notices = {}, set()
    def add(doc, keys, categories):
        sid = source_id(doc)
        for key in keys:
            for cat in categories:
                if cat in targets[key] and sid not in matrix[key][cat]:
                    docs[sid] = doc
                    matrix[key][cat].append(sid)
    async with httpx.AsyncClient(timeout=4, follow_redirects=False, headers={"User-Agent":"Cred-X research (https://cred-x.in)"}) as client:
        gate = asyncio.Semaphore(6)
        async def fetch(url, limit):
            for attempt in range(2):
                try:
                    async with gate:
                        return await download(client, url, limit)
                except ERRORS:
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
            return items[:5]
        async def official():
            groups = await asyncio.gather(*(feed(url, cats) for url, cats in FEEDS.items()))
            unique = {item["url"]:item for group in groups for item in group if any(set(item["categories"]).intersection(req) for req in targets.values())}
            async def open_item(item):
                data = await fetch(item["url"], 1_500_000)
                body = await asyncio.to_thread(excerpt,data,item["title"])
                if body:
                    doc = {k:item[k] for k in ("url","title","as_of")}
                    add({**doc, "kind":"official_release", "excerpt":body,"document_hash":hashlib.sha256(body.encode()).hexdigest()}, targets, item["categories"])
                else:
                    notices.add("Underlying release unavailable: " + item["url"])
            await asyncio.gather(*(open_item(item) for item in unique.values()))
        async def listed():
            candidates = {}
            stock_map = {s["listing"]:s for s in stocks}
            async def announcements(venue, url):
                relevant = [s for s in stocks if s["exchange"]==venue and set(targets[s["listing"]])-{"C8"}]
                if not relevant:
                    return
                try:
                    records = indian_news(await fetch(url,1_500_000),venue,relevant,cutoff)
                except ERRORS:
                    notices.add("Announcement feed unavailable: "+venue)
                    return
                for key,record in records:
                    if public_document(record["url"]) and cutoff-timedelta(days=90) <= datetime.fromisoformat(record["as_of"]) <= cutoff:
                        entry = candidates.setdefault(record["url"],(record,set()))
                        entry[1].add(key)
            await asyncio.gather(announcements("NSE",NSE_NEWS),announcements("BSE",BSE_NEWS))
            async def filing(record,keys):
                data = await fetch(record["url"],2_500_000)
                body = await asyncio.to_thread(excerpt,data,record["title"])
                if not body:
                    notices.add("Underlying issuer document unavailable: "+record["url"])
                    return
                peers = set(keys)
                for key in keys:
                    stock = stock_map[key]
                    name = stock.get("name","").strip().casefold()
                    peers.update(s["listing"] for s in stocks if name and name != stock["symbol"].casefold()
                                 and s.get("name","").strip().casefold()==name and s["symbol"]==stock["symbol"])
                cats = ["C6"] + [c for c,p in KEYWORDS.items() if re.search(p,record["title"]+" "+body,re.I)]
                add({**record,"excerpt":body,"document_hash":hashlib.sha256(data).hexdigest()},peers,cats)
            await asyncio.gather(*(filing(rec,keys) for rec,keys in sorted(candidates.values(),
                                  key=lambda item:item[0]["as_of"],reverse=True)[:32]))
        async def bars():
            found = {key:{} for key in targets}
            async def day(venue, date, close, keys):
                url = archive_url(venue,date)
                try:
                    rows = extract_archive(await fetch(url,6_000_000),venue,date,close,keys,url)
                    for key, values in rows.items():
                        if len(values)==1:
                            found[key][date] = values[0]
                except (OSError, ValueError, zipfile.BadZipFile):
                    pass
            tasks=[]
            for venue in sorted({s["exchange"] for s in stocks}):
                keys = {s["listing"] for s in stocks if s["exchange"]==venue and "C8" in targets[s["listing"]]}
                if keys:
                    tasks.extend(day(venue, date, close, keys) for date,close in list(session_calendar(cutoff,venue,[]).items())[-5:])
            await asyncio.gather(*tasks)
            from app.domains.zerodha.upstox_quotes import configured_for
            missing = {k:[] for k,items in found.items() if len(items)<5 and "C8" in targets[k]}
            if missing and configured_for(manifest["owner_id"],username):
                messages=[]
                try:
                    await supplement_indian_bars(client,missing,cutoff,messages,manifest["owner_id"])
                except (httpx.HTTPError,OSError,ValueError,RuntimeError,RedisError):
                    messages.append("Broker history unavailable")
                notices.update(messages)
                for key,items in missing.items():
                    fallback = {r["as_of"][:10]:r for r in items if r["kind"]=="daily_bar"}
                    days = list(session_calendar(cutoff,key.split(":")[0],[]))[-5:]
                    if len(days)==5 and all(d in fallback for d in days):
                        found[key]=fallback
            return found
        releases = asyncio.create_task(official())
        archives = asyncio.create_task(bars())
        listings = asyncio.create_task(listed())
        try:
            await asyncio.wait_for(asyncio.gather(releases,archives,listings), timeout=46)
        except TimeoutError:
            notices.add("Threat research deadline reached")
        history = archives.result() if archives.done() and not archives.cancelled() else {}
    for stock in stocks:
        key = stock["listing"]
        if "C8" not in targets[key]:
            continue
        days = list(session_calendar(cutoff,stock["exchange"],[]))[-5:]
        series = history.get(key,{})
        if len(days)==5 and all(d in series for d in days):
            ordered = [series[d] for d in days]
            add({"kind":"venue_sessions","listing":key,"title":"Five completed sessions","as_of":ordered[-1]["as_of"],
                 "url":ordered[-1]["url"],"sessions":ordered}, [key], ["C8"])
    return {"threat_version":2,"sources":docs,"matrix":matrix,"targets":targets,"notices":sorted(notices)}
