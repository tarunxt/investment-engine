"""Build a compact sports-participant index from a Universal Polymarket Scan."""
from __future__ import annotations

import json
import re
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


INDEX_SCHEMA_VERSION = 2
_MATCHUP = re.compile(r"\s+(?:vs\.?|v\.?|@)\s+", re.IGNORECASE)
_WIN_QUESTION = re.compile(
    r"^Will\s+(.+?)\s+win\s+on\s+\d{4}-\d{2}-\d{2}\??$",
    re.IGNORECASE,
)
_CODE = re.compile(r"^([a-z0-9]+)-", re.IGNORECASE)
_NON_PARTICIPANTS = {"draw", "tie", "yes", "no"}
_SPORT_TERMS = (
    ("american football", "american-football"),
    ("college football", "american-football"),
    ("gridiron", "american-football"),
    ("nfl", "american-football"),
    ("association football", "soccer"),
    ("football", "soccer"),
    ("soccer", "soccer"),
    ("basketball", "basketball"),
    ("baseball", "baseball"),
    ("ice hockey", "ice-hockey"),
    ("hockey", "field-hockey"),
    ("tennis", "tennis-singles"),
    ("cricket", "t20-cricket"),
    ("rugby", "rugby-union"),
)


def participant_index_path(rows_path: Path) -> Path:
    return rows_path.with_suffix(".sports-participants.json")


def _clean_name(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    name = re.sub(r"\s+", " ", value).strip(" \t\r\n:-")
    if not name or name.casefold() in _NON_PARTICIPANTS or len(name) > 200:
        return None
    return name


# Market descriptions must never enter the team registry, even from old indexes.
_MARKET_SUFFIX = re.compile(
    r"(?:\s[-–—:]\s|\s)(?:total corners|exact score|first team to score|"
    r"halftime result|half.time result|second half result|more markets|player props|"
    r"(?:1st|2nd) half.*|both teams to score|total goals|handicap|spread)(?:\s|$)",
    re.IGNORECASE,
)


def clean_participant_name(value):
    name = _clean_name(value)
    return None if name is None or _MARKET_SUFFIX.search(name) else name


def _event_payload(market: Any) -> dict[str, Any]:
    raw = market.raw if isinstance(getattr(market, "raw", None), dict) else {}
    event = raw.get("_export_event")
    return event if isinstance(event, dict) else {}


def _is_sports_market(market: Any, event: dict[str, Any]) -> bool:
    raw = market.raw if isinstance(getattr(market, "raw", None), dict) else {}
    fee_type = str(raw.get("feeType") or "").casefold()
    sports_type = str(raw.get("sportsMarketType") or "").strip()
    theme = str(getattr(market, "theme", "") or "").casefold()
    event_category = str(event.get("category") or "").casefold()
    return bool(
        sports_type
        or fee_type.startswith("sports_fees_")
        or theme == "sports"
        or event_category == "sports"
    )


def _event_sport_id(market: Any, event: dict[str, Any]) -> str | None:
    raw = market.raw if isinstance(getattr(market, "raw", None), dict) else {}
    values = [
        getattr(market, "theme", None),
        event.get("category"),
        event.get("subcategory"),
        raw.get("sport"),
        raw.get("sportsMarketType"),
    ]
    tags = event.get("tags")
    if isinstance(tags, list):
        for tag in tags:
            if isinstance(tag, dict):
                values.extend(tag.get(key) for key in ("label", "name", "slug"))
            else:
                values.append(tag)
    text = " ".join(str(value).casefold() for value in values if value)
    return next((sport_id for term, sport_id in _SPORT_TERMS if term in text), None)


def participant_record(
    market: Any,
) -> tuple[str, list[str], dict[str, str | None], str | None] | None:
    """Return a competition code, participant names and their source event."""
    event = _event_payload(market)
    if not _is_sports_market(market, event):
        return None
    event_slug = _clean_name(event.get("slug")) or _clean_name(getattr(market, "event_slug", None))
    match = _CODE.match(event_slug or "")
    if match is None:
        return None
    code = match.group(1).casefold()

    event_title = _clean_name(event.get("title"))
    names: list[str] = []
    if event_title:
        parts = _MATCHUP.split(event_title, maxsplit=1)
        if len(parts) == 2:
            names = [name for part in parts if (name := clean_participant_name(part))]
            if len(names) != 2:
                return None

    # Polymarket also represents a full match as one Yes/No market per side.
    # Only the date-specific "Will X win" form is accepted here; outrights such
    # as "Will X win the league" are intentionally excluded.
    if not names:
        question = _clean_name(getattr(market, "question", None))
        question_match = _WIN_QUESTION.match(question or "")
        if question_match:
            candidate = clean_participant_name(question_match.group(1))
            if candidate:
                names = [candidate]
    if not names:
        return None
    return code, names, {"slug": event_slug, "title": event_title}, _event_sport_id(market, event)


class SportsParticipantCollector:
    """Deduplicate participants/events while a Universal Scan streams by."""

    def __init__(self) -> None:
        self._codes: dict[str, dict[str, dict[str, Any]]] = {}

    def add(self, market: Any) -> None:
        record = participant_record(market)
        if record is None:
            return
        code, names, event, sport_id = record
        bucket = self._codes.setdefault(code, {"participants": {}, "events": {}})
        if sport_id and not bucket.get("sport_id"):
            bucket["sport_id"] = sport_id
        for name in names:
            bucket["participants"].setdefault(name.casefold(), name)
        event_key = (event.get("slug") or event.get("title") or "").casefold()
        if event_key:
            bucket["events"].setdefault(event_key, event)

    def payload(self, *, export_id: str | None = None) -> dict[str, Any]:
        codes = {}
        for code, bucket in sorted(self._codes.items()):
            codes[code] = {
                "sport_id": bucket.get("sport_id"),
                "participants": sorted(bucket["participants"].values(), key=str.casefold),
                "events": sorted(
                    bucket["events"].values(),
                    key=lambda item: ((item.get("slug") or "").casefold(), (item.get("title") or "").casefold()),
                ),
            }
        return {
            "schema_version": INDEX_SCHEMA_VERSION,
            "export_id": export_id,
            "generated_at": datetime.now(UTC).isoformat(),
            "codes": codes,
        }


def write_participant_index(
    rows_path: Path,
    markets: Iterable[Any],
    *,
    export_id: str | None = None,
) -> Path:
    collector = SportsParticipantCollector()
    for market in markets:
        collector.add(market)
    target = participant_index_path(rows_path)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(
        json.dumps(collector.payload(export_id=export_id), ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary.replace(target)
    return target


def load_participant_index(user_id: int) -> dict[str, dict[str, Any]]:
    """Load the latest completed user's compact index without scanning JSONL."""
    from app.domains.trading_bots.universal_scan import latest_completed_universal_export

    resolved = latest_completed_universal_export(user_id)
    if resolved is None:
        return {}
    _, rows_path = resolved
    path = participant_index_path(rows_path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if payload.get("schema_version") not in (1, INDEX_SCHEMA_VERSION) or not isinstance(payload.get("codes"), dict):
        return {}
    return {
        str(code).casefold(): value
        for code, value in payload["codes"].items()
        if isinstance(value, dict)
    }
