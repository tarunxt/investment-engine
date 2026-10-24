"""Read-only partial account snapshot, with explicit held-store coverage.

No credential resolver, external sink, erasure adapter or user-supplied path.
Caller owns a fresh repeatable-read transaction and the exact simulation scope.
"""
from datetime import datetime,timezone
from sqlalchemy import select
from app.domains.auth.models import User,UserProfile
from app.domains.ai_limits.contracts import BoundaryDenied,digest
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from .sql_account import _encode


def snapshot(db,subject,scope):
    if type(scope) is not SimulationSourceScope:raise BoundaryDenied('EXPLICIT_ACCOUNT_EXPORT_SCOPE_REQUIRED')
    scope.validate(db,subject)
    if db.get_bind().dialect.name=='postgresql' and db.connection().get_isolation_level() not in {'REPEATABLE READ','SERIALIZABLE'}:
        raise BoundaryDenied('ACCOUNT_SNAPSHOT_ISOLATION_REQUIRED')
    user=db.scalar(select(User).where(User.id==subject,User.is_active.is_(True)))
    if user is None:raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
    profile=db.scalar(select(UserProfile).where(UserProfile.user_id==subject))
    data={'owner_id':subject,'schema_version':1,'generated_at':datetime.now(timezone.utc).isoformat(),
        'complete_account_export':False,'complete_account_erasure':False,'real_deletion_enabled':False,
        'profile':{name:getattr(user,name) for name in ('id','email','username','full_name')},
        'preferences':{name:getattr(profile,name) for name in ('timezone','theme_preference','notification_preferences')} if profile else None,
        'coverage':{'profile':'owned named fields only; credentials and free-form content excluded',
            'files':'held: deployed file inventory and ownership not verified',
            'cache':'held: explicit runtime key inventory not admitted',
            'encrypted_credentials':'withheld; no keyring or credential access',
            'identity_sessions':'retained; export does not revoke or erase sessions',
            'backups':'held: inventory, retention and authoritative restore suppression require verification'}}
    # Canonical SQL export requires exact source AND physical schema admission.
    # A relationship/ownership failure is not downgraded to partial success.
    import app.models  # noqa: F401: canonical metadata, no schema mutation
    from app.infrastructure.database.base import Base
    from .canonical_privacy_inventory import assert_owned_relationships
    from .safe_privacy_projection import safe_canonical_inventory
    from .sql_account import SQLAccountReader
    try:
        assert_owned_relationships(db,Base.metadata,subject)
        inventory=safe_canonical_inventory(Base.metadata,reference='owned-download-source-projection-v1')
        data['canonical_sql']=SQLAccountReader(db,Base.metadata,inventory).export(subject)
        data['coverage']['sql']='safe owned field projection; credentials, unverified text/JSON, opaque content and shared records withheld'
    except BoundaryDenied as exc:
        if str(exc) not in {'CANONICAL_ACCOUNT_CLASSIFICATION_CHANGED','CANONICAL_ACCOUNT_SCHEMA_CHANGED','ACCOUNT_DATABASE_SCHEMA_CHANGED'}:raise
        data['coverage']['sql']='held: canonical physical schema/inventory not admitted'
    from .native_outbox_export import NativeOutboxExport
    data['native_evidence']=NativeOutboxExport(db,scope=scope).export(subject)
    data['coverage']['native_evidence']='typed owned receipts only; unknown/shared payloads withheld'
    from .privacy import PrivacyRequests
    data['privacy_requests']=PrivacyRequests(db).history(subject)
    data['coverage']['privacy_requests']='latest 100 validated owned request receipts; has_more explicitly reports truncation'
    data['content_hash']=digest(data)
    if len(_encode(data))>8*1024*1024:raise BoundaryDenied('ACCOUNT_EXPORT_SIZE_LIMIT')
    return data
