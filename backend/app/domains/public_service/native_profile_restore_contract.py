"""Disabled native-restore design contract; pure projection, no I/O or executor.

Synthetic independent heads model a future authoritative ledger, not its storage,
keys, authenticity or durability. Native whole-database/startup integration is
absent. Never treat a digest or this module's presence as a restore permission.
"""
from copy import deepcopy
from dataclasses import dataclass
import json
from uuid import UUID
from app.domains.ai_limits.contracts import BoundaryDenied, digest
from app.domains.auth.models import UserProfile

FIELDS = frozenset({'avatar_url', 'bio', 'google_sheets_master_url'})
STORES = frozenset({'users', 'user_profiles'})
PROFILE_COLUMNS = frozenset(UserProfile.__table__.c.keys())
PROFILE_SCHEMA = digest({'columns':sorted((c.name,str(c.type),c.nullable) for c in UserProfile.__table__.c),
    'primary_key':[c.name for c in UserProfile.__table__.primary_key],
    'foreign_keys':sorted((e.parent.name,e.target_fullname,f.ondelete) for f in UserProfile.__table__.foreign_key_constraints for e in f.elements)})


def _uuid(value):
    try:return type(value) is str and str(UUID(value)) == value
    except (ValueError,TypeError,AttributeError):return False


def _hash(value):
    return type(value) is str and len(value)==64 and all(c in '0123456789abcdef' for c in value)


@dataclass(frozen=True)
class Principal:
    owner_id:int
    subject_ref:str
    identity_hash:str

    def claims(self):
        if type(self.owner_id) is not int or self.owner_id<=0 or not _uuid(self.subject_ref) or not _hash(self.identity_hash):
            raise BoundaryDenied('RESTORE_PRINCIPAL_BINDING_REQUIRED')
        return {'owner_id':self.owner_id,'subject_ref':self.subject_ref,'identity_hash':self.identity_hash}


@dataclass(frozen=True)
class Tombstone:
    event_id:str
    owner_id:int
    subject_ref:str
    fields:frozenset[str]

    def claims(self):
        if (not _uuid(self.event_id) or type(self.owner_id) is not int or self.owner_id<=0
                or not _uuid(self.subject_ref) or type(self.fields) is not frozenset
                or not self.fields or not self.fields<=FIELDS):
            raise BoundaryDenied('SUPPORTED_PROFILE_TOMBSTONE_REQUIRED')
        return {'event_id':self.event_id,'owner_id':self.owner_id,'subject_ref':self.subject_ref,'fields':sorted(self.fields)}


@dataclass(frozen=True)
class Ledger:
    lineage:str
    sequence:int
    entries:tuple[Tombstone,...]
    complete:bool=False
    coverage:frozenset[str]=frozenset()

    def claims(self):
        if (not _uuid(self.lineage) or type(self.sequence) is not int or self.sequence<0
                or self.complete is not True or self.coverage!=frozenset({'user_profiles'})
                or type(self.coverage) is not frozenset or type(self.entries) is not tuple
                or len(self.entries)>100 or any(type(t) is not Tombstone for t in self.entries)):
            raise BoundaryDenied('COMPLETE_INDEPENDENT_LEDGER_REQUIRED')
        entries=[t.claims() for t in self.entries]
        if len({t['event_id'] for t in entries})!=len(entries):raise BoundaryDenied('DUPLICATE_SUPPRESSION_EVENT')
        return {'lineage':self.lineage,'sequence':self.sequence,'entries':entries,'complete':True,'coverage':sorted(self.coverage)}


@dataclass(frozen=True)
class SyntheticIndependentHead:
    """Test-only trusted input kept OUTSIDE the restored snapshot; no live adapter."""
    lineage:str
    sequence:int
    ledger_hash:str
    principals:tuple[Principal,...]
    reference:str='synthetic:independent-profile-ledger-v1'

    def validate(self,ledger):
        if (self.reference!='synthetic:independent-profile-ledger-v1' or not _uuid(self.lineage)
                or type(self.sequence) is not int or self.sequence<0 or not _hash(self.ledger_hash)
                or type(self.principals) is not tuple or not 1<=len(self.principals)<=100
                or any(type(p) is not Principal for p in self.principals)):
            raise BoundaryDenied('SYNTHETIC_INDEPENDENT_HEAD_REQUIRED')
        principals=[p.claims() for p in self.principals]
        if (len({p['owner_id'] for p in principals})!=len(principals)
                or len({p['subject_ref'] for p in principals})!=len(principals)):
            raise BoundaryDenied('AMBIGUOUS_RESTORE_IDENTITY')
        if type(ledger) is not Ledger:raise BoundaryDenied('COMPLETE_INDEPENDENT_LEDGER_REQUIRED')
        claims=ledger.claims()
        if (self.lineage!=ledger.lineage or self.sequence!=ledger.sequence
                or digest(claims)!=self.ledger_hash):raise BoundaryDenied('RESTORE_LEDGER_HEAD_MISMATCH')
        return {p['owner_id']:p for p in principals}


