from datetime import UTC, datetime, timedelta
from difflib import SequenceMatcher
import re

from .catalogue import ALIASES, CATALOGUE, normalize_name, participant_aliases, source_kind
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
    code = competition.get("code", "")
    rows = [{**r, "imported_names": []} for r in (snapshot.rows if snapshot else [])]
    for participant in competition["participants"]:
        names = [
            participant["name"],
            *participant_aliases(
                code, participant["name"], participant.get("aliases", [])
            ),
        ]
        matches = _matching_rows(names, rows, code)
        if len(matches) == 1:
            matches[0]["imported_names"].append(participant["name"])
        else:
            rows.append({"name": participant["name"], "rank": None, "points": None, "imported_names": [participant["name"]], "match_status": "ambiguous" if matches else "unmatched"})
    return rows


_TEAM_DESIGNATORS = {
    "ac", "afc", "as", "bk", "bsc", "cd", "cf", "fc", "fk", "if", "kaa",
    "krc", "kv", "nk", "osc", "rc", "rcd", "sc", "sk", "sl", "ssc", "sv",
    "ud", "us", "vfb", "vfl",
}
_TEAM_WORD_EQUIVALENTS = {
    "athletic": "ath", "athletico": "ath", "atletico": "ath", "atlético": "ath",
    "manchester": "man", "saint": "st", "sankt": "st",
}
_TEAM_SCOPE_QUALIFIERS = {
    "academy", "b", "ii", "ladies", "lfc", "reserves", "u17", "u18", "u19",
    "u20", "u21", "u23", "women", "womens", "wfc",
}


def _base_team_name_keys(value):
    tokens = normalize_name(value).split()
    if not tokens:
        return set()
    keys = {" ".join(tokens)}
    while tokens and tokens[0] in _TEAM_DESIGNATORS:
        tokens.pop(0)
    while tokens and tokens[-1] in _TEAM_DESIGNATORS:
        tokens.pop()
    if not tokens:
        return keys
    keys.add(" ".join(tokens))
    equivalent = [_TEAM_WORD_EQUIVALENTS.get(token, token) for token in tokens]
    keys.add(" ".join(equivalent))
    if 2 <= len(equivalent) <= 6:
        initials = "".join(token if len(token) <= 3 else token[0] for token in equivalent)
        if len(initials) >= 2:
            keys.add(initials)
    keys.update(key.replace(" ", "") for key in list(keys) if len(key) >= 5)
    return {key for key in keys if key}


def _team_name_keys(value, code=None, *, include_global=False):
    family = {value}
    mappings = [ALIASES.get(code, {})] if code else []
    # Cross-competition fallback is needed for cup/continental tags whose
    # provider row comes from a domestic table (for example Wolves).
    if include_global:
        mappings.extend(mapping for mapped_code, mapping in ALIASES.items() if mapped_code != code)
    normalized = normalize_name(value)
    for mapping in mappings:
        for canonical, aliases in mapping.items():
            values = [canonical, *aliases]
            if normalized in {normalize_name(candidate) for candidate in values}:
                family.update(values)
    keys = set()
    for candidate in family:
        keys.update(_base_team_name_keys(candidate))
    return keys


def _compatible_team_scope(left, right):
    left_scope = set(normalize_name(left).split()).intersection(_TEAM_SCOPE_QUALIFIERS)
    right_scope = set(normalize_name(right).split()).intersection(_TEAM_SCOPE_QUALIFIERS)
    return left_scope == right_scope


def _matching_rows(names, rows, code, *, include_global=False):
    query_keys = set()
    for name in names:
        query_keys.update(_team_name_keys(name, code, include_global=include_global))
    exact = [
        row for row in rows
        if query_keys.intersection(_team_name_keys(row["name"], code, include_global=include_global))
    ]
    if exact:
        return exact

    # A conservative unique fuzzy fallback catches punctuation, shortened
    # legal names and provider abbreviations not yet seen in the alias file.
    scored = []
    for row in rows:
        if not any(_compatible_team_scope(name, row["name"]) for name in names):
            continue
        row_keys = _team_name_keys(row["name"], code, include_global=include_global)
        score = max(
            (SequenceMatcher(None, left, right).ratio() for left in query_keys for right in row_keys),
            default=0.0,
        )
        scored.append((score, row))
    scored.sort(key=lambda item: item[0], reverse=True)
    if not scored or scored[0][0] < 0.88:
        return []
    if len(scored) > 1 and scored[0][0] - scored[1][0] < 0.08:
        return []
    return [scored[0][1]]


