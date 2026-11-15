"""Parse public FotMob table data without executing page scripts."""
import json

from lxml import html

from .public_providers import number, validate


def parse_fotmob(body, feed):
    scripts = html.fromstring(body).xpath('//script[@id="__NEXT_DATA__"]/text()')
    if len(scripts) != 1:
        raise ValueError("Published football table data missing")
    page = json.loads(scripts[0])["props"]["pageProps"]
    details = page["details"]
    if (details["id"], details["country"], details["gender"]) != (
        feed["league_id"], feed["country"], feed["gender"]
    ):
        raise ValueError("Football competition/country/gender mismatch")
    season = details["selectedSeason"]
    if not season or season != details["latestSeason"]:
        raise ValueError("Football table is not the latest published edition")
    rows = []

    def visit(table):
        for row in table.get("table", {}).get("all", []):
            played, points = number(row["played"]), number(row["pts"])
            won, drawn, lost = (number(row[k]) for k in ("wins", "draws", "losses"))
            if min(played, won, drawn, lost) < 0 or won + drawn + lost != played:
                raise ValueError("Invalid football table record")
            rows.append(dict(
                name=row["name"], provider_id=str(row["id"]),
                provider_aliases=[row["name"], row.get("shortName") or row["name"]],
                rank=number(row["idx"]), points=points, played=played,
                won=won, drawn=drawn, lost=lost, record=f"{won}-{drawn}-{lost}",
                rating=round(points / (3 * played) * 100, 2) if played else None,
                group=table["leagueName"], deduction=row.get("deduction"),
            ))
        for child in table.get("tables", []):
            visit(child)

    for entry in page["table"]:
        table = entry["data"]
        if table["leagueId"] != feed["league_id"]:
            raise ValueError("Unexpected football table scope")
        visit(table)
    return validate(rows, feed["minimum"]), None, season
