"""Stage18 snapshot invariants, not a database/restore certification.

Inputs are disposable rehearsal projections, never credentials or raw history.
The future PostgreSQL adapter must independently prove acquisition provenance.
This checker neither assigns ownership nor executes a migration or queue task.
"""
from collections import Counter
import re

BASE = '3bcd3e4e9022cc04b0319b84963457684d60e1a4'
TABLES = {
    'users': ('id', {'id','role','active'}),
    'profiles': ('user_id', {'user_id'}),
    'modules': ('key', {'key','user_id','enabled','version'}),
    'connections': ('id', {'id','owner_id','mode','account_hash'}),
    'history': ('key', {'key','owner_id','fingerprint'}),
    'orders': ('id', {'id','owner_id','fingerprint'}),
    'legacy_private': ('key', {'key','owner_id','ownership'}),
    'queued_work': ('id', {'id','owner_id','compatible','state'}),
}

class RehearsalViolation(ValueError):
    """Fixed error codes only; never echo input values or private content."""

def positive(value):
    return type(value) is int and value > 0

def snapshot(value):
    if type(value) is not dict or set(value) != set(TABLES):
        raise RehearsalViolation('CLOSED_SNAPSHOT_REQUIRED')
    result = {}
    for table, (key, fields) in TABLES.items():
        rows = value[table]
        if type(rows) is not list or len(rows) > 1000:
            raise RehearsalViolation('BOUNDED_ROWS_REQUIRED')
        indexed = {}
        for row in rows:
            if type(row) is not dict or set(row) != fields:
                raise RehearsalViolation('CLOSED_ROW_REQUIRED')
            for name, item in row.items():
                if name in {'user_id','id'} and table in {'users','profiles'}:
                    if not positive(item):raise RehearsalViolation('EXACT_USER_ID_REQUIRED')
                elif name in {'owner_id','user_id'}:
                    if not positive(item) and not (table in {'legacy_private','queued_work'} and item is None):
                        raise RehearsalViolation('EXACT_OWNER_REQUIRED')
                elif name in {'active','enabled','compatible'}:
                    if type(item) is not bool:raise RehearsalViolation('EXACT_BOOLEAN_REQUIRED')
                elif name == 'version':
                    if not positive(item):raise RehearsalViolation('EXACT_VERSION_REQUIRED')
                elif name in {'account_hash','fingerprint'}:
                    if type(item) is not str or not re.fullmatch('[0-9a-f]{64}',item):
                        raise RehearsalViolation('HASH_PROJECTION_REQUIRED')
                elif type(item) is not str or not 1 <= len(item) <= 128:
                    raise RehearsalViolation('BOUNDED_TEXT_REQUIRED')
            identity = row[key]
            if identity in indexed:raise RehearsalViolation('DUPLICATE_IDENTITY')
            indexed[identity] = dict(row)
        result[table] = indexed
    users = result['users']
    if any(row['role'] not in {'admin','user','viewer'} for row in users.values()):
        raise RehearsalViolation('UNKNOWN_ROLE')
    if any(row['mode'] not in {'user_owned','platform_managed'} for row in result['connections'].values()):
        raise RehearsalViolation('UNKNOWN_CONNECTION_MODE')
    for table in TABLES:
        owner = 'user_id' if table in {'profiles','modules'} else 'owner_id'
        if table == 'users':continue
        for row in result[table].values():
            identity = row[owner]
            if identity is not None and identity not in users:
                raise RehearsalViolation('ORPHAN_OWNER')
    for row in result['legacy_private'].values():
        if row['ownership'] not in {'owned','null','ambiguous','quarantined'}:
            raise RehearsalViolation('UNKNOWN_OWNERSHIP_STATE')
        if (row['owner_id'] is None) != (row['ownership'] in {'null','ambiguous','quarantined'}):
            raise RehearsalViolation('INCONSISTENT_OWNERSHIP')
    for row in result['queued_work'].values():
        if row['state'] not in {'pending','drained','cancelled','quarantined'} or row['compatible'] and row['owner_id'] is None:
            raise RehearsalViolation('INVALID_WORK_DISPOSITION')
    return result

def compare(before, after):
    old, new = snapshot(before), snapshot(after)
    for identity, row in old['users'].items():
        if new['users'].get(identity) != row:
            raise RehearsalViolation('EXISTING_IDENTITY_CHANGED')
    added = set(new['users']) - set(old['users'])
    for identity in added:
        if new['users'][identity]['role'] != 'user' or identity not in new['profiles']:
            raise RehearsalViolation('NEW_ACCOUNT_DEFAULTS')
    for identity in old['profiles']:
        if identity not in new['profiles']:raise RehearsalViolation('PROFILE_LOST')
    for table in ('modules','connections','history','orders'):
        # No new optional authority, connection copies or synthetic order
        # approvals can be justified by a migration snapshot alone.
        if new[table] != old[table]:
            raise RehearsalViolation('PRESERVATION_OR_AUTHORITY_CHANGED')
    for table in ('legacy_private','queued_work'):
        if set(new[table]) != set(old[table]):raise RehearsalViolation('REHEARSAL_ROW_SET_CHANGED')
    for identity, row in old['legacy_private'].items():
        migrated = new['legacy_private'][identity]
        if row['owner_id'] is None:
            if migrated['owner_id'] is not None or migrated['ownership'] != 'quarantined':
                raise RehearsalViolation('UNRESOLVED_OWNERSHIP_NOT_QUARANTINED')
        elif migrated != row:raise RehearsalViolation('PRIVATE_OWNER_CHANGED')
    for identity, row in old['queued_work'].items():
        migrated = new['queued_work'][identity]
        if any(migrated[k] != row[k] for k in ('id','owner_id','compatible')):
            raise RehearsalViolation('WORK_BINDING_CHANGED')
        if row['compatible']:
            if migrated['state'] != row['state']:raise RehearsalViolation('COMPATIBLE_WORK_CHANGED')
        elif migrated['state'] not in {'drained','cancelled','quarantined'}:
            raise RehearsalViolation('INCOMPATIBLE_WORK_NOT_CONTAINED')
    return {
        'baseline': BASE, 'validation_kind':'snapshot_invariants_only',
        'database_execution_verified':False, 'restore_verified':False,
        'new_accounts':len(added), 'users':len(new['users']),
        'row_counts':{table:len(rows) for table,rows in new.items()},
        'profile_counts_by_owner':dict(Counter(r['user_id'] for r in new['profiles'].values())),
        'module_counts_by_owner':dict(Counter(r['user_id'] for r in new['modules'].values())),
        'connection_counts_by_owner':dict(Counter(r['owner_id'] for r in new['connections'].values())),
        'history_counts_by_owner':dict(Counter(r['owner_id'] for r in new['history'].values())),
        'orphan_count':0, # snapshot() rejected every orphan before reporting.
        'quarantined_private_rows':sum(r['ownership']=='quarantined' for r in new['legacy_private'].values()),
    }

def verify_rollback(before, rolled_back):
    """An equality predicate for a later real failed-transaction rehearsal.

    This does not perform a rollback, restore a backup or prove acquisition.
    Unresolved ownership may remain unresolved when the migration was rolled
    back; requiring successful-migration quarantine here would hide that fact.
    """
    if snapshot(before) != snapshot(rolled_back):
        raise RehearsalViolation('ROLLBACK_LEFT_PARTIAL_CHANGES')
    return {'validation_kind':'snapshot_rollback_equality_only',
            'database_execution_verified':False,'restore_verified':False}
