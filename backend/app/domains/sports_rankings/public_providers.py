"""Validated public JSON and HTML adapters; no authentication or arbitrary URL fetches."""
from datetime import UTC, datetime
import json
import math
import re
from urllib.parse import urljoin, urlparse

from lxml import html

from .feeds import FEEDS


def number(value):
    result = float(str(value).replace(",", "").strip())
    if not math.isfinite(result):
        raise ValueError("Non-finite ranking value")
    return int(result) if result.is_integer() else result


def text(node):
    return " ".join(node.itertext()).strip()


def cls(name):
    return f"contains(concat(' ', normalize-space(@class), ' '), ' {name} ')"


def validate(rows, minimum=10):
    unique = {}
    for row in rows:
        if not row.get("name") or (row.get("rank") is not None and (row["rank"] < 1 or int(row["rank"]) != row["rank"])):
            raise ValueError("Invalid ranking identity or position")
        key = (row.get("group", ""), row["name"])
        if key in unique and unique[key] != row:
            raise ValueError("Conflicting duplicate ranking identity")
        unique[key] = row
    if len(unique) < minimum:
        raise ValueError("Incomplete public ranking response")
    return list(unique.values())


def parse_json(data, parser):
    rows, date, season = [], None, None
    if parser == "rugby":
        date = data["effective"]["label"]
        rows = [dict(name=r["team"]["name"], provider_id=r["team"]["id"], rank=number(r["pos"]), points=number(r["pts"])) for r in data["entries"]]
    elif parser == "tennis":
        for listing in data["rankings"]:
            date = listing.get("update", "")[:10] or None
            rows.extend(dict(name=r["athlete"]["displayName"], provider_id=r["athlete"]["id"], rank=number(r["current"]), points=number(r["points"]), group=listing["name"]) for r in listing["ranks"])
    elif parser == "nhl":
        dates, seasons = set(), set()
        for r in data["standings"]:
            dates.add(r["date"]); seasons.add(str(r["seasonId"]))
            rows.append(dict(name=r["teamName"]["default"], rank=number(r["leagueSequence"]), points=number(r["points"]), played=r["gamesPlayed"], won=r["wins"], lost=r["losses"], record=f"{r['wins']}-{r['losses']}-{r['otLosses']}", group="NHL overall"))
        if len(dates) != 1 or len(seasons) != 1:
            raise ValueError("Mixed NHL snapshot seasons/dates")
        date, season = dates.pop(), seasons.pop()
    elif parser == "espn":
        season = str(data["season"])
        def visit(node):
            nonlocal season
            if "standings" in node:
                standings = node["standings"]
                season = standings.get("seasonDisplayName") or str(standings.get("season", season))
                for entry in standings["entries"]:
                    stats = {r["name"]: r.get("value") for r in entry["stats"]}
                    wins, losses = number(stats["wins"]), number(stats["losses"])
                    ties = number(stats.get("ties") or 0)
                    played = wins + losses + ties
                    pct = number(stats["winPercent"])
                    if min(wins, losses, ties, pct) < 0 or pct > 1:
                        raise ValueError("Invalid standings record")
                    rows.append(dict(name=entry["team"]["displayName"], provider_id=entry["team"]["id"], rank=None, points=None, rating=pct, played=played, won=wins, lost=losses, record=f"{wins}-{losses}" + (f"-{ties}" if ties else ""), group=node["name"]))
            for child in node.get("children", []):
                visit(child)
        visit(data)
        rows.sort(key=lambda r: (r["group"], -r["rating"], r["name"]))
        for group in {r["group"] for r in rows}:
            previous, rank = None, None
            for i, row in enumerate([r for r in rows if r["group"] == group], 1):
                if row["rating"] != previous:
                    rank = i
                row["rank"] = rank if row["played"] else None
                previous = row["rating"]
    return validate(rows), date, season


