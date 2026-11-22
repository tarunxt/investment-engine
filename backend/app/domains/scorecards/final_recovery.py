"""Select terminal descendants of the exact outputs pinned by a saved calculation."""
from sqlalchemy import select
from . import storage


def preserves_scores(previous, candidate):
    if previous.get("stage4_method") != candidate.get("stage4_method"):
        return False
    if (previous.get("pair_counts") or {}).get("mode") != (candidate.get("pair_counts") or {}).get("mode"):
        return False
    before = {row["listing"]: row for row in previous["rows"]}
    after = {row["listing"]: row for row in candidate["rows"]}
    if before.keys() != after.keys() or len(after) != len(candidate["rows"]):
        return False
    for key, old in before.items():
        new = after[key]
        if any(old.get(field) is not None and new.get(field) is None for field in ("score", "legacy_score")):
            return False
        if old.get("coverage") == "Complete" and new.get("coverage") != "Complete":
            return False
        if new.get("valid", 0) < old.get("valid", 0):
            return False
        if any(value is not None and (new.get("terms") or {}).get(k) is None for k, value in (old.get("terms") or {}).items()):
            return False
    return True


async def recovered_outputs(db, workflow_id, revision, selected):
    """Unrelated reruns and overlapping trial schedules cannot replace chosen inputs."""
    if not selected:
        return selected
    stage = storage.Stage
    data = stage.summary_json
    links = (await db.execute(select(stage.id, data["card"].as_string(), data["recovered_from"].as_integer(),
                                    data["settings"]["parent"].as_integer()).where(
        stage.workflow_id == workflow_id, storage.of_kind("attempt", revision),
        stage.id > min(doc.id for doc in selected.values()),
        stage.status.in_(("completed", "partial", "unassessed"))).order_by(stage.id))).all()
    roots = {doc.id: card for card, doc in selected.items()}
    best = dict(selected)
    for output_id, card, recovered, parent in links:
        if roots.get(recovered or parent) != card or card not in best:
            continue
        roots[output_id] = card
        doc = storage.Document(await db.get(stage, output_id))
        if doc.result_json and preserves_scores(best[card].result_json, doc.result_json):
            best[card] = doc
    return best
