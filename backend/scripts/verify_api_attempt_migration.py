"""Exercise the API attempt migration only in the disposable CI backend container.

No provider clients, workers, production configuration, or real data are used.
The database must be empty initially; this script never resets an existing DB.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Mapping
from uuid import uuid4

import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError

BACKEND = Path(__file__).resolve().parents[1]
BASELINE = "universal_scan_001"
REVISION = "api_attempt_events_001"
EVENT_TABLE = "api_usage_attempt_events"
TEST_DATABASE_URL = (
    "postgresql+psycopg2://migration_test:migration_test@postgres:5432/"
    "api_attempt_migration_test"
)
TEST_ENVIRONMENT = {
    "CI": "true",
    "GITHUB_ACTIONS": "true",
    "ENVIRONMENT": "test",
    "API_ATTEMPT_MIGRATION_TEST": "disposable-postgres-only",
    "DATABASE_URL": TEST_DATABASE_URL,
    "REDIS_URL": "redis://127.0.0.1:6379/15",
}


def guarded_environment(environment: Mapping[str, str]) -> dict[str, str]:
    """Fail before connecting; even URL query/driver/credential changes are refused."""
    if any(environment.get(key) != value for key, value in TEST_ENVIRONMENT.items()):
        raise RuntimeError("Migration verification requires the exact disposable CI environment")
    if not Path("/.dockerenv").is_file():
        raise RuntimeError("Alembic verification must run inside the Docker backend container")
    if (BACKEND / ".env").exists():
        raise RuntimeError("Refusing to load a backend .env during migration verification")
    # Do not pass inherited provider credentials, libpq overrides, or service URLs
    # into Alembic/model imports. The fixed URL can address only the CI service.
    return {**TEST_ENVIRONMENT, "PATH": environment.get("PATH", ""), "PYTHONPATH": str(BACKEND)}


def alembic(*arguments: str) -> None:
    subprocess.run(
        [sys.executable, "-m", "alembic", *arguments],
        cwd=BACKEND,
        env=guarded_environment(os.environ),
        check=True,
        timeout=180,
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def revision(engine: sa.Engine) -> str:
    table = sa.Table("alembic_version", sa.MetaData(), autoload_with=engine)
    with engine.connect() as connection:
        return connection.execute(sa.select(table.c.version_num)).scalar_one()


def baseline_snapshot(engine: sa.Engine, *, exclude_tables=frozenset({EVENT_TABLE}), include_tables=None) -> dict:
    """Capture every baseline table's schema and synthetic rows, excluding the revision."""
    inspector = sa.inspect(engine)
    snapshot = {}
    with engine.connect() as connection:
        names=set(inspector.get_table_names()) - {"alembic_version"} - set(exclude_tables)
        if include_tables is not None: names &= set(include_tables)
        for name in sorted(names):
            table = sa.Table(name, sa.MetaData(), autoload_with=connection)
            snapshot[name] = {
                "columns": [
                    (column["name"], str(column["type"]), column["nullable"], column["default"])
                    for column in inspector.get_columns(name)
                ],
                "indexes": inspector.get_indexes(name),
                "unique": inspector.get_unique_constraints(name),
                "primary_key": inspector.get_pk_constraint(name),
                "foreign_keys": inspector.get_foreign_keys(name),
                "checks": inspector.get_check_constraints(name),
                "rows": sorted(
                    json.dumps(dict(row), sort_keys=True, default=str)
                    for row in connection.execute(sa.select(table)).mappings()
                ),
            }
    return snapshot


