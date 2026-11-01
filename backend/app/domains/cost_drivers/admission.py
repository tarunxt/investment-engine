"""Durable collection admission using the existing SQL database.

Source-only additive schema: review and authorized migration required before use.
No TTL, reclaim, reset endpoint or recovery job. Active/uncertain intents block.
Safety assumes a single authoritative DB preserves acknowledged committed intents;
DB restore/rewind or split-brain must keep collection stopped for operator review.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import update, insert, select

from app.infrastructure.database.sync_session import SyncSessionLocal
from .cache import CollectionUnavailableError, RefreshCooldownError, MANUAL_REFRESH_COOLDOWN_SECONDS
from .models import CostCollectionIntent

Intent = CostCollectionIntent.__table__


def _unavailable():
    return CollectionUnavailableError(
        "Durable collection intent unavailable or unresolved; no further collection authorized. "
        "In-flight acceptance may be unknown; operator review required, no automatic recovery."
    )


class DurableIntent:
    def __init__(self, scope_key, token):
        self.scope_key, self.token = scope_key, token
        self.uncertain = False

    def _change(self, conditions, **values):
        try:
            with SyncSessionLocal() as db:
                result = db.execute(update(Intent).where(
                    Intent.c.scope_key == self.scope_key, Intent.c.owner_token == self.token,
                    *conditions,
                ).values(**values))
                if result.rowcount != 1:
                    raise _unavailable()
                db.commit()
        except Exception as exc:
            self.uncertain = True
            raise _unavailable() from exc

    def require_owned(self):
        if self.uncertain:
            raise _unavailable()
        try:
            with SyncSessionLocal() as db:
                row = db.execute(select(Intent).where(Intent.c.scope_key == self.scope_key)).mappings().first()
                if row is None or row.owner_token != self.token or row.state != "active":
                    raise _unavailable()
        except Exception as exc:
            self.uncertain = True
            raise _unavailable() from exc

    def begin_request(self):
        if self.uncertain:
            raise _unavailable()
        # Commit intent BEFORE dispatch. Crash at any later point keeps admission
        # blocked even when AWS may have accepted a request whose response is lost.
        self._change([Intent.c.state == "active", Intent.c.request_inflight.is_(False)],
                     request_inflight=True, request_sequence=Intent.c.request_sequence + 1)

    def finish_request(self):
        self._change([Intent.c.state == "active", Intent.c.request_inflight.is_(True)],
                     request_inflight=False)

    def mark_uncertain(self):
        self.uncertain = True
        try:
            self._change([Intent.c.state == "active"], state="uncertain")
        except CollectionUnavailableError:
            # The previously committed active/inflight intent still blocks others.
            pass

    def finish_collection(self):
        if self.uncertain:
            self.mark_uncertain()
            return
        self._change([Intent.c.state == "active", Intent.c.request_inflight.is_(False)],
                     state="idle", completed_at=datetime.now(timezone.utc).replace(tzinfo=None))


@contextmanager
def durable_collection(scope_key):
    token, now = uuid4().hex, datetime.now(timezone.utc).replace(tzinfo=None)
    cooldown = now + timedelta(seconds=MANUAL_REFRESH_COOLDOWN_SECONDS)
    try:
        # Conditional UPDATE serializes existing idle keys; the unique PK handles
        # concurrent first admission without a read-then-insert race.
        with SyncSessionLocal() as db:
            changed = db.execute(update(Intent).where(
                Intent.c.scope_key == scope_key, Intent.c.state == "idle",
                Intent.c.next_allowed_at <= now,
            ).values(owner_token=token, state="active", request_inflight=False,
                     request_sequence=0, started_at=now, completed_at=None,
                     next_allowed_at=cooldown)).rowcount
            if not changed:
                prior = db.execute(select(Intent).where(Intent.c.scope_key == scope_key)).mappings().first()
                if prior is not None:
                    if prior.state == "idle" and prior.next_allowed_at > now:
                        raise RefreshCooldownError(max(1, int((prior.next_allowed_at - now).total_seconds())))
                    raise _unavailable()
                db.execute(insert(Intent).values(scope_key=scope_key, owner_token=token, state="active",
                              request_inflight=False, request_sequence=0,
                              started_at=now, next_allowed_at=cooldown))
            db.commit()
    except RefreshCooldownError:
        raise
    except Exception as exc:
        # Includes missing schema and ambiguous commit outcomes; never dispatch.
        raise _unavailable() from exc
    intent = DurableIntent(scope_key, token)
    try:
        yield intent
    except BaseException:
        # Preserve cancellation/original failure even if ledger cleanup fails.
        # An active marker with unknown completion must not become reusable.
        try:
            intent.finish_collection()
        except CollectionUnavailableError:
            intent.mark_uncertain()
        raise
    else:
        # A process death never reaches here; its active marker remains unresolved.
        # Provider/ledger failures poison the owner, preventing automatic reuse.
        intent.finish_collection()