def resolve(query, snapshots, catalogue=None):
    candidates = []
    for c in catalogue or CATALOGUE:
        if c["code"] != query.code or (query.competition_id and c["id"] != query.competition_id):
            continue
        snap = snapshots.get(c["source_id"])
        rows = ranking_rows(c, snap)
        matched_rows = _matching_rows([query.name], rows, c["code"])
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


def _resolve_sport(name, sport_id, snapshots, catalogue=None):
    """Resolve a participant across one sport without crossing ranking sources."""
    candidates = []
    for competition in catalogue or CATALOGUE:
        if competition.get("sport_id") != sport_id or not competition.get("source_id"):
            continue
        snapshot = snapshots.get(competition["source_id"])
        if snapshot is None:
            continue
        rows = ranking_rows(competition, snapshot)
        matched = [
            row for row in _matching_rows(
                [name], rows, competition["code"], include_global=True
            )
            if not row.get("match_status")
        ]
        for row in matched:
            candidates.append({
                "competition_id": competition["id"], "competition": competition["name"],
                "code": competition["code"], "source_id": competition["source_id"],
                "status": source_status(snapshot, competition["source_id"]),
                "ranking_kind": source_kind(competition["source_id"]),
                "source_as_of": snapshot.source_as_of, **row,
            })
    unique = {}
    for row in candidates:
        key = (row["source_id"], row.get("group"), normalize_name(row["name"]), row.get("roster"), row.get("rank"))
        if key not in unique:
            unique[key] = {**row, "competition_ids": [row["competition_id"]]}
        else:
            unique[key]["competition_ids"].append(row["competition_id"])
    return list(unique.values())


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
    if value is None and key == "rating" and (row.get("source_id") or "").startswith("football-data-"):
        points, played = row.get("points"), row.get("played")
        if isinstance(points, (int, float)) and isinstance(played, (int, float)) and played > 0:
            value = round(points / (played * 3) * 100, 2)
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _compatible_pairs(left, right):
    pairs = []
    for team_a in left:
        for team_b in right:
            same_source = team_a.get("source_id") and team_a.get("source_id") == team_b.get("source_id")
            if same_source:
                pairs.append((team_a, team_b))
    unique = {}
    for team_a, team_b in pairs:
        key = (
            team_a.get("source_id") or team_a["competition_id"], normalize_name(team_a["name"]),
            normalize_name(team_b["name"]), team_a.get("rank"), team_b.get("rank"),
            team_a.get("rating"), team_b.get("rating"), team_a.get("points"), team_b.get("points"),
        )
        unique.setdefault(key, (team_a, team_b))
    return list(unique.values())


def event_comparisons(query: EventComparisonsQuery, snapshots, catalogue=None):
    catalogue = catalogue or CATALOGUE
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

        left = resolve(RankingQuery(code=code, name=participants[0]), snapshots, catalogue)["candidates"]
        right = resolve(RankingQuery(code=code, name=participants[1]), snapshots, catalogue)["candidates"]
        pairs = _compatible_pairs(left, right)
        soccer_codes = {
            competition["code"] for competition in catalogue
            if competition.get("sport_id") == "soccer" and competition["code"]
        } | {"efl"}
        if not pairs and code in soccer_codes:
            # A cup/continental tag may not have a useful table of its own. Use
            # domestic standings only when both teams resolve uniquely to the
            # same published source; never compare unrelated league tables.
            left = _resolve_sport(participants[0], "soccer", snapshots, catalogue)
            right = _resolve_sport(participants[1], "soccer", snapshots, catalogue)
            pairs = _compatible_pairs(left, right)
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