def normalize_stage12_additions(before: dict, checked: dict) -> None:
    """Remove only fully verified Stage12 additions from the legacy comparison.

    The caller already deep-copied evidence. Older fields and all unrecognized
    objects remain for the final exact schema/data comparison.
    """
    additions={
        'auto_rebalance_workflows':{
            'orchestration_kind':('VARCHAR(24)',True,None),
            'request_key':('VARCHAR(128)',True,None),
            'execution_json':('JSON',True,None),
            'control_version':('INTEGER',False,0)},
        'auto_rebalance_workflow_stages':{
            'checkpoint_json':('JSON',True,None),
            'attempt_count':('INTEGER',False,0)},
        'zerodha_portfolio_snapshots':{'acquisition_json':('JSON',True,None)}}
    for table,expected in additions.items():
        if table not in before or table not in checked:continue
        old_names={column[0] for column in before[table]['columns']}
        added={column[0]:column for column in checked[table]['columns'] if column[0] not in old_names}
        introduced=set(added)&set(expected)
        if not introduced:continue
        require(introduced==set(expected) and not old_names&set(expected),
                'Incomplete Stage12 column addition: '+table)
        for name,(kind,nullable,default) in expected.items():
            column=added[name]
            require(column[1]==kind and type(column[2]) is bool and column[2] is nullable,
                    'Unexpected Stage12 column definition: '+table+'.'+name)
            require(column[3] is None if default is None else column[3] in ('0',"'0'","'0'::integer"),
                    'Unexpected Stage12 column default: '+table+'.'+name)
        if table=='auto_rebalance_workflows':
            name='uq_analysis_owner_request'
            definitions={
                'unique':{'column_names':['user_id','request_key']},
                'indexes':{'column_names':['user_id','request_key'],'unique':True,'duplicates_constraint':name}}
            for category,fields in definitions.items():
                matches=[item for item in checked[table][category] if item.get('name')==name]
                require(len(matches)==1,'Missing/duplicate Stage12 constraint/index: '+name)
                item=matches[0]
                require(all(type(item.get(key)) is type(value) and item.get(key)==value for key,value in fields.items()),
                        'Changed Stage12 constraint/index: '+name)
                extras=set(item)-{'name',*fields}
                require(extras<=({'comment','dialect_options'} if category=='unique' else {'include_columns','dialect_options'}),
                        'Unknown Stage12 constraint metadata')
                require(item.get('comment') is None and item.get('include_columns',[])==[],
                        'Unexpected Stage12 index/comment metadata')
                dialect=item.get('dialect_options',{})
                require(set(dialect)<={'postgresql_include','postgresql_nulls_not_distinct'}
                        and dialect.get('postgresql_include',[])==[]
                        and dialect.get('postgresql_nulls_not_distinct',False) is False,
                        'Unexpected Stage12 dialect metadata')
                checked[table][category]=[entry for entry in checked[table][category] if entry.get('name')!=name]
        checked[table]['columns']=[column for column in checked[table]['columns'] if column[0] not in expected]
        rows=[]
        for row in checked[table]['rows']:
            values=json.loads(row)
            for name,(_,_,default) in expected.items():
                value=values.pop(name,'missing')
                require(value is None if default is None else type(value) is int and value==0,
                        'Legacy Stage12 input/checkpoint was invented: '+table+'.'+name)
            rows.append(json.dumps(values,sort_keys=True))
        checked[table]['rows']=sorted(rows)


