"""Redis-coordinated, fail-closed budget and display cache for Upstox full quotes.

All processes must use the same existing REDIS_URL. No local fallback is safe.
Cache values retain exchange time and original retrieval time, never execution data.
"""
import asyncio
import hashlib
import json
import logging
import math
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from uuid import uuid4

from redis.asyncio import Redis

logger = logging.getLogger(__name__)
LIMITS = ((1000, 20), (60_000, 200), (1_800_000, 1000))
CACHE_SECONDS = 5
FAILURE_SECONDS = 2
LOCK_MS = 20_000  # exceeds the provider's 15-second overall deadline

# Redis TIME provides one clock for all processes. All windows are sliding, not
# fixed buckets; quota is consumed BEFORE dispatch, including failed requests.
ADMIT = """
local t = redis.call('TIME')
local now = t[1]*1000 + math.floor(t[2]/1000)
local previous = redis.call('GET',KEYS[4])
if not previous then
 redis.call('SET',KEYS[4],now)
 redis.call('SET',KEYS[2],'1','PX',1800000,'NX')
 redis.call('HINCRBY',KEYS[3],'history_warmup',1)
end
if redis.call('EXISTS',KEYS[2]) == 1 then
 redis.call('HINCRBY',KEYS[3],'backoff_blocked',1); return 0
end
if previous and redis.call('ZCARD',KEYS[1]) == 0 and now-tonumber(previous) < 1800000 then
 redis.call('SET',KEYS[2],'1','PX',1800000-(now-tonumber(previous)))
 redis.call('HINCRBY',KEYS[3],'history_warmup',1); return 0
end
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-1800000)
for i=2,#ARGV,2 do
 if redis.call('ZCOUNT',KEYS[1], '('..(now-tonumber(ARGV[i])), '+inf') >= tonumber(ARGV[i+1]) then
  redis.call('HINCRBY',KEYS[3],'quota_blocked',1); return 0
 end
end
redis.call('ZADD',KEYS[1],now,ARGV[1])
redis.call('SET',KEYS[4],now)
redis.call('PEXPIRE',KEYS[1],1800001)
redis.call('HINCRBY',KEYS[3],'admitted',1)
return 1
"""
RELEASE = """
if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end
return 0
"""
BACKOFF = """
local remaining = redis.call('PTTL',KEYS[1])
if remaining < tonumber(ARGV[1]) then redis.call('SET',KEYS[1],'1','PX',ARGV[1]) end
redis.call('HINCRBY',KEYS[2],'provider_429',1)
return 1
"""


def retry_after_seconds(value, now=None):
    """Honor numeric or HTTP-date Retry-After; malformed/missing => 60 seconds."""
    now = now or datetime.now(timezone.utc)
    try:
        delay = float(value)
    except (ValueError, TypeError):
        try:
            delay = (parsedate_to_datetime(value) - now).total_seconds()
        except (ValueError, TypeError, OverflowError):
            delay = 60
    if not math.isfinite(delay):
        delay = 60
    return max(60, math.ceil(min(delay, 2_147_483_647)))


def redis_client():
    # Reuse existing deployment infrastructure, without importing DB settings.
    import os
    url = os.getenv('REDIS_URL')
    if not url:
        raise RuntimeError('Shared quote coordination unavailable')
    return Redis.from_url(url, socket_connect_timeout=0.5, socket_timeout=0.5,
                          decode_responses=True)


class QuoteGuard:
    def __init__(self, redis, owner, generation, instruments):
        self.redis = redis
        # Never put identities or credentials in keys/logs; rotations isolate
        # cached data but do NOT reset the owning account's rate budget.
        account = hashlib.sha256(str(owner).encode()).hexdigest()
        self.base = 'upstox:full-quotes:v1:' + account
        batch = hashlib.sha256(json.dumps([generation, sorted(set(instruments))]).encode()).hexdigest()
        self.cache = self.base + ':cache:' + batch
        self.lock = self.cache + ':lock'
        self.stats = self.base + ':counters'
        self.cooldown = self.base + ':cooldown'
        self.token = uuid4().hex

    async def count(self, field):
        await self.redis.hincrby(self.stats, field, 1)

    async def admit(self):
        args = [uuid4().hex]
        for window, count in LIMITS:
            args.extend([window, count])
        return bool(await self.redis.eval(ADMIT, 4, self.base + ':requests', self.cooldown, self.stats, self.base + ':history', *args))

    async def backoff(self, value):
        await self.redis.eval(BACKOFF, 2, self.cooldown, self.stats, retry_after_seconds(value) * 1000)

    async def cached(self):
        raw = await self.redis.get(self.cache)
        if raw is None:
            return None
        rows = json.loads(raw)
        await self.count('cache_hit')
        return [{**row, 'source': row['source'] + ' · cached display quote; original retrieval time preserved'} for row in rows]

    async def run(self, fetch):
        cached = await self.cached()
        if cached is not None:
            return cached
        locked = await self.redis.set(self.lock, self.token, nx=True, px=LOCK_MS)
        if not locked:
            await self.count('coalesced')
            # Bound follower latency below the normal proxy attempt deadline.
            # If the leader remains slow, fail closed rather than duplicate it.
            for _ in range(16):
                await asyncio.sleep(0.05)
                cached = await self.cached()
                if cached is not None:
                    return cached
            await self.count('coalesced_unavailable')
            return []
        try:
            cached = await self.cached()
            if cached is not None:
                return cached
            # Fetch reserves quota immediately before authenticated dispatch.
            rows = await fetch(self)
            await self.redis.set(self.cache, json.dumps(rows), ex=CACHE_SECONDS if rows else FAILURE_SECONDS)
            return rows
        finally:
            await self.redis.eval(RELEASE, 1, self.lock, self.token)


async def guarded_quotes(owner, instruments, fetch):
    import os
    generation = hashlib.sha256(os.environ['UPSTOX_ANALYTICS_TOKEN'].encode()).hexdigest()
    try:
        async with redis_client() as redis:
            return await QuoteGuard(redis, owner, generation, instruments).run(fetch)
    except Exception:
        # No exception bodies, connection strings, account IDs or credentials.
        logger.warning('Upstox quote coordination unavailable; provider access suppressed')
        return []
