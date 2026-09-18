from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from difflib import SequenceMatcher
import re

from .catalogue import ALIASES, CATALOGUE, normalize_name, participant_aliases, source_kind
from .feeds import FEEDS
from .schemas import EventComparisonsQuery, RankingQuery
from .polymarket_participants import clean_participant_name


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
    matcher = _RowMatcher(rows, code)
    for participant in competition["participants"]:
        if clean_participant_name(participant["name"]) is None:
            continue
        names = [
            participant["name"],
            *participant_aliases(
                code, participant["name"], participant.get("aliases", [])
            ),
        ]
        matches = matcher.match(names, allow_fuzzy=False)
        if len(matches) == 1:
            matches[0]["imported_names"].append(participant["name"])
        else:
            row = {"name": participant["name"], "rank": None, "points": None, "imported_names": [participant["name"]], "match_status": "ambiguous" if matches else "unmatched"}
            rows.append(row)
            # Placeholders never enter the ranking identity index.
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
    keys.update(key.replace(" ", "") for key in list(keys) if len(key) >= 5)
    return {key for key in keys if key}


@lru_cache(maxsize=32768)
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
    return frozenset(keys)


def _compatible_team_scope(left, right):
    left_scope = set(normalize_name(left).split()).intersection(_TEAM_SCOPE_QUALIFIERS)
    right_scope = set(normalize_name(right).split()).intersection(_TEAM_SCOPE_QUALIFIERS)
    return left_scope == right_scope


@lru_cache(maxsize=32768)
def _key_counts(key):
    return Counter(key)


class _RowMatcher:
    """Incremental exact index with a safe upper bound before fuzzy scoring."""

    def __init__(self, rows, code, *, include_global=False):
        self.code = code
        self.include_global = include_global
        self.rows = []
        self.ranked_rows = []
        self.exact = defaultdict(list)
        for row in rows:
            self.add(row)

    def add(self, row):
        keys = set(_team_name_keys(row["name"], self.code, include_global=self.include_global))
        for alias in row.get("provider_aliases", []):
            keys.update(_team_name_keys(alias, self.code, include_global=self.include_global))
        index = len(self.rows)
        self.rows.append((row, keys))
        # Imported placeholders have no validated ranking and must not become
        # fuzzy aliases for another imported team. Keep exact lookup only.
        if not row.get("match_status"):
            self.ranked_rows.append((row, keys))
        for key in keys:
            self.exact[key].append(index)

    def match(self, names, *, allow_fuzzy=True):
        query_keys = set()
        for name in names:
            query_keys.update(_team_name_keys(name, self.code, include_global=self.include_global))
        exact = {index for key in query_keys for index in self.exact.get(key, ())}
        if exact:
            return [self.rows[index][0] for index in sorted(exact)
                    if any(_compatible_team_scope(name, self.rows[index][0]["name"]) for name in names)]
        if not allow_fuzzy:
            return []
        scored = []
        for row, row_keys in self.ranked_rows:
            if not any(_compatible_team_scope(name, row["name"]) for name in names):
                continue
            score = 0.0
            for left in query_keys:
                for right in row_keys:
                    total = len(left) + len(right)
                    # Scores below .80 can neither win (.88) nor make an
                    # accepted winner ambiguous (margin .08). Both bounds
                    # dominate SequenceMatcher.ratio, so matching is unchanged.
                    if not total or 2 * min(len(left), len(right)) < .799999999999 * total:
                        continue
                    left_counts, right_counts = _key_counts(left), _key_counts(right)
                    overlap = sum(min(count, right_counts.get(char, 0)) for char, count in left_counts.items())
                    if 2 * overlap < .799999999999 * total:
                        continue
                    score = max(score, SequenceMatcher(None, left, right).ratio())
            if score >= .799999999999:
                scored.append((score, row))
        scored.sort(key=lambda item: item[0], reverse=True)
        if not scored or scored[0][0] < .88:
            return []
        if len(scored) > 1 and scored[0][0] - scored[1][0] < .08:
            return []
        return [scored[0][1]]


def _matching_rows(names, rows, code, *, include_global=False):
    return _RowMatcher(rows, code, include_global=include_global).match(names)


def _ranking_rows_cached(competition, snapshot, rows_cache):
    if rows_cache is None:
        return ranking_rows(competition, snapshot)
    key = id(competition)
    if key not in rows_cache:
        rows_cache[key] = ranking_rows(competition, snapshot)
    return rows_cache[key]


def resolve(query, snapshots, catalogue=None, *, rows_cache=None):
    candidates = []
    for c in catalogue or CATALOGUE:
        if c["code"] != query.code or (query.competition_id and c["id"] != query.competition_id):
            continue
        snap = snapshots.get(c["source_id"])
        rows = _ranking_rows_cached(c, snap, rows_cache)
        matched_rows = _RowMatcher(rows, c["code"]).match(
            [query.name, *participant_aliases(c["code"], query.name)], allow_fuzzy=False
        )
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


def _resolve_sport(name, sport_id, snapshots, catalogue=None, *, rows_cache=None):
    """Resolve a participant across one sport without crossing ranking sources."""
    candidates = []
    for competition in catalogue or CATALOGUE:
        if competition.get("sport_id") != sport_id or not competition.get("source_id"):
            continue
        snapshot = snapshots.get(competition["source_id"])
        if snapshot is None:
            continue
        rows = _ranking_rows_cached(competition, snapshot, rows_cache)
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
    # One resolver serves live history, source diagnostics and frozen run evidence.
    from .comparisons import compare_events
    return compare_events(query, snapshots, CATALOGUE if catalogue is None else catalogue)
