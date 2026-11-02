"""Disposable PG18.6 forward composition only. No downgrade/collector/provider."""
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, UTC
from decimal import Decimal
import sqlalchemy as sa
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

URL = 'postgresql+psycopg2://audit_test:disposable_only@audit-three-head-pg18-20261101:5432/audit_three_head_disposable_3'
assert os.environ.get('DATABASE_URL') == URL and Path('/.dockerenv').exists()
assert not Path('/source/backend/.env').exists()
engine = sa.create_engine(URL)
assert sa.inspect(engine).get_table_names() == [], 'Refuse existing/nonempty database'
checks = []
def check(condition, name):
    assert condition, name
    checks.append(name)
    print('PASS', name, flush=True)
def upgrade(revision):
    subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', revision], cwd='/source/backend', check=True, timeout=180)
def heads():
    with engine.connect() as c:
        return set(c.execute(sa.text('SELECT version_num FROM alembic_version')).scalars())
def table(name):
    return sa.Table(name, sa.MetaData(), autoload_with=engine)
from scripts.verify_api_attempt_migration import baseline_snapshot, seed_baseline
import app.models  # canonical registry before relationship resolution
upgrade('audit7_run_policy_001')
seed_baseline(engine)
from app.domains.jobs.models import Job
from app.domains.jobs import execution_claim
from app.shared.types import JobStatus
with Session(engine) as s:
    job = s.get(Job, 1)
    job.status = JobStatus.PROCESSING
    s.commit()
    token = execution_claim.admit(s, 1, 'synthetic-original-delivery', now=100)
    check(token is not None, 'claim seeded through actual ownership admission')
    execution_claim.checkpoint(s, 1, token, provider_started=True, now=101)
    execution_claim.reconcile(s, 1, token, evidence={'response': 'Synthetic provider result retained', 'tokens_in': 3, 'tokens_out': 2, 'estimated_cost': 0.01})
before = baseline_snapshot(engine, exclude_tables=frozenset())
now = datetime(2026, 11, 1, tzinfo=UTC)
upgrade('a12_collection_intent_001')
with engine.begin() as c:
    c.execute(table('cost_collection_intents').insert().values(scope_key='synthetic-global', owner_token='synthetic-owner', state='ambiguous', request_inflight=True, request_sequence=2, started_at=now, completed_at=None, next_allowed_at=now))
upgrade('rebalance_spend_refund_002')
with engine.begin() as c:
    c.execute(table('rebalance_spend_scopes').insert().values(id=1, user_id=1, portfolio='india', authorization_key='synthetic-grant', cap_inr=20, settled_inr=5, reserved_inr=3, status='open', policy_version='synthetic-retained-v1', created_at=now))
    c.execute(table('rebalance_spend_bindings').insert().values(id=1, scope_id=1, user_id=1, portfolio='india', sequence=1, request_key='synthetic-request', intent='review'))
    for values in [dict(id=1, attempt_key='synthetic-settled', upper_inr=5, actual_inr=5, status='settled'), dict(id=2, attempt_key='synthetic-uncertain', upper_inr=3, actual_inr=None, status='reconciliation_needed')]:
        c.execute(table('rebalance_spend_attempts').insert().values(scope_id=1, job_id=1, provider='synthetic-never-called', model='synthetic', tariff_version='synthetic-v1', fx_version='synthetic-v1', created_at=now, **values))
    c.execute(table('rebalance_spend_refunds').insert().values(id=1, scope_id=1, attempt_id=1, refund_key='synthetic-refund', amount_inr=1, settlement_reference='synthetic-settlement', evidence_hash='a'*64, created_at=now))
upgrade('jobs_admission_dispatch_001')
import uuid
with engine.begin() as c:
    c.execute(table('job_admissions').insert().values(id=1, user_id=1, operation='jobs.create.v1', request_key_hash='b'*64, fingerprint='c'*64, job_id=1, created_at=now, updated_at=now))
    c.execute(table('outbox').insert().values(id=uuid.UUID(int=2), topic='synthetic.never.publish', payload={'synthetic': True}, created_at=now, attempts=1, job_id=1, state='claimed', claim_token='synthetic-dispatch-owner', next_attempt_at=now))