def require_forward_baseline_preserved(before: dict, after: dict) -> None:
    """Permit only named Stage04/07/11/12 additive fields, never arbitrary drift.

    Existing columns, constraints, indexes and values retain the strict check.
    The separate Stage04 Docker gate proves its full up/down/up migration.
    """
    checked = deepcopy(after)
    normalize_stage12_additions(before,checked)
    if "outbox" in before and "outbox" in checked:
        old_names = {column[0] for column in before["outbox"]["columns"]}
        added = {column[0]:column for column in checked["outbox"]["columns"] if column[0] not in old_names}
        if added:
            require(set(added) == {"available_at", "execution_attempts"}, "Unexpected forward outbox column addition")
            require(tuple(added["available_at"][1:]) == ("TIMESTAMP", True, None), "Unexpected available_at definition")
            attempt = added["execution_attempts"]
            require(attempt[1] == "INTEGER" and attempt[2] is False and attempt[3] in ("0", "'0'", "'0'::integer"), "Unexpected execution_attempts definition")
            checked["outbox"]["columns"] = [column for column in checked["outbox"]["columns"] if column[0] in old_names]
            rows = []
            for row in checked["outbox"]["rows"]:
                values = json.loads(row)
                require(values.pop("available_at", "missing") is None and values.pop("execution_attempts", None) == 0,
                        "Legacy outbox delivery state changed")
                rows.append(json.dumps(values, sort_keys=True))
            checked["outbox"]["rows"] = sorted(rows)
    for table in ('jobs','runs','auto_rebalance_workflows'):
        if table not in before or table not in checked:continue
        old_names={column[0] for column in before[table]['columns']}
        added={column[0]:column for column in checked[table]['columns'] if column[0] not in old_names}
        if not added:continue
        require(set(added)=={'module_id','module_version','module_cancel_requested'},'Unexpected forward module lifecycle column addition')
        require(tuple(added['module_id'][1:])==('VARCHAR(40)',True,None),'Unexpected module_id definition')
        require(tuple(added['module_version'][1:])==('INTEGER',True,None),'Unexpected module_version definition')
        cancellation=added['module_cancel_requested']
        require(cancellation[1]=='BOOLEAN' and cancellation[2] is False and cancellation[3] in ('false',"'false'::boolean"),'Unexpected cancellation definition')
        checked[table]['columns']=[column for column in checked[table]['columns'] if column[0] in old_names]
        rows=[]
        for row in checked[table]['rows']:
            values=json.loads(row)
            require(values.pop('module_id','missing') is None and values.pop('module_version','missing') is None and values.pop('module_cancel_requested',None) is False,'Legacy module work was attributed or changed')
            rows.append(json.dumps(values,sort_keys=True))
        checked[table]['rows']=sorted(rows)
    table='indmoney_us_portfolio_snapshots'
    if table in before and table in checked:
        old_names={column[0] for column in before[table]['columns']}
        added={column[0]:column for column in checked[table]['columns'] if column[0] not in old_names}
        if added:
            expected={'acceptance_state':('VARCHAR(24)',False), 'import_key':('VARCHAR(64)',True),
                      'content_hash':('VARCHAR(64)',True), 'import_provenance':('JSON',True),
                      'accepted_at':('TIMESTAMP',True), 'supersedes_id':('INTEGER',True)}
            require(set(added)==set(expected),'Unexpected forward INDmoney column addition')
            for name,(kind,nullable) in expected.items():
                column=added[name]
                require(column[1:3]==(kind,nullable),'Unexpected INDmoney column definition: '+name)
                require(column[3] in ("'legacy_unverified'::character varying", "'legacy_unverified'") if name=='acceptance_state' else column[3] is None,
                        'Unexpected INDmoney column default: '+name)
            checked[table]['columns']=[column for column in checked[table]['columns'] if column[0] in old_names]
            # Reflectors include the unique constraint's backing index. Check
            # every semantic field and known reflection-only metadata before
            # removing exactly this new object from the baseline comparison.
            definitions={
                'unique':('uq_indmoney_owner_import',{'column_names':['user_id','import_key']}),
                'indexes':('uq_indmoney_owner_import',{'column_names':['user_id','import_key'],'unique':True,'duplicates_constraint':'uq_indmoney_owner_import'}),
                'foreign_keys':('fk_indmoney_correction',{'constrained_columns':['supersedes_id'],'referred_schema':None,'referred_table':table,'referred_columns':['id'],'options':{'ondelete':'RESTRICT'}})}
            for category,(name,fields) in definitions.items():
                matches=[item for item in checked[table][category] if item.get('name')==name]
                require(len(matches)==1,'Missing/duplicate INDmoney constraint/index: '+name)
                item=matches[0]
                require(all(item.get(key)==value for key,value in fields.items()),'Changed INDmoney constraint/index: '+name)
                extras=set(item)-{'name',*fields}
                require(extras<=({'comment','dialect_options'} if category=='unique' else {'include_columns','dialect_options'} if category=='indexes' else {'comment'}),'Unknown INDmoney constraint metadata')
                require(item.get('comment') is None and item.get('include_columns',[])==[], 'Unexpected INDmoney index/comment metadata')
                dialect=item.get('dialect_options',{})
                require(set(dialect)<={'postgresql_include','postgresql_nulls_not_distinct'} and dialect.get('postgresql_include',[])==[] and dialect.get('postgresql_nulls_not_distinct',False) is False,'Unexpected INDmoney dialect metadata')
                checked[table][category]=[entry for entry in checked[table][category] if entry.get('name')!=name]
            rows=[]
            for row in checked[table]['rows']:
                values=json.loads(row)
                require(values.pop('acceptance_state','missing')=='legacy_unverified','Legacy import was accepted or changed')
                require(all(values.pop(name,'missing') is None for name in expected if name!='acceptance_state'),'Legacy import provenance was invented')
                rows.append(json.dumps(values,sort_keys=True))
            checked[table]['rows']=sorted(rows)
    require(checked == before, "Forward head upgrade changed existing schema/data")


