"""Bounded source-backed projections; no activation, erasure or raw payloads."""
from uuid import UUID
from sqlalchemy import select
from app.domains.ai_limits.contracts import BoundaryDenied,digest
from .canonical_privacy_inventory import assert_owned_relationships

MAX_KEYS=1000

def _fence_keys(owner_id, connection_ids, account_ids):
    # Exact construction matches order_intents.execution.fences, not prefix
    # parsing or purported owner fields supplied inside an arbitrary payload.
    if type(owner_id) is not int or owner_id < 1:
        raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
    if len(connection_ids)>MAX_KEYS or len(account_ids)>MAX_KEYS:
        raise BoundaryDenied('CANONICAL_RESOLVER_LIMIT')
    normalized=[]
    for value in connection_ids:
        if type(value) is UUID:
            normalized.append(str(value));continue
        try:
            if type(value) is not str or str(UUID(value))!=value:raise ValueError
        except (ValueError,TypeError,AttributeError):
            raise BoundaryDenied('CANONICAL_RESOLVER_BINDING_REQUIRED') from None
        normalized.append(value)
    if any(type(value) is not str or not 1<=len(value)<=128 for value in account_ids):
        raise BoundaryDenied('CANONICAL_RESOLVER_BINDING_REQUIRED')
    return frozenset({f'owner:{owner_id}', *(f'connection:{value}' for value in normalized),
        *('account:'+digest({'owner':owner_id,'account':value}) for value in account_ids)})


def owned_execution_fences(db, metadata, owner_id):
    """Read only proven owned controls; platform/unrecognized keys stay retained.

    Safety fences must never be deleted as an account-erasure side effect.
    All source-derived IDs are bounded before retrieval; no credential values or
    entire order payloads are selected. Shared blobs/outbox stay quarantined.
    """
    assert_owned_relationships(db,metadata,owner_id)
    connections=metadata.tables['integration_connections'];intents=metadata.tables['confirmed_order_intents']
    connection_ids=list(db.scalars(select(connections.c.id).where(connections.c.owner_id==owner_id).limit(MAX_KEYS+1)))
    account_ids=list(db.scalars(select(intents.c.account_id).where(intents.c.owner_id==owner_id).distinct().limit(MAX_KEYS+1)))
    keys=_fence_keys(owner_id,connection_ids,account_ids)
    table=metadata.tables['order_execution_fences']
    rows=db.execute(select(table.c.key,table.c.stopped).where(table.c.key.in_(sorted(keys))).order_by(table.c.key).limit(2*MAX_KEYS+2)).all()
    if any(type(stopped) is not bool for _,stopped in rows):
        raise BoundaryDenied('CANONICAL_RESOLVER_BINDING_REQUIRED')
    return {'items':[{'key':key,'stopped':stopped} for key,stopped in rows],
        'platform_retained':True,'unrecognized_keys_retained':True,'deletable':False,
        'runtime_binding':False,'complete_account_export':False}