def _snapshot(snapshot,principals,lineage):
    if (type(snapshot) is not dict or set(snapshot)!={'lineage','schema_hash','stores','users','user_profiles'}
            or snapshot['lineage']!=lineage or snapshot['schema_hash']!=PROFILE_SCHEMA
            or snapshot['stores']!=sorted(STORES) or type(snapshot['users']) is not list
            or type(snapshot['user_profiles']) is not list or len(snapshot['user_profiles'])>100):
        raise BoundaryDenied('SUPPORTED_PROFILE_RESTORE_SCOPE_REQUIRED')
    if (len(snapshot['users'])>100 or any(type(r) is not dict or set(r)!={'owner_id','subject_ref','identity_hash'}
            or type(r['owner_id']) is not int or not _uuid(r['subject_ref']) or not _hash(r['identity_hash']) for r in snapshot['users'])
            or snapshot['users']!=[principals[k] for k in sorted(principals)]):
        raise BoundaryDenied('RESTORE_IDENTITY_LINEAGE_CHANGED')
    seen=set()
    for row in snapshot['user_profiles']:
        if (type(row) is not dict or set(row)!=PROFILE_COLUMNS or type(row.get('user_id')) is not int
                or row['user_id'] not in principals or row['user_id'] in seen
                or any(row[f] is not None and (type(row[f]) is not str or len(row[f])>65536) for f in FIELDS)):
            raise BoundaryDenied('OWNED_SOURCE_PROFILE_REQUIRED')
        seen.add(row['user_id'])
    digest(snapshot)  # bounded, finite JSON; no free-form extra source stores.
    return seen


@dataclass(frozen=True)
class ProfilePlan:
    plan_hash:str
    raw_fingerprint:str
    post_fingerprint:str
    ledger_hash:str
    sequence:int
    post_json:str

    def projected_fixture(self):return json.loads(self.post_json)

    def receipt(self):
        return {'plan_hash':self.plan_hash,'raw_fingerprint':self.raw_fingerprint,
            'post_fingerprint':self.post_fingerprint,'ledger_hash':self.ledger_hash,'sequence':self.sequence,
            'native_activation':False,'real_deletion_enabled':False,'complete_account_erasure':False}


def plan_profile_restore(raw,*,backup_fingerprint,raw_verified_fingerprint,ledger,head):
    """Only narrow profile fixture snapshots can produce a synthetic plan.

    Caller must retain independent raw proof. Never replace the native controller's
    full schema/catalog fingerprint with this restricted fixture fingerprint.
    """
    if type(head) is not SyntheticIndependentHead:raise BoundaryDenied('NATIVE_AUTHORITY_ADAPTER_UNAVAILABLE')
    principals=head.validate(ledger)
    seen=_snapshot(raw,principals,head.lineage)
    if (not _hash(backup_fingerprint) or backup_fingerprint!=raw_verified_fingerprint
            or digest(raw)!=backup_fingerprint):raise BoundaryDenied('RAW_BACKUP_FINGERPRINT_MISMATCH')
    post=deepcopy(raw);rows={r['user_id']:r for r in post['user_profiles']}
    for t in ledger.entries:
        bound=principals.get(t.owner_id)
        if bound is None or bound['subject_ref']!=t.subject_ref:raise BoundaryDenied('FOREIGN_PROFILE_TOMBSTONE')
        # Absence is valid only with a complete reviewed fixture inventory.
        if t.owner_id in seen:
            for field in t.fields:rows[t.owner_id][field]=None
    post_hash=digest(post)
    binding={'raw':backup_fingerprint,'post':post_hash,'ledger':head.ledger_hash,'sequence':head.sequence,
             'lineage':head.lineage,'schema':PROFILE_SCHEMA,'principals':[principals[k] for k in sorted(principals)]}
    return ProfilePlan(digest(binding),backup_fingerprint,post_hash,head.ledger_hash,head.sequence,
                       json.dumps(post,sort_keys=True,separators=(',',':')))


@dataclass(frozen=True)
class FixtureCheckpoint:
    plan_hash:str
    phase:str


def inspect_fixture_recovery(raw,current,*,backup_fingerprint,ledger,head,checkpoint):
    """Verification only; never rerun a possibly committed restore or projection."""
    plan=plan_profile_restore(raw,backup_fingerprint=backup_fingerprint,
        raw_verified_fingerprint=backup_fingerprint,ledger=ledger,head=head)
    _snapshot(current,head.validate(ledger),head.lineage)
    if (type(checkpoint) is not FixtureCheckpoint or checkpoint.plan_hash!=plan.plan_hash
            or checkpoint.phase not in {'raw_verified','applying','committed','verified'}):
        raise BoundaryDenied('MATCHING_RESTORE_CHECKPOINT_REQUIRED')
    observed=digest(current)
    if observed==plan.post_fingerprint and checkpoint.phase in {'applying','committed','verified'}:
        return {**plan.receipt(),'state':'synthetic_projection_verified','replayed_effects':False}
    if observed==plan.raw_fingerprint and checkpoint.phase=='raw_verified':
        return {**plan.receipt(),'state':'blocked_projection_not_started','replayed_effects':False}
    raise BoundaryDenied('AMBIGUOUS_RESTORE_REQUIRES_REVIEW')


def native_activation_status():
    return {'allowed':False,'reason':'NATIVE_AUTHORITY_STORAGE_AND_STARTUP_INTEGRATION_UNAVAILABLE',
            'real_deletion_enabled':False,'complete_account_erasure':False}