def seed_baseline(engine: sa.Engine) -> None:
    metadata = sa.MetaData()
    metadata.reflect(engine, only=["users", "jobs", "universal_scan_settings", "universal_scan_states"])
    now = datetime.now(UTC).replace(tzinfo=None)
    with engine.begin() as connection:
        connection.execute(metadata.tables["users"].insert().values(
            id=1, email="migration-test@example.invalid", username="migration_test",
            password_hash="synthetic-non-login-value", role="USER", is_active=False,
            is_verified=False, created_at=now, updated_at=now,
        ))
        connection.execute(metadata.tables["jobs"].insert().values(
            id=1, user_id=1, prompt="Synthetic migration fixture; never executed",
            provider="synthetic", model="synthetic", status="completed",
            created_at=now, updated_at=now,
        ))
        for name in ("universal_scan_settings", "universal_scan_states"):
            connection.execute(metadata.tables[name].insert().values(
                user_id=1, payload={"synthetic_migration_fixture": True},
                created_at=now, updated_at=now,
            ))


def verify_schema(engine: sa.Engine) -> None:
    from app.domains.api_usage.models import ApiUsageAttemptEvent

    inspector = sa.inspect(engine)
    expected = ApiUsageAttemptEvent.__table__
    actual = {column["name"]: column for column in inspector.get_columns(EVENT_TABLE)}
    require(set(actual) == set(expected.columns.keys()), "Migration/model column mismatch")
    for column in expected.columns:
        observed = actual[column.name]
        require(observed["nullable"] == column.nullable, f"Nullability mismatch: {column.name}")
        for attribute in ("_type_affinity", "length", "timezone"):
            require(
                getattr(observed["type"], attribute, None) == getattr(column.type, attribute, None),
                f"Type mismatch: {column.name} ({attribute})",
            )
    require(inspector.get_pk_constraint(EVENT_TABLE)["constrained_columns"] == ["event_id"], "Event primary key mismatch")
    require(
        {tuple(item["column_names"]) for item in inspector.get_unique_constraints(EVENT_TABLE)}
        == {("attempt_id", "event_kind"), ("response_dedupe_key",), ("request_dedupe_key",)},
        "Attempt uniqueness constraints mismatch",
    )
    expected_indexes = {
        (f"ix_{EVENT_TABLE}_{name}", (name,))
        for name in ("attempt_id", "user_id", "job_id", "execution_id", "run_id", "actual_provider", "started_at")
    }
    require(
        {(item["name"], tuple(item["column_names"])) for item in inspector.get_indexes(EVENT_TABLE) if not item["unique"]}
        == expected_indexes,
        "Attempt lookup indexes mismatch",
    )
    require(
        {(tuple(item["constrained_columns"]), item["referred_table"], tuple(item["referred_columns"]), item["options"].get("ondelete"))
         for item in inspector.get_foreign_keys(EVENT_TABLE)}
        == {(("user_id",), "users", ("id",), "SET NULL"), (("job_id",), "jobs", ("id",), "SET NULL")},
        "Attempt foreign keys mismatch",
    )


def verify_events(engine: sa.Engine) -> None:
    table = sa.Table(EVENT_TABLE, sa.MetaData(), autoload_with=engine)
    now = datetime.now(UTC)
    started = dict(
        attempt_id=str(uuid4()), event_id=str(uuid4()), event_kind="started", user_id=1,
        job_id=1, phase="request", requested_provider="synthetic", actual_provider="synthetic",
        started_at=now, status="started", instrumentation_scope="ci_synthetic",
    )
    finished = dict(
        started, event_id=str(uuid4()), event_kind="finished", status="success",
        finished_at=now + timedelta(milliseconds=10), latency_ms=10.0,
        response_dedupe_key="synthetic-response", request_dedupe_key="synthetic-request",
        reported_usage={"input_tokens": 11, "output_tokens": 7},
    )
    with engine.begin() as connection:
        connection.execute(table.insert().values(**started))
        original = dict(connection.execute(sa.select(table).where(table.c.event_id == started["event_id"])).mappings().one())
        connection.execute(table.insert().values(**finished))
        # Independent lifecycle rows can both have NULL request/response dedupe keys.
        connection.execute(table.insert().values(**dict(started, attempt_id=str(uuid4()), event_id=str(uuid4()))))
        require(connection.scalar(sa.select(sa.func.count()).select_from(table)) == 3, "Lifecycle events did not append")
        require(dict(connection.execute(sa.select(table).where(table.c.event_id == started["event_id"])).mappings().one()) == original, "Appending a finish changed the start row")
        require(connection.execute(sa.select(table.c.reported_usage).where(table.c.event_id == finished["event_id"])).scalar_one() == finished["reported_usage"], "JSON usage did not round-trip")
        cases = {
            "event primary key": dict(started, attempt_id=str(uuid4())),
            "attempt/event kind": dict(started, event_id=str(uuid4())),
            "response dedupe": dict(started, attempt_id=str(uuid4()), event_id=str(uuid4()), response_dedupe_key=finished["response_dedupe_key"]),
            "request dedupe": dict(started, attempt_id=str(uuid4()), event_id=str(uuid4()), request_dedupe_key=finished["request_dedupe_key"]),
        }
        for label, values in cases.items():
            try:
                with connection.begin_nested():
                    connection.execute(table.insert().values(**values))
            except IntegrityError:
                pass
            else:
                raise AssertionError(f"Missing uniqueness enforcement: {label}")
        require(connection.scalar(sa.select(sa.func.count()).select_from(table)) == 3, "Rejected duplicates changed event count")


