"""Named Screener ratios from an issuer's public industry results table."""
import json
import re
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
from lxml import html

from app.domains.scorecards.research import download
from .column_facts import dated, number, period_shift, sheet

PE = "Industry PE"
PAT = "Profit after tax preceding year quarter"
METRICS = (PE, PAT)
SALES = "Sales latest quarter"
PROFIT = "Net Profit latest quarter"
INDUSTRY = re.compile(r"/market/(?:IN[A-Z0-9]+/){1,6}")


def source(root):
    company = root.xpath('string(//*[@id="company-info"]/@data-company-id)')
    path = root.xpath('string(//section[@id="peers"]//a[@title="Industry"]/@href)')
    if company.isdigit() and INDUSTRY.fullmatch(path):
        return {"id": company, "industry": path}
    return {}


def parse_page(content, metric, current):
    root = html.fromstring(content)
    tables = root.xpath('//table[.//th[@data-tooltip=$metric]]', metric=metric)
    if len(tables) != 1:
        raise ValueError("Screener ratio column missing")
    table = tables[0]
    headers = table.xpath('(.//tr[th[@data-tooltip]])[1]/th')
    cols = {h.get("data-tooltip"): i for i, h in enumerate(headers)}
    rows = {}
    for row in table.xpath('.//tr[@data-row-company-id]'):
        cells = row.xpath('./td')
        if len(cells) == len(headers):
            result = {
                key: number(cells[cols[key]].text_content()) for key in (metric, SALES, PROFIT) if key in cols
            }
            href = row.xpath('string(./td/a[starts-with(@href,"/company/")]/@href)')
            if re.fullmatch(r"/company/[A-Za-z0-9&_.%-]+/(?:consolidated/)?", href):
                result["company_path"] = href
            rows[row.get("data-row-company-id")] = result
    more = any(str(current+1) in parse_qs(urlsplit(href).query).get("page", [])
               for href in root.xpath('//a[contains(@href,"page=")]/@href'))
    return {"rows": rows, "more": more}


async def lookup(client, cache, fields, metric, session):
    ref = fields.get("screen_source") or {}
    if not ref.get("id") or not INDUSTRY.fullmatch(ref.get("industry", "")):
        return {}, fields.get("quarter")
    quarter = fields.get("quarter")
    schedule_error = None
    if metric == PAT and quarter:
        url = f"https://www.screener.in/api/company/{ref['id']}/schedules/?parent=Net+Profit&section=quarters&consolidated="
        try:
            data = json.loads(await download(client, url))
            target = period_shift(quarter, -12)
            for name in ("Profit after tax", "Profit After Tax"):
                value = number(data.get(name, {}).get(target))
                if value is not None:
                    return {PAT: value}, quarter
        except (httpx.HTTPError, ValueError) as exc:
            schedule_error = exc
    page = 1
    while True:
        key = f"bottom:ratio-table:v1:{session}:{ref['industry']}:{metric}:{page}"
        cached = await cache.get(key)
        if cached:
            result = json.loads(cached)
        else:
            params = {"sort": metric.lower()}
            if page > 1:
                params["page"] = page
            url = "https://www.screener.in" + ref["industry"] + "?" + urlencode(params)
            result = parse_page(await download(client, url), metric, page)
            await cache.set(key, json.dumps(result), ex=86400)
        row = result["rows"].get(ref["id"])
        if row is not None:
            value = row.get(metric)
            if metric == PAT:
                # Industry results may select standalone accounts. Check both current-
                # quarter figures against the issuer statement (rounded to crore).
                display = fields.get("display", {})
                if not fields.get("quarter") or any(
                    row.get(k) is None or display.get(k) is None or abs(row[k]-display[k]) > 0.51
                    for k in (SALES, PROFIT)
                ):
                    path = row.get("company_path")
                    if value is None or not path:
                        value = None
                    else:
                        # Screener can switch the default listing to standalone after
                        # a subsidiary merger. Date and identify that observation.
                        detail = html.fromstring(await download(client, "https://www.screener.in" + path))
                        if detail.xpath('string(//*[@id="company-info"]/@data-company-id)') != ref["id"]:
                            raise ValueError("Screener statement identity changed")
                        table = sheet(detail, "quarters")
                        dates = dated(table)
                        sales = table.get("Sales") or table.get("Revenue") or {}
                        profit = table.get("Net Profit", {})
                        if dates and all(v is not None and row.get(k) is not None and abs(row[k]-v) <= 0.51
                                         for k, v in ((SALES, sales.get(dates[0])), (PROFIT, profit.get(dates[0])))):
                            basis = "consolidated" if detail.xpath('//*[@id="company-info"]/@data-consolidated') else "standalone"
                            return {metric: value}, {"period": period_shift(dates[0], -12), "basis": basis}
                        value = None
            if value is None and schedule_error is not None:
                raise schedule_error
            return ({metric: value} if value is not None else {}), fields.get("quarter")
        if not result["more"]:
            if schedule_error is not None:
                raise schedule_error
            return {}, fields.get("quarter")
        page += 1
