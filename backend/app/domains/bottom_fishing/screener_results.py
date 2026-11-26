"""Capture the original Screener query results independently of technical discovery."""
import re
from urllib.parse import unquote

import httpx
from lxml import etree, html

RESULTS = "https://www.screener.in/screen/raw/"


def read_page(content):
    doc = html.document_fromstring(content)
    body = " ".join(doc.xpath("//body//text()"))
    count = re.search(r"([\d,]+)\s+results? found", body, re.I)
    if not count:
        raise ValueError("Screener did not return a query-results page.")
    rows = []
    for tr in doc.xpath("//table//tr[td]"):
        links = tr.xpath(".//a[starts-with(@href,'/company/')]")
        if not links:
            continue
        link = links[0]
        symbol = unquote(link.get("href").split("/")[2])
        rows.append(dict(symbol=symbol, name=link.text_content().strip()))
    return int(count[1].replace(",", "")), rows


async def original_results(client, settings, at):
    report = dict(at=at.isoformat(), rows=[], complete=False)
    params = {"query":settings["screen_query"]}
    if settings.get("latest_results"):
        params["latest"] = "on"
    seen = set()
    try:
        while True:
            response = await client.get(RESULTS, params=params)
            response.raise_for_status()
            count, rows = read_page(response.content)
            if report.setdefault("total", count) != count:
                raise ValueError("Screener's result count changed during pagination.")
            for row in rows:
                if row["symbol"] in seen:
                    raise ValueError("Screener repeated a result during pagination.")
                seen.add(row["symbol"])
                report["rows"].append(row)
            if len(seen) == count:
                report["complete"] = True
                break
            if not rows or len(seen) > count:
                raise ValueError("Screener returned an incomplete result list.")
            params["page"] = params.get("page", 1) + 1
    except (ValueError, etree.ParserError, httpx.HTTPError) as exc:
        report["error"] = str(exc) if isinstance(exc, ValueError) else f"Screener request failed ({type(exc).__name__})."
    return report
