"""Rolling cache of dated public documents and exact-venue daily observations."""
import json
from datetime import datetime, timedelta

from redis.exceptions import RedisError
from app.domains.zerodha.upstox_quote_guard import redis_client

TTL = 91 * 86400
PREFIX = "threats:public:v1:"


def scope_for(stock):
    return "issuer:" + stock["listing"]


async def load(scopes, cutoff):
    """A point-in-time query cannot see documents published beyond its cutoff."""
    earliest = (cutoff - timedelta(days=90)).timestamp()
    try:
        async with redis_client() as client:
            async with client.pipeline(transaction=False) as pipeline:
                for scope in scopes:
                    pipeline.zrevrangebyscore(PREFIX + scope, cutoff.timestamp(), earliest, start=0, num=80)
                groups = await pipeline.execute()
        return [(scope, json.loads(member)) for scope, group in zip(scopes, groups) for member in group]
    except (RedisError, OSError, RuntimeError, ValueError):
        return []


async def save(entries):
    if not entries:
        return
    try:
        async with redis_client() as client:
            async with client.pipeline(transaction=False) as pipeline:
                for scope, group in entries.items():
                    key = PREFIX + scope
                    values = {json.dumps(entry, sort_keys=True, separators=(",", ":")):
                              datetime.fromisoformat(entry["doc"]["as_of"]).timestamp() for entry in group}
                    if values:
                        pipeline.zadd(key, values)
                        pipeline.zremrangebyrank(key, 0, -257)
                        pipeline.expire(key, TTL)
                await pipeline.execute()
    except (RedisError, OSError, RuntimeError):
        pass  # Live collection remains available during a cache outage.
