import json
import re
import unicodedata
from pathlib import Path
from .feeds import FEEDS
from .master import extend_catalogue

CATALOGUE = json.loads(Path(__file__).with_name("catalogue.json").read_text())
ALIASES = json.loads(Path(__file__).with_name("aliases.json").read_text())
for competition in CATALOGUE:
    for participant in competition["participants"]:
        participant["aliases"] = ALIASES.get(competition["code"], {}).get(participant["name"], participant["aliases"])
IMPORTED_CATALOGUE = CATALOGUE
CATALOGUE = extend_catalogue(IMPORTED_CATALOGUE)
FOOTBALL_DIVISIONS = {
    "E0", "E1", "D1", "D2", "I1", "I2", "SP1", "SP2", "F1",
    "N1", "B1", "P1", "T1", "G1",
}
SOURCE_IDS = {"valve-global", *(f"football-data-{d}" for d in FOOTBALL_DIVISIONS), *FEEDS}
REFRESH_SECONDS = 900


def normalize_name(value: str) -> str:
    # Retain scripts (including Cyrillic); do not merge academy, women's or U20 teams.
    value = "".join(c for c in unicodedata.normalize("NFKD", value) if not unicodedata.combining(c))
    return re.sub(r"[\W_]+", " ", value.casefold()).strip()


def source_kind(source_id):
    if source_id in FEEDS:
        if FEEDS[source_id]["parser"] in {"cricket-table", "cricket-hundred", "cricket-ecb", "espn-soccer"}:
            return "Published competition standings"
        return "Derived group standings" if FEEDS[source_id]["parser"] == "espn" else "Published ranking"
    return "Derived results table" if (source_id or "").startswith("football-data-") else "Valve global ranking" if source_id == "valve-global" else "Reference only"
