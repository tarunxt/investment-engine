from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from .catalogue import CATALOGUE, REFRESH_SECONDS, SOURCE_IDS
from .models import SportsRankingSnapshot
from .schemas import RankingQuery, RefreshRequest
from .service import ranking_rows, resolve, summary
from .master import SPORTS
from .classification import MatchCandidate, classify

router = APIRouter(prefix="/api/sports-rankings", tags=["sports-rankings"], dependencies=[Depends(get_current_user)])


@router.get("")
async def catalogue(response: Response, db: AsyncSession = Depends(get_async_db)):
    response.headers["Cache-Control"] = "private, no-store"
    snapshots = {s.source_id: s for s in (await db.scalars(select(SportsRankingSnapshot))).all()}
    return {"schema_version": 2, "sports": SPORTS, "refresh_seconds": REFRESH_SECONDS, "automatic_analysis_enabled": False, "competitions": [summary(c, snapshots.get(c["source_id"])) for c in CATALOGUE]}


@router.post("/classify")
async def classify_match(query: MatchCandidate):
    return classify(query)


@router.get("/competitions/{competition_id}")
async def competition(competition_id: str, response: Response, db: AsyncSession = Depends(get_async_db)):
    response.headers["Cache-Control"] = "private, no-store"
    c = next((c for c in CATALOGUE if c["id"] == competition_id), None)
    if c is None:
        raise HTTPException(404, "Competition not found")
    snap = await db.get(SportsRankingSnapshot, c["source_id"]) if c["source_id"] else None
    return {**summary(c, snap), "rows": ranking_rows(c, snap)}


@router.post("/resolve")
async def resolve_name(query: RankingQuery, db: AsyncSession = Depends(get_async_db)):
    snapshots = {s.source_id: s for s in (await db.scalars(select(SportsRankingSnapshot))).all()}
    return resolve(query, snapshots)


@router.post("/refresh", status_code=202)
async def refresh(query: RefreshRequest):
    if query.source_id not in SOURCE_IDS:
        raise HTTPException(422, "No supported feed for this source")
    # Rate-limit enqueue operations, not only worker executions.
    from redis.asyncio import Redis
    from app.core.config import settings
    from .tasks import refresh_source
    import asyncio
    async with Redis.from_url(settings.redis_url, socket_timeout=2, socket_connect_timeout=2) as redis:
        if not await redis.set(f"sports-rankings:enqueue:{query.source_id}", "1", nx=True, ex=60):
            raise HTTPException(429, "Refresh already requested; try again in one minute", headers={"Retry-After": "60"})
    try:
        await asyncio.to_thread(refresh_source.apply_async, args=[query.source_id], retry=False)
    except Exception as exc:
        from app.core.logging import get_logger
        get_logger(__name__).exception("Sports ranking enqueue failed")
        raise HTTPException(503, "Refresh queue unavailable") from exc
    return {"status": "queued", "source_id": query.source_id}


@router.post("/cricket/reconcile", status_code=202)
async def reconcile_all_cricket():
    from redis.asyncio import Redis
    from app.core.config import settings
    from .tasks import reconcile_cricket
    from .feeds import CRICKET_SOURCE_IDS
    import asyncio
    try:
        async with Redis.from_url(settings.redis_url, socket_timeout=2, socket_connect_timeout=2) as redis:
            if not await redis.set("sports-rankings:enqueue:cricket-all", "1", nx=True, ex=60):
                raise HTTPException(429, "Cricket reconciliation already requested", headers={"Retry-After": "60"})
        await asyncio.to_thread(reconcile_cricket.apply_async, retry=False)
    except HTTPException:
        raise
    except Exception as exc:
        from app.core.logging import get_logger
        get_logger(__name__).exception("Cricket reconciliation enqueue failed")
        raise HTTPException(503, "Cricket reconciliation queue unavailable") from exc
    return {"status": "queued", "sources": len(CRICKET_SOURCE_IDS)}
