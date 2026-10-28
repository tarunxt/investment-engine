"""Durable, encrypted policy/audit/suppression drills for disposable SQL only.

No route, scheduler, live backup operation, actual erasure or permission change.
Suppression survives rebuilding this service; lost/incomplete ledger blocks restore.
"""
from datetime import datetime, timedelta, timezone
from uuid import uuid5, NAMESPACE_URL
from sqlalchemy import select, update
from app.domains.ai_limits.contracts import BoundaryDenied, digest, utc
from app.domains.auth.models import UserProfile
from app.domains.connections.crypto import ConnectionKeyring, ConnectionFault
from app.infrastructure.database.outbox.models import OutboxMessage
from .privacy import PrivacyRequests
from .sql_privacy_workflow import DisposablePrivacyScope
from .retention_policy import TARGET_DAYS, VERSION, _date, _hash, source_mapping_hash, assess
from .sql_account import SQLAccountReader

TOPIC = 'public_service.privacy.category_fixture.v1'
REFERENCE = 'synthetic:category-policy-v1'
UNLINK_FIELDS = frozenset({'avatar_url','bio','google_sheets_master_url'})


class CategoryPolicyFixture:
    def __init__(self, db, keyring, *, reader=None, scope=None, policy_review=None):
        self.db,self.keyring,self.scope,self.reader=db,keyring,scope,reader
        self.policy_review=policy_review

    def _fence(self, owner, request_id):
        if (type(self.scope) is not DisposablePrivacyScope or self.scope.reference != REFERENCE
                or type(self.keyring) is not ConnectionKeyring or type(owner) is not int or owner <= 0):
            raise BoundaryDenied('DISPOSABLE_CATEGORY_POLICY_REQUIRED')
        scope_hash=self.scope.validate(self.db)
        if type(self.reader) is not SQLAccountReader or self.reader.db is not self.db:
            raise BoundaryDenied('SAME_POLICY_INVENTORY_REQUIRED')
        self.reader.validate()
        requests=PrivacyRequests(self.db);requests.fence(owner)
        request=requests.owned(owner,request_id,True)
        p=request.payload
        if (p.get('kind') != 'delete' or p.get('state') not in {'retention_review_required','synthetic_sql_complete'}
                or digest({k:p[k] for k in ('owner_id','kind','key')}) != p.get('binding')
                or digest({k:v for k,v in p.items() if k not in {'state','result','result_hash','receipt_hash'}}) != p.get('receipt_hash')):
            raise BoundaryDenied('OWNED_POLICY_DELETE_REQUEST_REQUIRED')
        return request,scope_hash

    def _id(self, request):return uuid5(NAMESPACE_URL,'credx:category-policy-fixture:'+str(request.id))

    def _read(self, owner, request, scope_hash):
        row=self.db.scalar(select(OutboxMessage).where(OutboxMessage.id==self._id(request)).with_for_update())
        if row is None:raise BoundaryDenied('RESTORE_SUPPRESSION_LEDGER_UNAVAILABLE')
        try:
            if (set(row.payload) != {'owner_id','ciphertext','key_version','claims_hash'}
                    or type(row.payload['ciphertext']) is not str or len(row.payload['ciphertext']) > 16384):raise ValueError()
            claims=self.keyring.open(row.payload['ciphertext'],row.payload['key_version'])
        except (ConnectionFault,KeyError,TypeError,ValueError):raise BoundaryDenied('POLICY_FIXTURE_RECEIPT_INVALID') from None
        if (row.topic != TOPIC or row.payload['owner_id'] != owner or claims.get('owner_id') != owner
                or claims.get('request_id') != str(request.id) or claims.get('request_hash') != request.payload['receipt_hash']
                or claims.get('scope_hash') != scope_hash or claims.get('synthetic') is not True
                or claims.get('real_deletion_enabled') is not False or digest(claims) != row.payload['claims_hash']):
            raise BoundaryDenied('POLICY_FIXTURE_RECEIPT_INVALID')
        return claims

    def unlink_profile(self, owner, request_id, proposal, *, now=None):
        """Null only selected nullable profile fields, never identity/credentials.

        Requires an expired conditional target with duties verified in the supplied
        proposal. Caller commits. New private data after completion conflicts rather
        than being silently removed by idempotent replay.
        """
        now=_date(now or datetime.now(timezone.utc));request,scope_hash=self._fence(owner,request_id)
        if not utc(datetime.fromisoformat(request.payload['created_at'])) <= now < utc(datetime.fromisoformat(request.payload['expires_at'])):
            raise BoundaryDenied('PRIVACY_REQUEST_EXPIRED')
        if (type(proposal) is not dict or digest({k:v for k,v in proposal.items() if k!='policy_hash'}) != proposal.get('policy_hash')
                or proposal.get('owner_id') != owner or proposal.get('request_id') != str(request.id)
                or proposal.get('inventory_hash') != self.reader.inventory.schema_digest
                or proposal.get('source_mapping_hash') != source_mapping_hash(set(self.reader.metadata.tables))
                or proposal.get('version') != VERSION or proposal.get('real_deletion_enabled') is not False
                or proposal.get('legal_approval') is not False or proposal.get('complete_erasure') is not False
                or proposal.get('stores',{}).get('user_profiles',{}).get('reason') != 'SYNTHETIC_CANDIDATE_ONLY'):
            raise BoundaryDenied('REVIEWED_PROFILE_PROPOSAL_REQUIRED')
        try:
            if _date(datetime.fromisoformat(proposal['review_expires_at'])) <= now:
                raise BoundaryDenied('CATEGORY_REVIEW_EXPIRED')
        except (ValueError, TypeError, KeyError): raise BoundaryDenied('CATEGORY_REVIEW_EXPIRED') from None
        # Rebuild from the complete typed review, not caller-edited dispositions.
        try: eligible_at=datetime.fromisoformat(proposal['eligible_at'])
        except (KeyError, ValueError, TypeError): raise BoundaryDenied('POLICY_ELIGIBILITY_REQUIRED') from None
        expected=assess(owner_id=owner,request_id=str(request.id),names=set(self.reader.metadata.tables),
            inventory_hash=self.reader.inventory.schema_digest,eligible_at=eligible_at,now=now,review=self.policy_review)
        if expected != proposal:raise BoundaryDenied('CATEGORY_POLICY_REVIEW_CHANGED')
        due=proposal['stores']['user_profiles']['due_at']
        if not due or _date(datetime.fromisoformat(due)) > now:raise BoundaryDenied('PROFILE_TARGET_NOT_DUE')
        profile=self.db.scalar(select(UserProfile).where(UserProfile.user_id==owner).with_for_update())
        if profile is None:raise BoundaryDenied('OWNED_PROFILE_REQUIRED')
        old=self.db.get(OutboxMessage,self._id(request),populate_existing=True)
        if old is not None:
            claims=self._read(owner,request,scope_hash)
            if claims['policy_hash'] != proposal['policy_hash'] or any(getattr(profile,f) is not None for f in UNLINK_FIELDS):
                raise BoundaryDenied('POLICY_UNLINK_REPLAY_CONFLICT')
            return claims
        with self.db.begin_nested():
            self.db.execute(update(UserProfile).where(UserProfile.user_id==owner).values(**{f:None for f in UNLINK_FIELDS}))
            # Purpose-limited encrypted audit: no old field values, name, email,
            # upload text, free-prose request details, credential or order payload.
            claims={'owner_id':owner,'request_id':str(request.id),'request_hash':request.payload['receipt_hash'],
                    'scope_hash':scope_hash,'policy_hash':proposal['policy_hash'],'synthetic':True,
                    'real_deletion_enabled':False,'legal_approval':False,'complete_erasure':False,
                    'event':'selected_profile_unlinked','category_counts':{'profile':1},
                    'unlink_fields':sorted(UNLINK_FIELDS),'recorded_at':now.isoformat(),
                    'suppress_profile_restore':True,'identity_anchor_retained':True}
            ciphertext,version=self.keyring.seal(claims)
            self.db.add(OutboxMessage(id=self._id(request),topic=TOPIC,payload={
                'owner_id':owner,'ciphertext':ciphertext,'key_version':version,'claims_hash':digest(claims)}))
            self.db.flush()
        return claims

    def restore_profile(self, owner, request_id, candidate, *, now=None):
        """Suppress reviewed profile fields in a supplied backup row; writes nothing.

        Credentials/financial/identity rows are never handled by this adapter.
        Must run before any fixture profile restore; no live restore is installed.
        """
        request,scope_hash=self._fence(owner,request_id);claims=self._read(owner,request,scope_hash)
        if (type(candidate) is not dict or type(candidate.get('user_id')) is not int or candidate.get('user_id') != owner
                or set(candidate) != {'user_id',*UNLINK_FIELDS} or claims.get('suppress_profile_restore') is not True):
            raise BoundaryDenied('OWNED_PROFILE_BACKUP_REQUIRED')
        return {'user_id':owner,**{f:None for f in UNLINK_FIELDS}}


