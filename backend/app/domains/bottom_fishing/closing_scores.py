"""Complete missing financial contributions without repeating the closing market scan."""
import asyncio
import json
from datetime import datetime

import httpx
from sqlalchemy import select

from app.domains.auth.models import ActivityLog
from . import market, store
from .strategy import fundamental_factors, clamp

TECHNICAL = {"strength", "proximity", "bounce", "recovery"}


def waiting(state):
    return [row for row in state.get("rows", []) if row.get("score") is None
            and row.get("reason", "").startswith("Missing ")
            and TECHNICAL.issubset(row.get("points", {}))]


async def recover(sessions, owner, previous_id, output, cache):
    state = output["state"]
    rows = waiting(state)
    if not rows:
        return
    key = f"bottom:closing-finance:v1:{owner}:{state['market_as_of']}:{output['version']}"
    if not await cache.set(key+":interval", "1", ex=180, nx=True):
        return
    attempts = await cache.incr(key)
    await cache.expire(key, 86400)
    if attempts > 8:
        return
    wanted = {r["symbol"] for r in rows}
    session = state["market_as_of"][:10]
    saved = {}
    async with sessions() as db:
        records = await db.scalars(select(ActivityLog.details).where(ActivityLog.user_id==owner,
            ActivityLog.action==store.LIVE, ActivityLog.id<previous_id).order_by(ActivityLog.id.desc()).limit(100))
        for raw in records:
            prior = json.loads(raw).get("state", {})
            if prior.get("market_as_of", "")[:10] != session:
                continue
            for r in prior.get("rows", []):
                symbol, facts = r["symbol"], r.get("financials")
                isin = state.get("setups", {}).get(symbol, {}).get("isin")
                if symbol not in wanted or symbol in saved or not isin or not facts:
                    continue
                if prior.get("setups", {}).get(symbol, {}).get("isin") == isin and not fundamental_factors(facts)[1]:
                    saved[symbol] = facts
    changed = False
    weights = output["settings"]["weights"]
    async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
        for r in rows:
            facts = saved.get(r["symbol"])
            if facts is None:
                try:
                    facts = await market.facts(client, cache, r["symbol"])
                except (httpx.HTTPError, ValueError, IndexError, KeyError):
                    continue
            factors, missing = fundamental_factors(facts)
            if missing:
                continue
            points = dict(r["points"])
            points.update({k:round(clamp(v)*weights[k],4) for k,v in factors.items()})
            score = round(sum(points.values()),2)
            r.update(points=points, score=score, financials=facts,
                     reason="Score below 70" if score<70 else "Closing score only")
            changed = True
    if not changed:
        return
    state["rows"].sort(key=lambda r:-(r.get("score") or 0))
    if not any(r.get("reason","").startswith("Missing ") for r in state["rows"]):
        state["score_status"] = "completed"
        state["status"] = state["screen_status"]
    state["scored_at"] = datetime.now(market.INDIA).isoformat()
    output["finished_at"] = state["scored_at"]
    async with sessions() as db:
        await store.lock(db, owner)
        live_id, _ = await store.latest(db,owner,store.LIVE,{})
        version, _ = await store.latest(db,owner,store.CONFIG,{})
        if live_id == previous_id and version == output["version"]:
            store.append(db, owner, store.LIVE, output)
            await db.commit()
