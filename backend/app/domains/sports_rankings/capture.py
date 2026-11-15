"""Freeze reference evidence at scan time; never fetch a provider during a run."""
from collections import Counter

from .catalogue import CATALOGUE
from .comparisons import RESOLUTION_VERSION
from .schemas import EventComparisonsQuery
from .service import event_comparisons


def annotate_candidates(candidates, snapshots):
    sports = [row for row in candidates if row.get("sports_event_slug")]
    counts = Counter()
    for offset in range(0, len(sports), 200):
        batch = sports[offset:offset + 200]
        query = EventComparisonsQuery(events=[dict(
            market_id=row["market_id"], event_slug=row["sports_event_slug"],
            event_title=row.get("sports_event_title"),
        ) for row in batch])
        result = event_comparisons(query, snapshots, CATALOGUE)
        for row in batch:
            # Existing evidence must not be overwritten by a resumed scan.
            if row.get("sports_ranking_at_scan") is None:
                evidence = result["comparisons"][row["market_id"]]
                evidence["view"] = "at_scan"
                row["sports_ranking_at_scan"] = evidence
            counts[row["sports_ranking_at_scan"]["status_code"]] += 1
    return {"resolution_version": RESOLUTION_VERSION, "total": len(sports), "statuses": dict(counts)}


def capture_candidate_rankings(candidates):
    from sqlalchemy import select
    from app.infrastructure.database.sync_session import SyncSessionLocal
    from .models import SportsRankingSnapshot

    source_ids = {c["source_id"] for c in CATALOGUE if c.get("source_id")}
    with SyncSessionLocal() as db:
        snapshots = {s.source_id: s for s in db.scalars(
            select(SportsRankingSnapshot).where(SportsRankingSnapshot.source_id.in_(source_ids))
        ).all()}
        return annotate_candidates(candidates, snapshots)