def main() -> None:
    environment = guarded_environment(os.environ)
    os.environ.clear()
    os.environ.update(environment)
    engine = sa.create_engine(TEST_DATABASE_URL, connect_args={"connect_timeout": 5})
    try:
        require(not sa.inspect(engine).get_table_names(), "Refusing to modify a non-empty database")
        alembic("upgrade", BASELINE)
        require(revision(engine) == BASELINE, "Baseline upgrade did not reach the expected revision")
        seed_baseline(engine)
        original = baseline_snapshot(engine)
        baseline_tables = set(sa.inspect(engine).get_table_names())
        alembic("upgrade", REVISION)
        require(revision(engine) == REVISION, "Attempt migration revision mismatch")
        require(set(sa.inspect(engine).get_table_names()) == baseline_tables | {EVENT_TABLE}, "Upgrade changed unrelated tables")
        verify_schema(engine)
        verify_events(engine)
        require(baseline_snapshot(engine) == original, "Upgrade changed baseline schema/data")
        alembic("downgrade", BASELINE)
        require(revision(engine) == BASELINE, "Downgrade revision mismatch")
        require(set(sa.inspect(engine).get_table_names()) == baseline_tables, "Downgrade removed unrelated tables")
        require(baseline_snapshot(engine) == original, "Downgrade changed baseline schema/data")
        # Round-trip only this reversible named revision. Later audit history
        # migrations are forward-only and must never enter this downgrade path.
        alembic("upgrade", REVISION)
        require(revision(engine) == REVISION, "Re-upgrade did not reach the named attempt migration")
        verify_schema(engine)
        require(baseline_snapshot(engine) == original, "Re-upgrade changed baseline schema/data")
        table = sa.Table(EVENT_TABLE, sa.MetaData(), autoload_with=engine)
        with engine.connect() as connection:
            require(connection.scalar(sa.select(sa.func.count()).select_from(table)) == 0, "Recreated event table is not empty")
        verify_events(engine)
        before=baseline_snapshot(engine,exclude_tables=frozenset())
        # Exercise env.py and the complete revision chain, including version
        # stamping. Calling a migration's upgrade() directly cannot prove this.
        from alembic.config import Config
        from alembic.script import ScriptDirectory
        scripts=ScriptDirectory.from_config(Config(str(BACKEND/"alembic.ini")))
        head=scripts.get_current_head()
        require(bool(head), "Migration chain has no single head")
        require(REVISION in {item.revision for item in scripts.walk_revisions()}, "Named revision absent from chain")
        alembic("upgrade", "head")
        require(revision(engine)==head, "Full-chain upgrade did not stamp its exact head")
        alembic("current", "--check-heads")
        verify_schema(engine)
        require_forward_baseline_preserved(before, baseline_snapshot(engine,exclude_tables=frozenset(),include_tables=before))
        after=baseline_snapshot(engine,exclude_tables=frozenset())
        alembic("upgrade", "head")
        require(revision(engine)==head, "Idempotent upgrade changed head stamp")
        require(baseline_snapshot(engine,exclude_tables=frozenset())==after, "Repeated head upgrade changed schema/data")
        print(f"PASS: named attempt migration roundtrip; complete forward chain stamped {head}; prior synthetic data and schema preserved; repeated upgrade unchanged.")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
