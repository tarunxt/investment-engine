from datetime import UTC, datetime, timedelta
import re

from .catalogue import CATALOGUE, normalize_name, source_kind
from .feeds import FEEDS
from .schemas import EventComparisonsQuery, RankingQuery


def source_status(snapshot, source_id):
    if not source_id:
        return "unavailable"
    if snapshot is None:
        return "pending"
    checked = snapshot.checked_at
    if checked and checked.tzinfo is None:
        checked = checked.replace(tzinfo=UTC)
    if not checked or checked < datetime.now(UTC) - timedelta(hours=1):
        return "stale"
    return snapshot.status


def summary(competition, snapshot=None):
    source_id = competition["source_id"]
    return {
        **competition,
        "status": source_status(snapshot, source_id),
        "ranking_kind": source_kind(source_id),
        "source_url": snapshot.source_url if snapshot else None,
        "source_as_of": snapshot.source_as_of if snapshot else None,
        "season": snapshot.season if snapshot else None,
        "checked_at": snapshot.checked_at if snapshot else None,
        "successful_at": snapshot.successful_at if snapshot else None,
        "error": snapshot.error if snapshot else None,
        "ranked_count": len(snapshot.rows) if snapshot else 0,
        "note": (
            FEEDS[source_id]["note"] if source_id in FEEDS else
            "Calculated from completed results: 3 points per win, 1 per draw; sorted by points, goal difference, goals scored. Excludes deductions, head-to-head rules and playoff adjustments. Not official standings."
            if (source_id or "").startswith("football-data-") else
            "Game-wide ranking; a published team is not necessarily entered in this tournament."
            if source_id == "valve-global" else
            "No validated automatic ranking feed is connected for this scope. Open the source for its ranking or competition results. No numeric positions are invented."
        ),
    }


def ranking_rows(competition, snapshot=None):
    rows = [{**r, "imported_names": []} for r in (snapshot.rows if snapshot else [])]
    for participant in competition["participants"]:
        names = {normalize_name(n) for n in [participant["name"], *participant["aliases"]]}
        matches = [r for r in rows if normalize_name(r["name"]) in names]
        if len(matches) == 1:
            matches[0]["imported_names"].append(participant["name"])
        else:
            rows.append({"name": participant["name"], "rank": None, "points": None, "imported_names": [participant["name"]], "match_status": "ambiguous" if matches else "unmatched"})
    return rows


_TEAM_DESIGNATORS = {"ac", "afc", "cf", "fc", "fk", "sc"}


def _team_name_key(value):
    tokens = normalize_name(value).split()
    while tokens and tokens[0] in _TEAM_DESIGNATORS:
        tokens.pop(0)
    while tokens and tokens[-1] in _TEAM_DESIGNATORS:
        tokens.pop()
    return " ".join(tokens)


def resolve(query, snapshots):
    candidates = []
    for c in CATALOGUE:
        if c["code"] != query.code or (query.competition_id and c["id"] != query.competition_id):
            continue
        snap = snapshots.get(c["source_id"])
        rows = ranking_rows(c, snap)
        exact = [row for row in rows if normalize_name(query.name) in {normalize_name(n) for n in [row["name"], *row["imported_names"]]}]
        matched_rows = exact or [
            row for row in rows
            if not row.get("match_status")
            and _team_name_key(query.name) in {_team_name_key(n) for n in [row["name"], *row["imported_names"]]}
        ]
        for row in matched_rows:
            candidates.append({"competition_id": c["id"], "competition": c["name"], "code": c["code"], "source_id": c["source_id"], "status": source_status(snap, c["source_id"]), "ranking_kind": source_kind(c["source_id"]), "source_as_of": snap.source_as_of if snap else None, **row})
    # A master list and an imported tournament can refer to the same source row.
    # Collapse only identical source identities; never merge rating systems/groups.
    unique = {}
    for row in candidates:
        key = (row['source_id'] or row['competition_id'], row.get('group'), normalize_name(row['name']), row.get('roster'), row.get('rank'))
        if key not in unique:
            unique[key] = {**row, 'competition_ids': [row['competition_id']]}
        else:
            unique[key]['competition_ids'].append(row['competition_id'])
    candidates = list(unique.values())
    return {"match_status": "matched" if len(candidates) == 1 else "ambiguous" if candidates else "unmatched", "candidates": candidates, "automatic_analysis_enabled": False}


def _head_to_head_participants(title):
    if not title:
        return None
    parts = re.split(r"\s+(?:vs\.?|v\.?|@)\s+", title.strip(), maxsplit=1, flags=re.IGNORECASE)
    return (parts[0].strip(), parts[1].strip()) if len(parts) == 2 and all(parts) else None


def _market_code(slug):
    match = re.match(r"^([a-z0-9]+)-", (slug or "").strip().lower())
    return match.group(1) if match else None


def _metric(row, key):
    value = row.get(key)
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def event_comparisons(query: EventComparisonsQuery, snapshots):
    comparisons = {}
    for event in query.events:
        code = _market_code(event.event_slug)
        participants = _head_to_head_participants(event.event_title)
        base = {
            "market_id": event.market_id,
            "code": code,
            "tags": [code] if code else [],
            "team_a": participants[0] if participants else None,
            "team_b": participants[1] if participants else None,
            "match_status": "unmatched",
            "ranking": None,
            "rating": None,
            "points": None,
            "competition_id": None,
            "competition": None,
            "source_as_of": None,
        }
        if not code or not participants:
            comparisons[event.market_id] = base
            continue

        left = resolve(RankingQuery(code=code, name=participants[0]), snapshots)["candidates"]
        right = resolve(RankingQuery(code=code, name=participants[1]), snapshots)["candidates"]
        pairs = []
        for team_a in left:
            for team_b in right:
                left_ids = set(team_a.get("competition_ids", [team_a["competition_id"]]))
                right_ids = set(team_b.get("competition_ids", [team_b["competition_id"]]))
                same_source = team_a.get("source_id") and team_a.get("source_id") == team_b.get("source_id")
                if same_source or left_ids.intersection(right_ids):
                    pairs.append((team_a, team_b))

        unique = {}
        for team_a, team_b in pairs:
            key = (
                team_a.get("source_id") or team_a["competition_id"], normalize_name(team_a["name"]),
                normalize_name(team_b["name"]), team_a.get("rank"), team_b.get("rank"),
                team_a.get("rating"), team_b.get("rating"), team_a.get("points"), team_b.get("points"),
            )
            unique.setdefault(key, (team_a, team_b))
        pairs = list(unique.values())
        if len(pairs) != 1:
            base["match_status"] = "ambiguous" if pairs or left or right else "unmatched"
            comparisons[event.market_id] = base
            continue

        team_a, team_b = pairs[0]
        shared_ids = sorted(set(team_a.get("competition_ids", [])).intersection(team_b.get("competition_ids", [])))
        competition_id = shared_ids[0] if shared_ids else team_a["competition_id"]
        base.update({
            "match_status": "matched",
            "team_a": team_a["name"],
            "team_b": team_b["name"],
            "competition_id": competition_id,
            "competition": team_a["competition"],
            "source_as_of": team_a.get("source_as_of"),
        })
        for output_key in ("ranking", "rating", "points"):
            source_key = "rank" if output_key == "ranking" else output_key
            a_value, b_value = _metric(team_a, source_key), _metric(team_b, source_key)
            base[output_key] = {
                "team_a": a_value,
                "team_b": b_value,
                "delta": a_value - b_value if a_value is not None and b_value is not None else None,
            }
        comparisons[event.market_id] = base
    return {"comparisons": comparisons}
