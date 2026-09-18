"""Deterministic, explainable ranking resolution; no network calls or trading effects."""
from collections import Counter, defaultdict
from datetime import UTC, datetime
import math
import re
import json
from pathlib import Path

from .catalogue import normalize_name, source_kind
from .feeds import FEEDS
from .polymarket_participants import clean_participant_name

RESOLUTION_VERSION = "sports-ranking-v2"
# Reviewed against published team IDs, scoped by competition and provider.
IDENTITIES = json.loads(Path(__file__).with_name("identities.json").read_text())
REMEDIES = {
    "VALID": "Both teams have current rankings in the same ranking scope.",
    "NOT_COMPARABLE": "Individual ranks are available, but their leagues or groups differ. Use a common rating system before comparing them.",
    "FEED_NOT_CONNECTED": "Connect a validated feed for this competition, edition, gender and age group.",
    "FEED_PENDING": "The configured source is awaiting its first successful refresh.",
    "FEED_FAILED": "Check the source error, repair the provider adapter or enable a validated fallback, then refresh.",
    "STALE": "Refresh this source; retained last-good values are historical and cannot be used as a current comparison.",
    "NO_PUBLISHED_RANK": "The provider knows this team but has not published its position yet. Keep it unranked until the current competition table is published.",
    "TEAM_UNMAPPED": "Verify the team and season membership, then add a reviewed provider-ID or name mapping. Do not guess the nearest team.",
    "SOURCE_CONFLICT": "Multiple team identities or ranking groups remain within the selected provider. Verify the fixture scope before selecting one.",
    "METADATA_MISSING": "Import the parent fixture with two explicit participant names and a verified competition tag.",
    "INVALID_PARTICIPANT": "The supplied participant contains a market description or is not a full-match team identity.",
}


def numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def source_priority(source_id):
    feed = FEEDS.get(source_id, {})
    return (feed.get("priority", 10 if source_id.startswith("espn-soccer-") else 30), source_id)


def _iso(value):
    return value.isoformat() if hasattr(value, "isoformat") else value


def _scope(code):
    if code == "u20wwc":
        return "women-u20-national"
    if code in {"nwsl", "wsl", "uwcl"}:
        return "women-senior-club"
    return "men-senior-club"


def _edition_current(snapshot):
    season = getattr(snapshot, "season", None)
    if not season:
        return True  # Legacy sources expose source_as_of instead.
    if "previous completed season" in season:
        return False
    years = [int(x) for x in re.findall(r"\b20\d{2}\b", season)]
    year = datetime.now(UTC).year
    if not years:
        return True
    # A football season starting last summer is not current after July rollover.
    if re.search(r"20\d{2}\s*[-/]\s*(?:20)?\d{2}", season):
        expected_start = year if datetime.now(UTC).month >= 7 else year - 1
        return min(years) == expected_start
    return max(years) == year


