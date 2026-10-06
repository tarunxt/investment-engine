"""Exercise the API attempt migration only in the disposable CI backend container.

No provider clients, workers, production configuration, or real data are used.
The database must be empty initially; this script never resets an existing DB.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import hashlib
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
# Public deterministic fixture for disposable migration imports only. Never use
# this value as a runtime credential or inherit a real signing key from the host.
TEST_JWT_SECRET_KEY = hashlib.sha256(b"credx-api-attempt-migration-tests-only").hexdigest()


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
    return {
        **TEST_ENVIRONMENT,
        "PATH": environment.get("PATH", ""),
        "PYTHONPATH": str(BACKEND),
        "JWT_SECRET_KEY": TEST_JWT_SECRET_KEY,
    }


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


def baseline_snapshot(engine: sa.Engine) -> dict:
    """Capture every baseline table's schema and synthetic rows, excluding the revision."""
    inspector = sa.inspect(engine)
    snapshot = {}
    with engine.connect() as connection:
        for name in sorted(set(inspector.get_table_names()) - {"alembic_version", EVENT_TABLE}):
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
        alembic("upgrade", "head")
        require(revision(engine) == REVISION, "Re-upgrade did not reach the attempt migration head")
        alembic("current", "--check-heads")
        verify_schema(engine)
        require(baseline_snapshot(engine) == original, "Re-upgrade changed baseline schema/data")
        table = sa.Table(EVENT_TABLE, sa.MetaData(), autoload_with=engine)
        with engine.connect() as connection:
            require(connection.scalar(sa.select(sa.func.count()).select_from(table)) == 0, "Recreated event table is not empty")
        print("PASS: baseline upgrade; attempt schema, indexes, append and uniqueness; isolated downgrade; head re-upgrade; baseline data preserved.")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
