"""Consolidated company observations shared by the screen and the scorecard."""
import json
import math
from datetime import datetime
from urllib.parse import quote

from lxml import html
from . import screen_ratios
from .column_facts import statement_columns
from app.domains.scorecards.research import INDIA, download


def verify_issuer(root, symbol):
    # Preserve identity on redirects and never mix consolidated and standalone columns.
    if not any(('/'+symbol+'/') in href or href.rstrip('/').endswith('/'+symbol)
               or href.split('symbol=')[-1].split('&')[0]==symbol for href in root.xpath('//a/@href')):
        raise ValueError("Issuer identity unavailable")


def financials(data, symbol):
    root = html.fromstring(data)
    verify_issuer(root,symbol)
    return score_financials(root)


def score_financials(root):
    def series(section, label):
        tables = root.xpath(f'//section[@id="{section}"]//table')
        if not tables:
            return {}
        dates = [c.text_content().strip() for c in tables[0].xpath('.//thead/tr[last()]/th')][1:]
        for row in tables[0].xpath('.//tbody/tr'):
            cells = row.xpath('./td')
            if not cells or ' '.join(cells[0].text_content().replace('+','').split()) != label:
                continue
            values = {}
            for period, cell in zip(dates, cells[1:]):
                try:
                    datetime.strptime(period, '%b %Y')
                    value = float(cell.text_content().replace(',','').replace('%','').strip())
                    if math.isfinite(value):
                        values[period] = value
                except ValueError:
                    continue
            return values
        return {}

    def latest(values):
        return max(values, key=lambda d:datetime.strptime(d,'%b %Y'), default=None)

    sales = series("quarters","Sales") or series("quarters","Revenue")
    profit = series("quarters","Net Profit")
    period = latest(sales.keys() | profit.keys())
    if not period:
        raise ValueError("Latest quarter unavailable")
    date = datetime.strptime(period,'%b %Y')
    prior = date.replace(year=date.year-1).strftime('%b %Y')
    facts = dict(quarter=period)
    for key, values in (("sales", sales), ("profit", profit)):
        if period in values and values.get(prior, 0) > 0:
            facts[key] = 100*(values[period]/values[prior]-1)
    debt, capital, reserves = (series("balance-sheet",k) for k in ("Borrowings","Equity Capital","Reserves"))
    balance = latest(debt.keys() | capital.keys() | reserves.keys())
    if balance in debt and balance in capital and balance in reserves:
        equity = capital[balance]+reserves[balance]
        if equity > 0:
            facts.update(balance=balance, leverage=debt[balance]/equity)
    roce = series("ratios","ROCE %")
    if roce:
        facts.update(roce_period=latest(roce), roce=roce[latest(roce)])
    return facts


def issuer_fields(root):
    """Read published consolidated figures independently of scorecard eligibility."""
    values = {}
    def number(text):
        try:
            n = float(text.strip().replace(",","").replace("%",""))
            return n if math.isfinite(n) else None
        except ValueError:
            return None

    for item in root.xpath('//ul[@id="top-ratios"]/li'):
        names = item.xpath('./span[@class="name"]')
        numbers = [number(n.text_content()) for n in item.xpath('.//span[@class="number"]')]
        if names and numbers:
            label = names[0].text_content().strip()
            if label=="Market Cap":
                values["cap"] = numbers[0]
            elif label=="ROCE":
                values["roce"] = numbers[0]
            elif label=="High / Low" and len(numbers)==2:
                values["high_52w"], values["low_52w"] = numbers

    def series(section,label):
        dates = root.xpath('//section[@id=$id]//table//thead/tr[last()]/th', id=section)[1:]
        for row in root.xpath('//section[@id=$id]//table//tbody/tr',id=section):
            cells = row.xpath('./td')
            if cells and " ".join(cells[0].text_content().replace("+","").split())==label:
                return {d.text_content().strip():number(c.text_content()) for d,c in zip(dates,cells[1:])}
        return {}

    def dates(values):
        result = {}
        for period, value in values.items():
            if value is None:
                continue
            try:
                result[datetime.strptime(period,"%b %Y")] = period
            except ValueError:
                pass
        return result

    quarters = dates(series("quarters","Sales") or series("quarters","Revenue"))
    if quarters:
        values["quarter"] = quarters[max(quarters)]
    debt = series("balance-sheet","Borrowings")
    balances = dates(debt)
    if balances:
        period = balances[max(balances)]
        capital = series("balance-sheet","Equity Capital").get(period)
        reserves = series("balance-sheet","Reserves").get(period)
        if debt[period] is not None and capital is not None and reserves is not None and capital+reserves>0:
            values["leverage"] = debt[period]/(capital+reserves)
    cash = series("cash-flow","Cash from Operating Activity")
    annual = dates(cash)
    if annual:
        values["operating_cash"] = cash[annual[max(annual)]]
    for subject, field in [("Compounded Sales Growth","sales_3y"),("Compounded Profit Growth","profit_3y")]:
        cells = root.xpath('//table[contains(@class,"ranges-table")][.//th[normalize-space()=$subject]]//tr[td[1][normalize-space()="3 Years:"]]/td[2]',subject=subject)
        if cells:
            values[field] = number(cells[0].text_content())
    return values


async def issuer(client, cache, listing):
    symbol = listing.split(":",1)[1]
    key = "bottom:query-issuer:v4:"+listing
    raw = await cache.get(key)
    if raw:
        return json.loads(raw)
    url = "https://www.screener.in/company/"+quote(symbol,safe="")+"/consolidated/"
    page = await download(client,url)
    root = html.fromstring(page)
    verify_issuer(root,symbol)
    fields = issuer_fields(root)
    fields['display'] = statement_columns(root)
    fields['screen_source'] = screen_ratios.source(root)
    try:
        score_facts = score_financials(root)
        observed = datetime.now(INDIA)
        if (observed.replace(tzinfo=None)-datetime.strptime(score_facts["quarter"],"%b %Y")).days>200:
            raise ValueError("Latest quarter unavailable")
        score_facts.update(source=url, observed=observed.isoformat())
    except (ValueError, KeyError, IndexError):
        score_facts = None
    if score_facts:
        await cache.set("bottom:verified-financials:v1:"+listing, json.dumps(score_facts,allow_nan=False), ex=86400)
    result = [fields,score_facts]
    await cache.set(key,json.dumps(result,allow_nan=False),ex=300)
    return result


async def facts(client, cache, listing):
    saved = await cache.get("bottom:verified-financials:v1:"+listing)
    if saved:
        return json.loads(saved)
    _, score_facts = await issuer(client, cache, listing)
    return score_facts
