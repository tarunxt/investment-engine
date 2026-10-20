"""Database-authoritative tenant/operation idempotency, independent of Redis.

Legacy idem:* entries are intentionally never read, imported or deleted.
"""
import hashlib
import json
from sqlalchemy import select
from app.infrastructure.messaging.operation_models import IdempotencyOperation


def digest(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def canonical_digest(payload: dict) -> str:
    return digest(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False))


class IdempotencyStore:
    def __init__(self, session):
        self.session = session

    async def get(self, user_id: int, operation: str, key_digest: str):
        return (await self.session.execute(select(IdempotencyOperation).where(
            IdempotencyOperation.user_id == user_id,
            IdempotencyOperation.operation == operation,
            IdempotencyOperation.key_digest == key_digest,
        ))).scalar_one_or_none()

    async def bind(self, *, user_id, operation, key_digest, request_digest, job_id):
        self.session.add(IdempotencyOperation(user_id=user_id, operation=operation,
            key_digest=key_digest, request_digest=request_digest, job_id=job_id))
        await self.session.flush()