def compare_events(query, snapshots, catalogue):
    from .service import _RowMatcher, _head_to_head_participants, _market_code, _metric, ranking_rows, source_status

    generated = datetime.now(UTC).isoformat()
    by_code = defaultdict(list)
    for competition in catalogue:
        by_code[competition.get("code")].append(competition)
    indexes, lookup_cache = {}, {}

    def index(competition):
        key = competition["id"]
        if key not in indexes:
            snapshot = snapshots.get(competition.get("source_id"))
            rows = ranking_rows(competition, snapshot)
            # Imported null placeholders are diagnostic names, never ranked identities.
            published = [r for r in rows if not r.get("match_status") and (numeric(r.get("rank")) or r.get("provider_id"))]
            indexes[key] = _RowMatcher(published, competition.get("code"), include_global=False)
        return indexes[key]

    def candidates(name, competitions, global_aliases=False):
        output = {}
        for competition in competitions:
            source = competition.get("source_id")
            snapshot = snapshots.get(source)
            if not source or snapshot is None:
                continue
            key = (name, competition["id"], global_aliases)
            if key not in lookup_cache:
                matcher = index(competition)
                from .catalogue import participant_aliases
                names = [name, *participant_aliases(competition.get("code"), name)]
                if global_aliases:
                    # Only reviewed aliases from the same soccer scope, not arbitrary fuzzy guesses.
                    from .catalogue import participant_aliases
                    for code in by_code:
                        if code and _scope(code) == _scope(competition.get("code")):
                            names.extend(participant_aliases(code, name))
                provider = FEEDS.get(source, {}).get("provider", "espn" if source.startswith("espn-") else source)
                known_ids = {IDENTITIES.get(competition.get("code"), {}).get(normalize_name(n), {}).get(provider) for n in names} - {None}
                if known_ids:
                    lookup_cache[key] = [row for row, _ in matcher.rows if str(row.get("provider_id")) in known_ids]
                else:
                    lookup_cache[key] = matcher.match(names, allow_fuzzy=False)
            matches = lookup_cache[key]
            # Never silently choose among two provider identities.
            for row in matches:
                identity = str(row.get("provider_id") or normalize_name(row["name"]))
                item = {
                    **row, "source_id": source, "competition_id": competition["id"],
                    "competition": competition["name"], "code": competition.get("code"),
                    "source_status": source_status(snapshot, source),
                    "season": getattr(snapshot, "season", None),
                    "source_as_of": getattr(snapshot, "source_as_of", None),
                    "source_url": getattr(snapshot, "source_url", None),
                    "checked_at": _iso(getattr(snapshot, "checked_at", None)),
                    "successful_at": _iso(getattr(snapshot, "successful_at", None)),
                    "snapshot_hash": getattr(snapshot, "content_hash", None),
                    "source_error": getattr(snapshot, "error", None),
                    "ranking_kind": source_kind(source),
                    "canonical_id": f"{FEEDS.get(source, {}).get('provider', 'espn' if source.startswith('espn-') else source)}:{identity}",
                    "edition_current": _edition_current(snapshot),
                }
                output[(source, row.get("group"), identity)] = item
        return list(output.values())

    def usable(row):
        return row["source_status"] == "ready" and row["edition_current"] and numeric(row.get("rank"))

    def select(rows):
        if not rows:
            return None, False
        ordered = sorted(rows, key=lambda r: (not usable(r), source_priority(r["source_id"])))
        best = ordered[0]
        same_source = [r for r in ordered if r["source_id"] == best["source_id"]]
        if len(same_source) != 1:
            return None, True
        return best, False

    def compatible(a, b):
        return (a["source_id"], a.get("season"), a.get("group")) == (b["source_id"], b.get("season"), b.get("group"))

    def missing_status(competitions):
        connected = [c for c in competitions if c.get("source_id")]
        if not connected:
            return "FEED_NOT_CONNECTED"
        states = [source_status(snapshots.get(c["source_id"]), c["source_id"]) for c in connected]
        if "ready" in states:
            return "TEAM_UNMAPPED"
        if "failed" in states:
            return "FEED_FAILED"
        return "STALE" if "stale" in states else "FEED_PENDING"

    comparisons = {}
    for event in query.events:
        code = _market_code(event.event_slug)
        participants = _head_to_head_participants(event.event_title)
        result = {
            "market_id": event.market_id, "code": code, "tags": [code] if code else [],
            "team_a": participants[0] if participants else None,
            "team_b": participants[1] if participants else None,
            "match_status": "unmatched", "ranking": None, "rating": None, "points": None,
            "competition_id": None, "competition": None, "source_as_of": None,
            "resolution_version": RESOLUTION_VERSION, "generated_at": generated,
            "view": "current", "status_code": "METADATA_MISSING", "comparable": False,
            "team_details": {}, "source_diagnostics": [],
        }
        if code and participants and all(clean_participant_name(n) for n in participants):
            competitions = by_code.get(code, [])
            soccer = any(c.get("sport_id") == "soccer" for c in competitions) or code == "efl"
            direct = [c for c in competitions if c.get("source_id")]
            left, right = candidates(participants[0], direct), candidates(participants[1], direct)
            # A domestic fallback is explicitly labelled and limited to the same team scope.
            fallback = [c for c in catalogue if c.get("sport_id") == "soccer"
                        and _scope(c.get("code")) == _scope(code)
                        and FEEDS.get(c.get("source_id"), {}).get("scope", "domestic") == "domestic"
                        and c.get("code") not in {"uel", "lib", "sud", "acle", "u20wwc", "efl"}]
            if soccer and code == "efl":
                fallback = [c for c in fallback if c.get("code") in {"epl", "elc", "enl"} or c.get("source_id") in {"espn-soccer-el1", "espn-soccer-el2"}]
                if not left:
                    left = candidates(participants[0], fallback, True)
                if not right:
                    right = candidates(participants[1], fallback, True)
            a, conflict_a = select(left)
            b, conflict_b = select(right)
            # Prefer one common provider when it is valid and unique for each side.
            pairs = [(x, y) for x in left for y in right if compatible(x, y) and usable(x) and usable(y)]
            for source in sorted({x["source_id"] for x, _ in pairs}, key=source_priority):
                options = [(x, y) for x, y in pairs if x["source_id"] == source]
                if len(options) == 1:
                    a, b = options[0]
                    conflict_a = conflict_b = False
                    break
            comparable = bool(a and b and compatible(a, b) and usable(a) and usable(b)
                              and a["canonical_id"] != b["canonical_id"])
            result["comparable"] = comparable
            statuses = []
            for side, raw, selected, conflict, options in (
                ("a", participants[0], a, conflict_a, left),
                ("b", participants[1], b, conflict_b, right),
            ):
                status = ("SOURCE_CONFLICT" if conflict else
                          "NO_PUBLISHED_RANK" if selected and not numeric(selected.get("rank")) else
                          "VALID" if selected and usable(selected) else
                          "FEED_FAILED" if selected and selected["source_status"] == "failed" else
                          "STALE" if selected else missing_status(competitions))
                statuses.append(status)
                result["team_details"][side] = {
                    "raw_name": raw, "status_code": status, "remedy": REMEDIES[status],
                    "selected": selected,
                    "candidates": [{k: r.get(k) for k in ("name", "canonical_id", "source_id", "group", "season", "rank", "source_status")}
                                   for r in options],
                }
                if selected:
                    result[f"team_{side}"] = selected["name"]
            if comparable:
                result["status_code"] = "VALID"
                result["match_status"] = "matched"
            elif a and b and all(usable(x) for x in (a, b)):
                result["status_code"] = "NOT_COMPARABLE"
            else:
                result["status_code"] = next((s for s in statuses if s != "VALID"), "SOURCE_CONFLICT")
                if "SOURCE_CONFLICT" in statuses:
                    result["match_status"] = "ambiguous"
            if a or b:
                for output_key, key in (("ranking", "rank"), ("rating", "rating"), ("points", "points")):
                    av, bv = _metric(a, key) if a else None, _metric(b, key) if b else None
                    result[output_key] = {"team_a": av, "team_b": bv,
                                         "delta": round(av - bv, 6) if comparable and av is not None and bv is not None else None}
                primary = a or b
                result.update({k: primary.get(k) for k in ("competition_id", "competition", "source_as_of")})
            for c in direct:
                snap = snapshots.get(c["source_id"])
                result["source_diagnostics"].append({
                    "source_id": c["source_id"], "status": source_status(snap, c["source_id"]),
                    "error": getattr(snap, "error", None), "published_rows": len(snap.rows) if snap else 0,
                    "last_success": _iso(getattr(snap, "successful_at", None)),
                })
        elif participants:
            result["status_code"] = "INVALID_PARTICIPANT"
        result["explanation"] = REMEDIES[result["status_code"]]
        comparisons[event.market_id] = result

    counts = Counter(c["status_code"] for c in comparisons.values())
    tags = {}
    for code in {c["code"] for c in comparisons.values()}:
        rows = [c for c in comparisons.values() if c["code"] == code]
        tags[code or "unknown"] = {"total": len(rows), "statuses": dict(Counter(c["status_code"] for c in rows))}
    return {"comparisons": comparisons, "coverage": {"total": len(comparisons), "statuses": dict(counts), "tags": tags},
            "resolution_version": RESOLUTION_VERSION, "generated_at": generated}