check(heads() == {'jobs_admission_dispatch_001', 'a12_collection_intent_001', 'rebalance_spend_refund_002'}, 'three exact sibling heads before merge')
# Compare original rows byte-for-byte; outbox has only the named additive fields.
prior = baseline_snapshot(engine, exclude_tables=frozenset(), include_tables=set(before))
for name, entry in before.items():
    old_rows = [json.loads(row) for row in entry['rows']]
    new_rows = [json.loads(row) for row in prior[name]['rows']]
    for old in old_rows:
        check(any(all(new.get(key) == value for key, value in old.items()) for new in new_rows), 'original row preserved:' + name)
    for key in ('columns', 'indexes', 'unique', 'primary_key', 'foreign_keys', 'checks'):
        if name != 'outbox':
            check(prior[name][key] == entry[key], 'prior schema preserved:' + name + ':' + key)
    if name == 'outbox':
        old_names = {v[0] for v in entry['columns']}
        check([v for v in prior[name]['columns'] if v[0] in old_names] == entry['columns'], 'outbox prior columns unchanged')
        check({v[0] for v in prior[name]['columns']} - old_names == {'job_id','state','claim_token','next_attempt_at','last_error_type'}, 'only registered outbox columns added')
pre_merge = baseline_snapshot(engine, exclude_tables=frozenset())
upgrade('a12_three_head_merge_001')
check(heads() == {'a12_three_head_merge_001'}, 'single combined merge head')
check(baseline_snapshot(engine, exclude_tables=frozenset()) == pre_merge, 'no-op merge preserves all schema and all seeded rows')
upgrade('head')
check(baseline_snapshot(engine, exclude_tables=frozenset()) == pre_merge, 'repeated upgrade preserves all schema and rows')

from app.infrastructure.database.base import Base
from app.domains.cost_drivers.models import CostCollectionIntent
from app.domains.rebalance_budget.models import RebalanceSpendScope, RebalanceSpendBinding, RebalanceSpendAttempt, RebalanceSpendRefund
from app.domains.jobs.admission import JobAdmission
models = [CostCollectionIntent, JobAdmission, RebalanceSpendScope, RebalanceSpendBinding, RebalanceSpendAttempt, RebalanceSpendRefund]
inspector = sa.inspect(engine)
for model in models:
    expected = model.__table__
    columns = {column['name']: column for column in inspector.get_columns(expected.name)}
    check(set(columns) == set(expected.columns.keys()), 'model columns:' + expected.name)
    for column in expected.columns:
        actual = columns[column.name]
        check(actual['nullable'] == column.nullable, 'model nullability:' + expected.name + '.' + column.name)
        for field in ('_type_affinity','length','timezone','precision','scale'):
            check(getattr(actual['type'], field, None) == getattr(column.type, field, None), 'model type:' + expected.name + '.' + column.name + ':' + field)
    with Session(engine) as s:
        check(len(s.execute(sa.select(model)).scalars().all()) >= 1, 'actual ORM reads:' + expected.name)
check({'api_usage_attempt_events','recommendation_decisions','job_admissions','cost_collection_intents','rebalance_spend_refunds'}.issubset(Base.metadata.tables), 'peer catalog registrations retained')

def reject(values, name, expected_sqlstate):
    try:
        with engine.begin() as c:
            c.execute(values)
    except IntegrityError as exc:
        check(exc.orig.pgcode == expected_sqlstate, name)
    else:
        raise AssertionError('Constraint did not reject:' + name)
def clone(name, **changes):
    t = table(name)
    with engine.connect() as c:
        row = dict(c.execute(sa.select(t)).mappings().first())
    row.update(changes)
    return t.insert().values(**row)
