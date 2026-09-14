"""Fetch only explicitly configured public datasets, never reference-page HTML."""
import csv
from datetime import UTC, datetime
import io
import re

import httpx

from .catalogue import SOURCE_IDS, normalize_name

VALVE_API = "https://api.github.com/repos/ValveSoftware/counter-strike_regional_standings"
VALVE_RAW = "https://raw.githubusercontent.com/ValveSoftware/counter-strike_regional_standings"


def parse_valve(text):
    date = re.search(r"Standings as of (\d{4}_\d{2}_\d{2})", text)
    if not date:
        raise ValueError("Valve publication date missing")
    rows = []
    for line in text.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4 or not cells[0].isdigit():
            continue
        rank, points = int(cells[0]), int(cells[1])
        if rank < 1 or points < 0 or not cells[2]:
            raise ValueError("Invalid Valve standing")
        rows.append(dict(name=cells[2], rank=rank, points=points, roster=cells[3]))
    identities = [(normalize_name(r["name"]), r["roster"]) for r in rows]
    if len(rows) < 10 or len(set(identities)) != len(identities):
        raise ValueError("Incomplete or duplicate Valve dataset")
    return rows, date[1].replace("_", "-")


def parse_football(text, division, now=None):
    now = now or datetime.now(UTC)
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    if not {"Div", "Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "FTR"}.issubset(reader.fieldnames or []):
        raise ValueError("Football results columns missing")
    teams, seen, dates = {}, set(), []
    for row in reader:
        if not row.get("HomeTeam") or not row.get("AwayTeam"):
            continue
        if row["Div"] != division:
            raise ValueError("Unexpected football division")
        if row["FTHG"] == "" and row["FTAG"] == "":
            continue
        date = None
        for fmt in ("%d/%m/%Y", "%d/%m/%y"):
            try:
                date = datetime.strptime(row["Date"], fmt).date()
                break
            except ValueError:
                pass
        if date is None or date > now.date():
            raise ValueError("Invalid or future completed-match date")
        key = (date, row["HomeTeam"], row["AwayTeam"])
        if key in seen:
            raise ValueError("Duplicate match in results feed")
        seen.add(key)
        hg, ag = int(row["FTHG"]), int(row["FTAG"])
        if min(hg, ag) < 0 or row["FTR"] != ("H" if hg > ag else "A" if ag > hg else "D"):
            raise ValueError("Invalid full-time result")
        dates.append(date.isoformat())
        for name, gf, ga in ((row["HomeTeam"], hg, ag), (row["AwayTeam"], ag, hg)):
            t = teams.setdefault(name, dict(name=name, played=0, won=0, drawn=0, lost=0, goals_for=0, goals_against=0, points=0))
            t["played"] += 1
            t["goals_for"] += gf
            t["goals_against"] += ga
            t["won"] += int(gf > ga)
            t["drawn"] += int(gf == ga)
            t["lost"] += int(gf < ga)
            t["points"] += 3 if gf > ga else 1 if gf == ga else 0
            t["goal_difference"] = t["goals_for"] - t["goals_against"]
    if len(teams) < 2:
        raise ValueError("No completed matches in current-season feed")
    # Deliberately a generic performance order: NOT an official league position.
    rows = sorted(teams.values(), key=lambda t: (-t["points"], -t["goal_difference"], -t["goals_for"], t["name"]))
    last_score = None
    for i, t in enumerate(rows, 1):
        score = (t["points"], t["goal_difference"], t["goals_for"])
        if score != last_score:
            rank = i
        t["rank"] = rank
        last_score = score
    return rows, max(dates)


def read_response(client, url):
    # Bound even decompressed bodies; do not follow redirects to arbitrary hosts.
    with client.stream("GET", url) as response:
        response.raise_for_status()
        data = bytearray()
        for part in response.iter_bytes():
            data.extend(part)
            if len(data) > 4_000_000:
                raise ValueError("Ranking feed exceeds size limit")
        return bytes(data).decode("utf-8-sig", errors="strict")


def fetch_source(source_id, now=None):
    import json
    if source_id not in SOURCE_IDS:
        raise ValueError("Unknown ranking source")
    now = now or datetime.now(UTC)
    with httpx.Client(timeout=12, follow_redirects=False, headers={"User-Agent": "Cred-X-SportsRankings/1.0", "Accept": "application/json,text/csv,text/plain"}) as client:
        if source_id == "valve-global":
            # Discover the latest year from the publisher, including across New Year.
            years = json.loads(read_response(client, f"{VALVE_API}/contents/live"))
            year = max(int(y["name"]) for y in years if re.fullmatch(r"\d{4}", y.get("name", "")) and int(y["name"]) <= now.year)
            listing = json.loads(read_response(client, f"{VALVE_API}/contents/live/{year}"))
            files = [f for f in listing if re.fullmatch(r"standings_global_\d{4}_\d{2}_\d{2}\.md", f.get("name", ""))]
            latest = max(files, key=lambda f: f["name"])
            url = f"{VALVE_RAW}/main/live/{year}/{latest['name']}"
            rows, as_of = parse_valve(read_response(client, url))
            if as_of > now.date().isoformat():
                raise ValueError("Future Valve publication date")
            return dict(rows=rows, source_url=url, source_as_of=as_of, season="Global")
        division = source_id.removeprefix("football-data-")
        year = now.year if now.month >= 7 else now.year - 1
        season = f"{year % 100:02d}{(year + 1) % 100:02d}"
        url = f"https://football-data.co.uk/mmz4281/{season}/{division}.csv"
        rows, as_of = parse_football(read_response(client, url), division, now)
        if not f"{year}-07-01" <= as_of <= f"{year + 1}-06-30":
            raise ValueError("Results do not belong to requested season")
        return dict(rows=rows, source_url=url, source_as_of=as_of, season=f"{year}/{year + 1}")
