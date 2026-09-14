"""Parse public cricket pages without executing JavaScript or calling private APIs."""
from datetime import UTC, datetime
import json
import re

from lxml import html

from .public_providers import cls, number, text, validate


def embedded_values(doc, key):
    """Read one JSON value from Next's public hydration text; never eval scripts."""
    values = []
    for script in doc.xpath("//script/text()"):
        if not script.startswith("self.__next_f.push("):
            continue
        try:
            part = json.loads(script[len("self.__next_f.push("):].rstrip(");"))
        except (ValueError, TypeError):
            continue
        if len(part) != 2 or part[0] != 1 or not isinstance(part[1], str):
            continue
        payload = part[1]
        for match in re.finditer(re.escape(json.dumps(key)) + r"\s*:\s*", payload):
            value, _ = json.JSONDecoder().raw_decode(payload[match.end():])
            if value not in values:
                values.append(value)
    if len(values) != 1:
        raise ValueError(f"Missing or conflicting cricket {key}")
    return values[0]


def integer(value):
    value = number(value)
    if value < 0 or int(value) != value:
        raise ValueError("Invalid cricket count")
    return value


def finish(rows, minimum):
    rows = validate(rows, minimum)
    groups = {r["group"] for r in rows}
    for group in groups:
        ranks = [r["rank"] for r in rows if r["group"] == group]
        previous = None
        for index, rank in enumerate(sorted(ranks), 1):
            if rank != index and rank != previous:
                raise ValueError("Incomplete cricket positions")
            previous = rank
    return rows


def parse_cricket(body, feed):
    doc = html.fromstring(body)
    parser = feed["parser"]
    rows, date, season = [], None, None
    if parser == "cricket-rankings":
        if embedded_values(doc, "categoryType") != "teams" or embedded_values(doc, "gender") != feed["gender"]:
            raise ValueError("Wrong cricket ranking scope")
        data = embedded_values(doc, "formatTypesData")[feed["format"]]["rank"]
        for r in data:
            rows.append(dict(name=r["name"], provider_id=str(r["id"]), rank=integer(r["rank"]), played=integer(r["matches"]),
                             rating=None if r.get("rating") in (None, "$undefined") else integer(r["rating"]), points=integer(r["points"]), group=f"{feed['gender'].title()} · {feed['format'].upper()}"))
    elif parser == "cricket-table":
        data = embedded_values(doc, "pointsTableData")
        if data["seriesId"] != feed["series_id"] or data["seriesName"] != feed["series_name"]:
            raise ValueError("Wrong cricket tournament edition")
        season = re.search(r"\b20\d{2}\b", data["seriesName"])[0]
        if data.get("lastUpdated"):
            date = datetime.fromtimestamp(number(data["lastUpdated"]) / 1000, UTC).date().isoformat()
        for group in data["pointsTable"]:
            for rank, r in enumerate(group["pointsTableInfo"], 1):
                played, won, lost, tied, nr, drawn = [integer(r.get(k, 0)) for k in ["matchesPlayed", "matchesWon", "matchesLost", "matchesTied", "noRes", "matchesDrawn"]]
                if played != won + lost + tied + nr + drawn:
                    raise ValueError("Inconsistent cricket match counts")
                rows.append(dict(name=r["teamFullName"], provider_id=str(r["teamId"]), rank=rank, played=played, won=won, lost=lost,
                                 points=number(r["points"]), nrr=number(r["nrr"]), group=group["groupName"],
                                 record=f"P {played} · W {won} · L {lost} · T {tied} · NR {nr}"))
    elif parser == "cricket-hundred":
        season_nodes = doc.xpath("//*[@data-combined-season]/@data-combined-season")
        if len(set(season_nodes)) != 1:
            raise ValueError("Hundred season missing")
        season = season_nodes[0]
        tables = doc.xpath(f"//*[@data-tab-panel='{feed['gender']}']//table")
        if len(tables) != 1:
            raise ValueError("Hundred gender table missing")
        for tr in tables[0].xpath(".//tbody/tr"):
            cells = tr.xpath("./td")
            if len(cells) != 10:
                raise ValueError("Hundred table schema changed")
            rank, played, won, lost, tied, nr = [integer(text(cells[i])) for i in [0, 2, 3, 4, 5, 6]]
            if played != won + lost + tied + nr:
                raise ValueError("Inconsistent Hundred match counts")
            rows.append(dict(name=text(cells[1]), rank=rank, played=played, won=won, lost=lost, points=number(text(cells[8])),
                             nrr=number(text(cells[7])), group=feed["gender"].title(), record=f"P {played} · W {won} · L {lost} · T {tied} · NR {nr}"))
    elif parser == "cricket-ecb":
        # First option is the selected latest edition on the canonical /tables URL.
        options = doc.xpath("//option[contains(@data-href,'/tables/')]")
        if not options:
            raise ValueError("ECB season missing")
        season = text(next((o for o in options if o.get("selected") is not None), options[0]))
        for table in doc.xpath("//table[.//td[contains(@class,'w-table-body-cell__pos')]]"):
            group_nodes = table.getparent().xpath("preceding-sibling::h3[1]")
            if len(group_nodes) != 1:
                raise ValueError("ECB competition group missing")
            group = text(group_nodes[0])
            for tr in table.xpath(".//tbody/tr"):
                cells = tr.xpath("./td")
                if len(cells) != 9:
                    raise ValueError("ECB table schema changed")
                name = cells[1].xpath(f".//*[{cls('w-table-body-cell-team-name__full')}]")
                row = dict(name=text(name[0]), rank=integer(text(cells[0])), played=integer(text(cells[2])), won=integer(text(cells[3])),
                           lost=integer(text(cells[4])), points=number(text(cells[8])), group=group)
                if "One Day" in group:
                    row["nrr"] = number(text(cells[7]))
                row["record"] = f"P {row['played']} · W {row['won']} · L {row['lost']}"
                rows.append(row)
    else:
        raise ValueError("Unsupported cricket parser")
    if season and not re.fullmatch(r"20\d{2}", season):
        raise ValueError("Invalid cricket season")
    return finish(rows, feed["minimum"]), date, season