reject(clone('job_admissions', id=100, user_id=9999, job_id=9999, request_key_hash='d'*64), 'admission actor/job FK', '23503')
reject(clone('rebalance_spend_scopes', id=100, user_id=9999, authorization_key='other'), 'cap user FK', '23503')
reject(clone('rebalance_spend_bindings', id=100, scope_id=9999, sequence=2, request_key='other'), 'binding scope FK', '23503')
reject(clone('rebalance_spend_attempts', id=100, job_id=9999, attempt_key='other'), 'attempt job FK', '23503')
reject(clone('rebalance_spend_attempts', id=100, scope_id=9999, attempt_key='other'), 'attempt scope FK', '23503')
reject(clone('rebalance_spend_refunds', id=100, attempt_id=9999, refund_key='other'), 'refund attempt FK', '23503')
reject(clone('rebalance_spend_refunds', id=100, scope_id=9999, refund_key='other'), 'refund scope FK', '23503')
reject(clone('outbox', id=uuid.UUID(int=100), job_id=9999), 'outbox job FK', '23503')
reject(clone('cost_collection_intents'), 'intent scope uniqueness', '23505')
reject(clone('job_admissions', id=100), 'admission request/job uniqueness', '23505')
reject(clone('rebalance_spend_scopes', id=100), 'grant uniqueness', '23505')
reject(clone('rebalance_spend_bindings', id=100), 'binding identity uniqueness', '23505')
reject(clone('rebalance_spend_attempts', id=100), 'attempt identity uniqueness', '23505')
reject(clone('rebalance_spend_refunds', id=100), 'refund identity uniqueness', '23505')
reject(clone('rebalance_spend_scopes', id=100, authorization_key='other', cap_inr=21), 'fixed cap constraint', '23514')
reject(clone('rebalance_spend_bindings', id=100, sequence=0, request_key='other'), 'positive workflow sequence', '23514')
reject(clone('rebalance_spend_attempts', id=100, attempt_key='other', upper_inr=0), 'positive reservation constraint', '23514')
reject(clone('rebalance_spend_refunds', id=100, refund_key='other', amount_inr=0), 'positive refund constraint', '23514')
check(baseline_snapshot(engine, exclude_tables=frozenset()) == pre_merge, 'constraint failures preserve every ledger row')

# Simulate old-application readback against retained additive schema. No Alembic downgrade.
env = {**os.environ, 'PYTHONPATH': '/deps:/oldsource/backend'}
subprocess.run([sys.executable, '-c', '''
import os, sqlalchemy as sa
import app.models
from sqlalchemy.orm import Session
from app.domains.jobs.models import Job
from app.domains.jobs import execution_claim
e=sa.create_engine(os.environ['DATABASE_URL'])
with Session(e) as s:
 j=s.get(Job,1);assert j.response=='Synthetic provider result retained'
 assert j.runtime_metadata_json['execution_claim']['state']=='reconciliation_needed'
 assert j.runtime_metadata_json['execution_claim']['provider_started'] is True
 assert execution_claim.admit(s,1,'synthetic-redelivery',now=10000) is None
with e.connect() as c:
 assert c.execute(sa.text("SELECT state FROM cost_collection_intents")).scalar_one()=='ambiguous'
 assert c.execute(sa.text("SELECT reserved_inr FROM rebalance_spend_scopes")).scalar_one()==3
 assert c.execute(sa.text("SELECT count(*) FROM rebalance_spend_refunds")).scalar_one()==1
print('PASS old-application readback retained additive ledgers and ambiguous claim, no provider replay')
'''], cwd='/oldsource', env=env, check=True)
check(baseline_snapshot(engine, exclude_tables=frozenset()) == pre_merge, 'application rollback readback preserves all data/schema, claims and outstanding reservation')
check(heads() == {'a12_three_head_merge_001'}, 'application rollback does not downgrade schema')
with engine.connect() as c:
    version = c.execute(sa.text('SELECT version()')).scalar_one()
    check(version.startswith('PostgreSQL 18.6 '), 'exact PG18.6 server')
Path('/evidence/pg18-three-head-receipt.json').write_text(json.dumps({'checks_passed':len(checks),'checks':checks,'server':version,'heads':sorted(heads()),'rollback':'old-application readback only; additive schema and ledgers retained; no downgrade executed','scope':'synthetic fixture only; no provider, relay, collector or financial adapter activated'},indent=2)+'\n')
print('PASS ALL',len(checks),'checks')