def parse_html(body, parser):
    doc = html.fromstring(body)
    rows, date = [], None
    if parser == "fide":
        match = re.search(r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b", text(doc))
        if not match:
            raise ValueError("FIDE publication month missing")
        date = datetime.strptime(match[0], "%B %Y").date().isoformat()
        for tr in doc.xpath(f"//table[{cls('top_recors_table')}]//tr[td]"):
            cells = tr.xpath("./td")
            rows.append(dict(name=text(cells[1]), rank=number(text(cells[0])), rating=number(text(cells[3])), points=None, country=text(cells[2])))
    elif parser == "wta":
        if not doc.xpath("//table[@data-type='rankDoubles']"):
            raise ValueError("WTA doubles scope missing")
        for tr in doc.xpath("//table[@data-type='rankDoubles']//tr[@data-player-name]"):
            rows.append(dict(name=tr.get("data-player-name"), provider_id=tr.get("data-player-id"), rank=number(text(tr.xpath(f".//*[{cls('player-row__rank')}]")[0])), points=number(text(tr.xpath(f".//*[{cls('player-row__cell--points')}]")[0]))))
    elif parser == "ufc":
        for table in doc.xpath("//table[caption//h4]"):
            group = text(table.xpath("./caption//h4")[0]).replace("Top Rank", "").strip()
            if table.xpath("./caption//h6"):
                rows.append(dict(name=text(table.xpath("./caption//h5/a")[0]), rank=None, points=None, group=group, rank_label="Champion"))
            for tr in table.xpath(".//tbody/tr"):
                cells = tr.xpath("./td")
                rows.append(dict(name=text(cells[1]), rank=number(text(cells[0])), points=None, group=group))
    elif parser == "netball":
        table = doc.xpath("//table[.//th[contains(.,'Weighted')]]")
        if len(table) != 1:
            raise ValueError("Netball ranking schema missing")
        for tr in table[0].xpath(".//tbody/tr"):
            cells = tr.xpath("./td")
            if text(cells[0]).isdigit():
                rows.append(dict(name=text(cells[2]), rank=number(text(cells[0])), played=number(text(cells[3])), points=number(text(cells[5])), rating=number(text(cells[6]))))
    elif parser == "fih":
        for a in doc.xpath(f"//a[{cls('table-row')}][contains(@href,'-hockey-rankings-')]"):
            href = a.get("href")
            group = "Women" if "-women-" in href else "Men" if "-men-" in href else None
            if not group:
                continue
            rows.append(dict(name=text(a.xpath(f".//*[{cls('full-name')}]")[0]), group=group, rank=number(text(a.xpath(".//span[@class='rank']")[0])), points=number(text(a.xpath(f".//*[{cls('points')}]")[0]))))
    return validate(rows), date, None


def read_public(client, url):
    # Only same-host HTTPS redirects are permitted, with bounded hops and body size.
    original_host = urlparse(url).hostname
    for _ in range(3):
        with client.stream("GET", url) as response:
            if response.status_code in (301, 302, 303, 307, 308):
                target = urljoin(url, response.headers["location"])
                if urlparse(target).scheme != "https" or urlparse(target).hostname != original_host:
                    raise ValueError("Unexpected ranking source redirect")
                url = target
                continue
            response.raise_for_status()
            body = bytearray()
            for part in response.iter_bytes():
                body.extend(part)
                if len(body) > 8_000_000:
                    raise ValueError("Ranking response exceeds 8 MB")
            return body.decode("utf-8", errors="replace"), url
    raise ValueError("Too many ranking redirects")


def fetch_public(source_id, client, now):
    feed = FEEDS[source_id]
    body, url = read_public(client, feed["url"])
    parser = feed["parser"]
    if parser in {"espn", "tennis", "rugby", "nhl"}:
        data = json.loads(body)
        rows, date, season = parse_json(data, parser)
        if parser == "espn" and not any(r["played"] for r in rows):
            current = data["season"]["year"] if isinstance(data["season"], dict) else int(data["season"])
            body, url = read_public(client, feed["url"] + f"?season={current - 1}")
            rows, date, season = parse_json(json.loads(body), parser)
            season = f"{season} · previous completed season"
    else:
        rows, date, season = parse_html(body, parser)
    if date and date > now.date().isoformat():
        raise ValueError("Future ranking publication date")
    return dict(rows=rows, source_url=url, source_as_of=date, season=season)