def backup_expiry_plan(*, created_at, now, inventory_hash=None, copies=(), legal_hold=True, applicable_duties_verified=False, copies_complete=False):
    """Proposed rolling 30-day expiry only, without a purge/schedule/key operation.

    Every actual copy needs inventory proof; omitted/unobserved replicas stay held.
    Audit/identity retention and legal mapping are not solved by backup age.
    """
    created_at,now=_date(created_at),_date(now)
    if created_at > now or any(type(v) is not bool for v in (legal_hold, applicable_duties_verified, copies_complete)):raise BoundaryDenied('BACKUP_POLICY_INPUT_INVALID')
    if (type(copies) is not tuple or len(copies)>256
            or any(type(c) is not str or not _hash(c) for c in copies) or len(set(copies))!=len(copies)):
        raise BoundaryDenied('BACKUP_INVENTORY_REQUIRED')
    target=created_at+timedelta(days=TARGET_DAYS)
    reason=('INVENTORY_AND_APPLICABLE_DUTIES_UNVERIFIED' if not _hash(inventory_hash) or not copies or not applicable_duties_verified or not copies_complete
            else 'LEGAL_HOLD' if legal_hold else 'TARGET_PENDING' if now<target else 'SYNTHETIC_EXPIRY_CANDIDATE_ONLY')
    return {'version':VERSION,'target_days':TARGET_DAYS,'target_at':target.isoformat(),
            'copy_hashes':list(copies),'inventory_hash':inventory_hash if _hash(inventory_hash) else None,
            'reason':reason,'restore_suppression_required':True,'purge_executable':False,
            'schedule_changed':False,'keys_changed':False,'legal_approval':False,'complete_erasure':False}


