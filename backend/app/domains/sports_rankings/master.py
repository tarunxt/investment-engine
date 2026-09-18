import json
from pathlib import Path

from .feeds import FEEDS

ROOT = Path(__file__).parent
SPORTS = []
for line in (ROOT / "master_sports.txt").read_text().splitlines():
    if not line or line.startswith("#"):
        continue
    key, category, name, scope, url = line.split("|")
    SPORTS.append(dict(id=key, category=category, name=name, scope=scope, reference_url=url))
SPORT_BY_ID = {s["id"]: s for s in SPORTS}
CODE_REGISTRY = json.loads((ROOT / "polymarket_codes.json").read_text())
CODE_SPORT = {
    "nfl": "american-football", "nba": "basketball", "wnba": "basketball", "mlb": "baseball", "nhl": "ice-hockey", "khl": "ice-hockey",
    "atp": "tennis-singles", "wta": "tennis-singles", "ufc": "mma", "afl": "australian-rules", "cfl": "canadian-football",
    "lol": "league-of-legends", "cs2": "cs2", "dota2": "dota2", "val": "valorant", "r6siege": "rainbow-six", "mlbb": "mobile-legends", "hok": "honor-of-kings",
    "ow": "overwatch", "rl": "rocket-league", "sc2": "starcraft2", "fifa": "ea-sports-fc", "chess": "chess", "darts": "darts",
}
LEGACY_SPORT = {
    "Football": "soccer", "American football": "american-football", "Ice hockey": "ice-hockey", "Tennis": "tennis-singles",
    "Counter-Strike 2": "cs2", "Dota 2": "dota2", "Honor of Kings": "honor-of-kings", "League of Legends": "league-of-legends",
    "Mobile Legends": "mobile-legends", "Rainbow Six Siege": "rainbow-six", "Valorant": "valorant",
}


def extend_catalogue(imported):
    result = []
    for entry in imported:
        sport_id = LEGACY_SPORT[entry["sport"]]
        sport = SPORT_BY_ID[sport_id]
        item = {**entry, "sport_id": sport_id, "sport": sport["name"], "category": sport["category"], "scope": sport["scope"], "entry_kind": "imported_competition", "code_verified": entry["code"] in CODE_REGISTRY}
        if entry["code"] == "nfl":
            item["source_id"] = "espn-nfl"
        connected = next((key for key, feed in FEEDS.items() if feed.get("code") == entry["code"]), None)
        if connected and not item.get("source_id"):
            item["source_id"] = connected
        if connected and sport_id == "soccer":
            item["scope"] = f"{FEEDS[connected]['name']}; rankings are specific to the competition, season and group."
        result.append(item)
    for sport in SPORTS:
        sources = [(key, feed) for key, feed in FEEDS.items() if feed["sport_id"] == sport["id"]]
        if sport["id"] == "cs2":
            sources = [("valve-global", dict(name="Valve global CS2 ranking", code="cs2", reference_url=sport["reference_url"]))]
        if not sources:
            sources = [(None, dict(name=sport["name"], reference_url=sport["reference_url"], code=next((k for k, v in CODE_SPORT.items() if v == sport["id"] and k in CODE_REGISTRY), "")))]
        for source_id, feed in sources:
            code = feed.get("code") or ""
            # Provider source IDs are not proof of a Polymarket tag.
            if code not in CODE_REGISTRY:
                code = ""
            result.append(dict(id=f"sport-{sport['id']}-{source_id or 'reference'}", code=code, name=feed["name"], sport=sport["name"], sport_id=sport["id"], category=sport["category"], scope=(f"{feed['name']}; rankings are specific to the competition, season and group." if sport["id"] == "soccer" and source_id else sport["scope"]), reference_url=feed["reference_url"], source_id=source_id, mapping_status="master_sport", code_verified=code in CODE_REGISTRY, entry_kind="master_sport", participants=[], events=[]))
    return result
