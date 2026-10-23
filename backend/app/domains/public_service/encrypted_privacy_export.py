"""Authenticated encrypted privacy-ledger metadata; never archive contents.

Caller-owned keyring is mandatory. No credential acquisition or key creation.
Request ownership, receipt hash and deterministic packet ID must all agree.
"""
from uuid import UUID,uuid5,NAMESPACE_URL
from sqlalchemy import select,case,cast,Text,LargeBinary,func
from app.domains.ai_limits.contracts import BoundaryDenied,digest
from app.domains.connections.crypto import ConnectionKeyring,ConnectionFault
from app.infrastructure.database.outbox.models import OutboxMessage
from .privacy import PrivacyRequests
from .sql_privacy_plan import TOPIC as PLAN
from .sql_privacy_workflow import TOPIC as EFFECT
from .recoverable_privacy import TOPIC as RECOVERY
from .residency import TOPIC as SYNTHETIC
from .reviewed_residency import EVIDENCE,CONSENT
from .store import owner
from .sql_account import _json_value

TOPICS=frozenset({PLAN,EFFECT,RECOVERY,SYNTHETIC,EVIDENCE})
PREFIX={PLAN:'credx:sql-privacy-plan:',EFFECT:'credx:disposable-sql-privacy:',RECOVERY:'credx:privacy-fixture-recovery:'}


class EncryptedPrivacyExport:
    def __init__(self,db,keyring):
        if type(keyring) is not ConnectionKeyring:raise BoundaryDenied('EXPLICIT_ACCOUNT_KEYRING_REQUIRED')
        self.db,self.keyring=db,keyring

    def project(self,subject,identifier,topic,p):
        try:
            common={'owner_id','ciphertext','key_version'}
            required=common|({'claims_hash'} if topic==EFFECT else {'archive_hash','state'} if topic==RECOVERY else {'revoked'} if topic in {SYNTHETIC,EVIDENCE} else set())
            allowed=required|({'restored_at','restore_controls','restore_controls_hash'} if topic==RECOVERY else set())
            if set(p)-allowed or not required<=set(p) or type(p.get('owner_id')) is not int or p['owner_id']!=subject:raise ValueError
            claims=self.keyring.open(p['ciphertext'],p['key_version'])
            principal='owner' if topic==EVIDENCE else 'owner_id'
            if type(claims) is not dict or type(claims.get(principal)) is not int or claims[principal]!=subject:raise ValueError
            if topic in {SYNTHETIC,EVIDENCE}:
                from .public_outbox_export import timestamp
                if claims.get('country')!='IN' or type(p.get('revoked')) is not bool:raise ValueError
                timestamp(claims['issued_at']);timestamp(claims['expires_at'])
                if topic==SYNTHETIC:
                    if set(claims)!={'owner_id','country','source','reference_hash','reviewer_hash','issued_at','expires_at','real_eligibility'} or claims['source']!='synthetic-review' or claims['real_eligibility'] is not False:raise ValueError
                else:
                    if identifier!=uuid5(NAMESPACE_URL,f'credx:reviewed-residency:{subject}') or set(claims)!={'owner','policy','actor','country','type','reference_hash','consent_id','issued_at','expires_at','revoked'}:raise ValueError
                    consent=self.db.get(OutboxMessage,UUID(claims['consent_id']))
                    if consent is None or consent.topic!=CONSENT or consent.payload.get('consumed') is not True:raise ValueError
                    bound=self.keyring.open(consent.payload['ciphertext'],consent.payload['key_version'])
                    if bound.get('owner')!=subject or bound.get('consumed') is not True or bound.get('policy')!=claims['policy'] or bound.get('evidence_type')!=claims['type']:raise ValueError
                return {'id':str(identifier),'topic':topic,'kind':'authenticated_residency_history',
                    'revoked':p['revoked'],'issued_at':claims['issued_at'],'expires_at':claims['expires_at'],
                    'eligibility_granted':False,'linked_consent_verified':topic==EVIDENCE,'contents_withheld':True}
            request_id=UUID(claims['request_id'])
            request=PrivacyRequests(self.db).owned(subject,request_id)
            if claims.get('request_hash')!=request.payload.get('receipt_hash') or identifier!=uuid5(NAMESPACE_URL,PREFIX[topic]+str(request_id)):raise ValueError
            if topic==EFFECT and (claims.get('synthetic') is not True or claims.get('legal_approval') is not False or p.get('claims_hash')!=digest(claims)):raise ValueError
            if topic==RECOVERY and (claims.get('synthetic') is not True or p.get('archive_hash')!=digest(claims) or p.get('state') not in {'recoverable','restored'}):raise ValueError
            if topic==PLAN and claims.get('deletion_executable') is not False:raise ValueError
        except (ConnectionFault,KeyError,TypeError,ValueError,AttributeError):
            raise BoundaryDenied('ENCRYPTED_ACCOUNT_EVIDENCE_INVALID') from None
        return {'id':str(identifier),'topic':topic,'request_id':str(request_id),
            'kind':'authenticated_privacy_ledger_metadata','contents_withheld':True,
            'state':p['state'] if topic==RECOVERY else 'recorded','complete_account_erasure':False}

    def export(self,subject):
        owner(self.db,subject,verified=True)
        dialect=self.db.get_bind().dialect.name
        if dialect=='postgresql' and self.db.connection().get_isolation_level() not in {'REPEATABLE READ','SERIALIZABLE'}:
            raise BoundaryDenied('ACCOUNT_SNAPSHOT_ISOLATION_REQUIRED')
        if dialect not in {'postgresql','sqlite'}:raise BoundaryDenied('ACCOUNT_DATABASE_UNSUPPORTED')
        length=func.octet_length(cast(OutboxMessage.payload,Text)) if dialect=='postgresql' else func.length(cast(OutboxMessage.payload,LargeBinary))
        rows=self.db.execute(select(OutboxMessage.id,OutboxMessage.topic,case((length>65536,None),else_=cast(OutboxMessage.payload,Text)))
            .where(OutboxMessage.topic.in_(TOPICS),OutboxMessage.payload['owner_id'].as_integer()==subject)
            .order_by(OutboxMessage.id).limit(101))
        items=[]
        with rows:
            for identifier,topic,raw in rows:
                if len(items)>=100 or raw is None:raise BoundaryDenied('ENCRYPTED_ACCOUNT_EVIDENCE_LIMIT')
                items.append(self.project(subject,identifier,topic,_json_value(raw,65536)))
        return {'owner_id':subject,'items':items,'covered_topics':sorted(TOPICS),
            'archive_contents_exported':False,'complete_account_export':False,'complete_account_erasure':False}
