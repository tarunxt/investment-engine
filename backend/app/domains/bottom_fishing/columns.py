"""Column preferences and session-dated observations for confirmed screen matches."""
import asyncio
import csv
import io
import json
import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import mean
from urllib.parse import quote

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator
from .column_facts import number, ratio
from .issuer import issuer

CATALOG = json.loads(Path(__file__).with_name("column_catalog.json").read_text())
NAMES = {entry[0] for entry in CATALOG}
DEFAULT = ["Price to Earning","Industry PE","Market Capitalization","Net Profit latest quarter",
           "YOY Quarterly profit growth","Sales latest quarter","YOY Quarterly sales growth",
           "Return on capital employed","Profit after tax preceding year quarter","Volume 1month average",
           "Volume 1week average","Volume 1year average","CMP by 200 DMA"]
PREF = "bottom_fishing.columns.v1"
IMPORT = "bottom_fishing.csv."


class Selection(BaseModel):
    names: list[str] = Field(max_length=len(NAMES))
    version: int = Field(ge=0)

    @model_validator(mode="after")
    def valid(self):
        if len(self.names) != len(set(self.names)) or set(self.names) - NAMES:
            raise ValueError("Choose distinct columns from the catalog.")
        return self


class Export(BaseModel):
    session: date
    text: str = Field(min_length=1, max_length=2_000_000)


def read_export(text, rows):
    def norm(value):
        return " ".join((value or "").lstrip("\ufeff").casefold().strip().split())
    names = {norm(n):n for n in NAMES}
    short = {}
    for name, _, _, label in CATALOG:
        key = norm(label)
        short[key] = name if key not in short else None
    reader = csv.DictReader(io.StringIO(text))
    headers = reader.fieldnames or []
    def mapped_name(header):
        key=norm(header)
        stripped=re.sub(r"\s*(?:\(?(?:rs\.?\s*cr\.?|rs\.?|%|cr\.?)\)?)$", "", key).strip()
        return names.get(key) or short.get(key) or names.get(stripped) or short.get(stripped)
    mapped = {h:mapped_name(h) for h in headers}
    if not any(mapped.values()):
        raise HTTPException(422,"The CSV has no recognized financial columns. Use full ratio names or Screener column labels.")
    index = {}
    for row in rows:
        venue = row.get("exchange","NSE")
        key = venue+":"+row["symbol"]
        for field, value in ((venue, row["symbol"]),("isin",row.get("isin")),("name",row.get("name")),
                             ("BSE",row.get("exchange_token") if venue=="BSE" else None)):
            if value:
                index.setdefault((field,norm(value)),set()).add(key)
    result = {}
    for raw in reader:
        ids = {norm(h):v for h,v in raw.items() if h}
        hits = []
        for label,field in (("isin","isin"),("nse code","NSE"),("bse code","BSE"),("name","name"),("company name","name")):
            if ids.get(label):
                keys=index.get((field,norm(ids[label])),set())
                if keys:
                    hits.append(keys)
        match=set.intersection(*hits) if hits else set()
        if len(match)!=1:
            continue
        key=next(iter(match))
        values={name:n for h,name in mapped.items() if name and (n:=number(raw.get(h))) is not None}
        if values:
            if key in result:
                raise HTTPException(422,"Duplicate company in this export.")
            result[key]=values
    if not result:
        raise HTTPException(422,"No numeric cells matched a company in the current screen. Include Name, ISIN, NSE Code or BSE Code.")
    return result


async def price_facts(client, cache, guard, instrument, stamp, calendar):
    end = max(day for day,close in calendar.items() if day < stamp.date().isoformat() or
              day == stamp.date().isoformat() and close and datetime.fromisoformat(close)<=stamp)
    key = f"bottom:display:prices:{instrument}:{end}"
    raw = await cache.get(key)
    if raw:
        return json.loads(raw)
    if not await guard.admit():
        return {}
    first=(date.fromisoformat(end)-timedelta(days=380)).isoformat()
    url=f"https://api.upstox.com/v3/historical-candle/{quote(instrument,safe='')}/days/1/{end}/{first}"
    response=await client.get(url,headers={"Authorization":"Bearer "+os.environ["UPSTOX_ANALYTICS_TOKEN"]})
    if response.status_code==429:
        await guard.backoff(response.headers.get("Retry-After"))
    response.raise_for_status()
    days={}
    for t, _, _, _, close, volume, *_ in response.json()["data"]["candles"]:
        day=datetime.fromisoformat(t).date().isoformat()
        if first<=day<=end and number(close) is not None and close>0 and number(volume) is not None and volume>=0:
            days[day]=(close,volume)
    ordered=sorted(days)
    if not ordered or ordered[-1]!=end:
        return {}
    closes=[days[d][0] for d in ordered]
    data={"Volume":days[end][1]}
    for n in (50,200):
        if len(closes)>=n:
            data[f"DMA {n}"]=mean(closes[-n:])
        if len(closes)>n:
            data[f"DMA {n} previous day"]=mean(closes[-n-1:-1])
    for span, label in ((7,"1week"),(30,"1month"),(365,"1year")):
        start=(date.fromisoformat(end)-timedelta(days=span)).isoformat()
        if ordered[0]<=start:
            data[f"Volume {label} average"]=mean(days[d][1] for d in ordered if d>start)
    await cache.set(key,json.dumps(data),ex=86400)
    return data


async def enrich(client, cache, guard, instruments, settings, stamp, calendar, report):
    gate = asyncio.Semaphore(5)
    canonical = {n.casefold():n for n in NAMES}
    async def one(row):
        key=row["exchange"]+":"+row["symbol"]
        dest=row.setdefault("columns",{})
        async with gate:
            try:
                identity = "BSE:"+row["exchange_token"] if row["exchange"]=="BSE" else key
                fields,_ = await issuer(client,cache,identity)
                dest.update({canonical[k.casefold()]:v for k,v in fields.get("display",{}).items() if k.casefold() in canonical and k!="Current price"})
            except (httpx.HTTPError, ValueError, IndexError, KeyError):
                pass
            try:
                prices=await price_facts(client,cache,guard,instruments[key],stamp,calendar)
                dest.update(prices)
                cmp_dma=ratio(dest.get("Current price"),prices.get("DMA 200"))
                if cmp_dma is not None:
                    dest["CMP by 200 DMA"]=cmp_dma
            except (httpx.HTTPError, ValueError, IndexError, KeyError):
                pass
    try:
        async with asyncio.timeout(18):
            await asyncio.gather(*(one(row) for row in report["rows"]))
    except TimeoutError:
        pass
    report["column_names"] = settings.get("column_names",DEFAULT)
    report["column_schema"] = 1
