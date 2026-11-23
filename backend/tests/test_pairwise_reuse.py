from datetime import datetime
import pytest

from app.domains.scorecards import storage
from app.domains.scorecards.technical_history import pairwise_prior_bars
from app.domains.scorecards.technical_sources import session_calendar
from test_auto_rebalance_audit_durability import audit_db, anyio_backend


@pytest.mark.anyio
async def test_reuse_exact_listing_closes_from_an_earlier_workflow(audit_db):
    cutoff = datetime.fromisoformat("2026-11-23T16:30:00+05:30")
    calendar = session_calendar(cutoff, "NSE", [], 6)
    key = "NSE:TEST"
    source = {"instrument":"ISIN1", "action_url":"https://example.org/actions"}
    bars = [{"kind":"daily_bar", "as_of":end, "isin":"ISIN1", "url":"https://example.org/price"}
            for end in calendar.values()]
    research = {"version":3, "technical":{key:{"coverage":"Partial", "sources":{"stock":source}}},
                "listings":{key:[*bars, {**bars[-1], "isin":"INVALID"}]}}
    manifest = {"owner_id":7, "sequence":43, "as_of":cutoff.isoformat()}
    async with audit_db.sessions() as db:
        packet = await storage.append(db,7001,"packet","test",{"research":research},revision_id=1)
        packet.row.created_at = datetime(2026,11,23,10,45)
        await db.commit()
        reused = await pairwise_prior_bars(db,manifest,[key,"BSE:TEST"])
        assert list(reused) == [key]
        assert len(reused[key]["bars"]) == 6 and reused[key]["matched"] == 6
        assert all(r["reused_workflow"] == 42 for r in reused[key]["bars"])
        assert not await pairwise_prior_bars(db,{**manifest,"owner_id":8},[key])
        assert not await pairwise_prior_bars(db,{**manifest,"sequence":42},[key])
