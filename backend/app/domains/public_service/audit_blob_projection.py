"""Closed canonical-bundle metadata validated against actual owner/run/hash.

No generic JSON/text blob content is released. Shared blobs remain withheld by
caller reference proof. A sanitized flag alone is never sufficient authority.
"""
from sqlalchemy import select,case,cast,Text,LargeBinary,func
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.bullpen_run_audit.repository import stable_blob_id
from .sql_account import _json_value


def canonical_blob_metadata(db,metadata,subject,identifier):
    if not {'bullpen_run_audit_snapshots','polymarket_auto_live_runs','bullpen_run_audit_blobs'}<=set(metadata.tables):return None
    snapshots=metadata.tables['bullpen_run_audit_snapshots'];runs=metadata.tables['polymarket_auto_live_runs'];blobs=metadata.tables['bullpen_run_audit_blobs']
    bindings=db.execute(select(snapshots.c.run_id,snapshots.c.source_kind,snapshots.c.lifecycle_status,
        snapshots.c.snapshot_schema_version,snapshots.c.canonical_bundle_hash).join(runs,runs.c.id==snapshots.c.run_id)
        .where(snapshots.c.user_id==subject,runs.c.user_id==subject,snapshots.c.canonical_bundle_blob_id==identifier).limit(101)).all()
    if not bindings:return None
    if len(bindings)>100:raise BoundaryDenied('ACCOUNT_BLOB_PROJECTION_LIMIT')
    size=func.octet_length(cast(blobs.c.payload_json,Text)) if db.get_bind().dialect.name=='postgresql' else func.length(cast(blobs.c.payload_json,LargeBinary))
    raw=db.scalar(select(case((size>65536,None),else_=cast(blobs.c.payload_json,Text))).where(
        blobs.c.id==identifier,blobs.c.content_type=='application/json',blobs.c.sanitized.is_(True),blobs.c.payload_text.is_(None)))
    if raw is None:raise BoundaryDenied('ACCOUNT_CANONICAL_BLOB_INVALID')
    payload=_json_value(raw,65536)
    if type(payload) is not dict or stable_blob_id(payload)!=identifier:raise BoundaryDenied('ACCOUNT_CANONICAL_BLOB_INVALID')
    value=payload.get('metadata')
    if type(value) is not dict or set(value)!={'run_id','source_kind','lifecycle_status','snapshot_schema_version'}:
        raise BoundaryDenied('ACCOUNT_CANONICAL_BLOB_INVALID')
    if (type(value['run_id']) is not str or not 1<=len(value['run_id'])<=64 or
        value['source_kind'] not in ('native','reconstructed') or value['lifecycle_status'] not in ('working','frozen','incomplete') or
        type(value['snapshot_schema_version']) is not int or value['snapshot_schema_version']!=2 or
        any(tuple(binding)!=(value['run_id'],value['source_kind'],value['lifecycle_status'],2,identifier) for binding in bindings)):
        raise BoundaryDenied('ACCOUNT_CANONICAL_BLOB_INVALID')
    return {**value,'raw_contents_exported':False,'projection':'canonical_run_metadata_v2'}
