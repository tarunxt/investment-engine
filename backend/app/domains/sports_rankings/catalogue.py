import json
from functools import lru_cache
import re
import unicodedata
from pathlib import Path
from .feeds import FEEDS
from .master import CODE_REGISTRY, SPORT_BY_ID, extend_catalogue

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


@lru_cache(maxsize=32768)
def normalize_name(value: str) -> str:
    # Retain scripts (including Cyrillic); do not merge academy, women's or U20 teams.
    value = "".join(c for c in unicodedata.normalize("NFKD", value) if not unicodedata.combining(c))
    return re.sub(r"[\W_]+", " ", value.casefold()).strip()


def participant_aliases(code: str, name: str, declared=()):
    """Return every reviewed competition-scoped alias for a participant name."""
    aliases = list(declared or [])
    mapping = ALIASES.get(code, {})
    normalized = normalize_name(name)
    for canonical, values in mapping.items():
        family = [canonical, *values]
        if normalized in {normalize_name(value) for value in family}:
            aliases.extend(value for value in family if normalize_name(value) != normalized)
    return list(dict.fromkeys(aliases))


def augment_competition(competition, participant_registry):
    """Merge current Polymarket participants/events into a catalogue entry."""
    imported = participant_registry.get(competition["code"], {}) if competition.get("code") else {}
    dynamic_names = imported.get("participants") if isinstance(imported, dict) else []
    dynamic_events = imported.get("events") if isinstance(imported, dict) else []
    participants = [
        {
            **participant,
            "aliases": participant_aliases(
                competition["code"], participant["name"], participant.get("aliases", [])
            ),
        }
        for participant in competition["participants"]
    ]
    known = {normalize_name(participant["name"]) for participant in participants}
    for name in dynamic_names if isinstance(dynamic_names, list) else []:
        if not isinstance(name, str) or not normalize_name(name) or normalize_name(name) in known:
            continue
        participants.append({
            "name": name,
            "aliases": participant_aliases(competition["code"], name),
        })
        known.add(normalize_name(name))

    events = [dict(event) for event in competition["events"]]
    event_keys = {
        (event.get("slug") or "", event.get("title") or "")
        for event in events
    }
    for event in dynamic_events if isinstance(dynamic_events, list) else []:
        if not isinstance(event, dict):
            continue
        candidate = {
            "slug": event.get("slug"),
            "title": event.get("title"),
        }
        key = (candidate["slug"] or "", candidate["title"] or "")
        if key != ("", "") and key not in event_keys:
            events.append(candidate)
            event_keys.add(key)
    return {**competition, "participants": participants, "events": events}


def augment_catalogue(catalogue, participant_registry):
    result = [augment_competition(competition, participant_registry) for competition in catalogue]
    known_codes = {competition["code"] for competition in result if competition.get("code")}
    for code, imported in participant_registry.items():
        if code in known_codes or not isinstance(imported, dict):
            continue
        sport_id = imported.get("sport_id")
        sport = SPORT_BY_ID.get(sport_id)
        if sport is None:
            continue
        registry_entry = CODE_REGISTRY.get(code, {})
        competition = {
            "id": f"polymarket-{code}",
            "code": code,
            "name": registry_entry.get("name") or f"{code.upper()} Polymarket competition",
            "sport": sport["name"],
            "sport_id": sport_id,
            "category": sport["category"],
            "scope": sport["scope"],
            "reference_url": "https://polymarket.com/sports",
            "source_id": None,
            "mapping_status": "current_polymarket_scan",
            "code_verified": code in CODE_REGISTRY,
            "entry_kind": "polymarket_scan",
            "participants": [],
            "events": [],
        }
        result.append(augment_competition(competition, participant_registry))
    return result


def source_kind(source_id):
    if source_id in FEEDS:
        if FEEDS[source_id]["parser"] in {"cricket-table", "cricket-hundred", "cricket-ecb", "espn-soccer"}:
            return "Published competition standings"
        return "Derived group standings" if FEEDS[source_id]["parser"] == "espn" else "Published ranking"
    return "Derived results table" if (source_id or "").startswith("football-data-") else "Valve global ranking" if source_id == "valve-global" else "Reference only"