from .recoverable_privacy import RecoverableFixturePrivacy


class SuppressedProfileFixtureRecovery(RecoverableFixturePrivacy):
    """Explicit new backup consumer; never use the generic adapter for this policy.

    Calls the retained suppression ledger inside the inherited restore savepoint.
    Missing/expired/corrupt policy linkage aborts restoration. No route is installed.
    This consumer does not cover uploads, analysis blobs or arbitrary backup rows.
    """
    def __init__(self,*args,policy_request_id=None,**kwargs):
        super().__init__(*args,**kwargs)
        self.policy_request_id=policy_request_id

    def _restore_metadata(self,row):
        controls=row.payload.get('restore_controls')
        if (type(controls) is not dict or digest(controls) != row.payload.get('restore_controls_hash')
                or controls != {'profile_suppression_applied':True,'authority_restored':False,
                                'complete_account_erasure':False,'policy_request_id':str(self.policy_request_id)}):
            raise BoundaryDenied('PROFILE_RESTORE_CONTROLS_INVALID')
        return {'restore_controls':controls}

    def _after_restore(self,owner,counts,now):
        if set(n for n,c in counts.items() if c) != {'user_profiles'}:
            raise BoundaryDenied('PROFILE_ONLY_SUPPRESSED_RECOVERY_REQUIRED')
        adapter=CategoryPolicyFixture(self.db,self.keyring,reader=self.reader,
            scope=DisposablePrivacyScope(REFERENCE))
        row=self.db.scalar(select(UserProfile).where(UserProfile.user_id==owner).with_for_update())
        if row is None:raise BoundaryDenied('OWNED_PROFILE_REQUIRED')
        candidate={'user_id':owner,**{f:getattr(row,f) for f in UNLINK_FIELDS}}
        safe=adapter.restore_profile(owner,self.policy_request_id,candidate)
        self.db.execute(update(UserProfile).where(UserProfile.user_id==owner).values(**{f:safe[f] for f in UNLINK_FIELDS}))
        return {'profile_suppression_applied':True,'authority_restored':False,
                'complete_account_erasure':False,'policy_request_id':str(self.policy_request_id)}
