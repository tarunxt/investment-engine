from datetime import UTC, datetime, timedelta

from .catalogue import CATALOGUE, normalize_name, source_kind
from .feeds import FEEDS


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


def resolve(query, snapshots):
    candidates = []
    for c in CATALOGUE:
        if c["code"] != query.code or (query.competition_id and c["id"] != query.competition_id):
            continue
        snap = snapshots.get(c["source_id"])
        for row in ranking_rows(c, snap):
            if normalize_name(query.name) in {normalize_name(n) for n in [row["name"], *row["imported_names"]]}:
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
