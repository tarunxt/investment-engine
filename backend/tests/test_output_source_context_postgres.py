"""Opt-in runtime guards for source freezing in disposable LOCAL PostgreSQL.

Use CREDX_AUDIT_TEST_DATABASE_URL pointing to localhost/credx_audit_test_*
and CREDX_AUDIT_TEST_DATABASE_ACK=disposable-local-only, like the audit suite.
DATABASE_URL is never an integration target. Only a fresh random schema is
created/dropped. No provider, queue, market, portfolio or production call runs.
"""
import json
import os
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.schema import CreateSchema, DropSchema

import app.models  # noqa: F401
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.domains.jobs.output_contracts import normalize_output, source_hash
from app.domains.jobs.output_contracts.consistency import inspect_output_consistency
from app.domains.jobs.output_sources import (
    MAX_OUTPUT_SOURCE_BYTES, OutputSourceJobReference, freeze_output_source_context,
    frozen_sources_from_context,
)
from app.domains.prompts.models import Prompt
from app.domains.runs.models import Run, RunJob
from app.infrastructure.database.base import Base
from app.shared.exceptions import ValidationException
from app.shared.types import JobStatus
from test_output_contracts import holding, rebalance_row, swing_row


TABLES = [model.__table__ for model in (User, Prompt, Job, Run, RunJob)]
TARGET = SimpleNamespace(prompt="[REBALANCE_FLOW:india]", auto_rebalance_portfolio="india",
                         auto_rebalance_label="India Run #99 (Rebalance Scan)")


def guarded_test_url(raw, acknowledgement):
    url = make_url(raw)
    if (acknowledgement != "disposable-local-only"
            or url.drivername not in {"postgresql", "postgresql+asyncpg"}
            or url.host not in {"localhost", "127.0.0.1", "::1"}
            or not (url.database or "").startswith("credx_audit_test_")
            or url.query):
        raise ValueError("Output source tests require an explicitly acknowledged disposable local test database")
    return url.set(drivername="postgresql+asyncpg")


@pytest.mark.parametrize("raw,ack", [
    ("postgresql://test:test@remote.example/credx_audit_test_ci", "disposable-local-only"),
    ("postgresql://test:test@localhost/production", "disposable-local-only"),
    ("postgresql://test:test@localhost/credx_audit_test_ci", ""),
    ("postgresql://test:test@localhost/credx_audit_test_ci?host=remote.example", "disposable-local-only"),
    ("sqlite:///credx_audit_test_ci", "disposable-local-only"),
])
def test_source_guard_refuses_non_disposable_targets(raw, ack):
    with pytest.raises(ValueError, match="disposable local"):
        guarded_test_url(raw, ack)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def postgres_sources():
    raw = os.environ.get("CREDX_AUDIT_TEST_DATABASE_URL")
    if not raw:
        pytest.skip("explicit disposable local PostgreSQL test URL not configured")
    url = guarded_test_url(raw, os.environ.get("CREDX_AUDIT_TEST_DATABASE_ACK"))
    schema = "credx_output_sources_test_" + uuid.uuid4().hex
    engine = create_async_engine(
        url, pool_size=3, max_overflow=0, isolation_level="READ COMMITTED",
        connect_args={"server_settings": {"search_path": schema, "statement_timeout": "10000"}},
    )
    created = False
    try:
        async with engine.begin() as connection:
            await connection.execute(CreateSchema(schema))
        created = True
        async with engine.begin() as connection:
            await connection.run_sync(lambda db: Base.metadata.create_all(db, tables=TABLES))
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as db:
            db.add_all([User(id=7, email="owner@example.test", username="owner", password_hash="unused"),
                        User(id=8, email="other@example.test", username="other", password_hash="unused")])
            await db.commit()
        yield SimpleNamespace(engine=engine, sessions=sessions)
    finally:
        if created:
            async with engine.begin() as connection:
                await connection.execute(DropSchema(schema, cascade=True))
        await engine.dispose()


async def seed_run(database, *, run_id=501, job_ids=(11, 12), owner=7):
    references = []
    metadata = dict(prompt="India swing-trade study", status=JobStatus.COMPLETED,
                    auto_rebalance_portfolio="india", auto_rebalance_label="India Run #1 (Swing Scan)")
    async with database.sessions() as db:
        db.add(Run(id=run_id, user_id=owner, prompt_preview="India swing-trade study", **metadata))
        await db.flush()
        for ordinal, job_id in enumerate(job_ids):
            # Non-ASCII deliberately remains literal for PostgreSQL octet_length.
            response = json.dumps([swing_row("ABC" if ordinal == 0 else "OTHER",
                                            stock_name="Synthetic ₹ café")], ensure_ascii=False)
            db.add(Job(id=job_id, user_id=owner, provider="mock", model="independent-sample",
                       response=response, **metadata))
            await db.flush()
            db.add(RunJob(run_id=run_id, job_id=job_id, stage=1))
            references.append(OutputSourceJobReference(run_id=run_id, job_id=job_id,
                                                       response_sha256=source_hash(response)))
        await db.commit()
    return references


class ObservedSession(AsyncSession):
    """Observe real SQL results and optionally interleave another real session.

    Result.freeze() produces replayable SQLAlchemy results, not mocked query rows.
    The underlying metadata and response statements still execute in PostgreSQL.
    """

    def __init__(self, *args, between_reads=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.between_reads = between_reads
        self.calls = 0
        self.preflight = []
        self.hydrated = []

    async def execute(self, statement, *args, **kwargs):
        self.calls += 1
        result = await super().execute(statement, *args, **kwargs)
        saved = result.freeze()
        rows = saved().all()
        if self.calls == 1:
            self.preflight = [dict(row._mapping) for row in rows]
            if self.between_reads is not None:
                await self.between_reads()
        elif self.calls == 2:
            self.hydrated = [(row.id, row.response) for row in rows]
        return saved()


@pytest.mark.anyio
async def test_actual_unicode_bytes_and_correlated_member_counts(postgres_sources):
    primary = await seed_run(postgres_sources)
    independent = await seed_run(postgres_sources, run_id=502, job_ids=(21,))
    async with ObservedSession(postgres_sources.engine, expire_on_commit=False) as reader:
        context = await freeze_output_source_context(reader, user_id=7, target=TARGET, references=primary + independent)
    assert reader.calls == 2
    responses = dict(reader.hydrated)
    for row in reader.preflight:
        response = responses[row["job_id"]]
        assert row["response_bytes"] == len(response.encode("utf-8")) > len(response)
        assert row["run_member_count"] == (2 if row["run_id"] == 501 else 1)
    assert [item["job_id"] for item in context["sources"]] == [11, 12, 21]
    assert all(item["complete"] and item["run_complete"] for item in context["sources"])
    assert frozen_sources_from_context(context, market="india") is not None


@pytest.mark.anyio
async def test_actual_omitted_run_member_stays_unknown_without_loading_its_response(postgres_sources):
    refs = await seed_run(postgres_sources)
    async with ObservedSession(postgres_sources.engine, expire_on_commit=False) as reader:
        context = await freeze_output_source_context(reader, user_id=7, target=TARGET, references=refs[:1])
    assert [job_id for job_id, _ in reader.hydrated] == [11]
    assert context["sources"][0]["run_member_count"] == 2
    assert not context["sources"][0]["run_complete"]
    result = normalize_output(json.dumps([rebalance_row("OTHER", analyst_source="Swing Trade Run #501")]),
                              "rebalance", holdings=[holding("OTHER")])
    report = inspect_output_consistency(result, swing_sources=frozen_sources_from_context(context, market="india"))
    citation, = [check for check in report.checks if check.field == "analyst_source"]
    assert citation.status == "unknown" and citation.code == "referenced_run_coverage_incomplete"


@pytest.mark.anyio
async def test_actual_non_ascii_aggregate_limit_blocks_before_raw_fetch(postgres_sources):
    refs = await seed_run(postgres_sources, job_ids=(11,))
    oversized = "é" * (MAX_OUTPUT_SOURCE_BYTES // 2 + 1)
    async with postgres_sources.sessions() as writer:
        job = await writer.get(Job, 11)
        job.response = oversized
        await writer.commit()
    refs[0] = refs[0].model_copy(update={"response_sha256": source_hash(oversized)})
    async with ObservedSession(postgres_sources.engine, expire_on_commit=False) as reader:
        with pytest.raises(ValidationException, match="UTF-8 bytes"):
            await freeze_output_source_context(reader, user_id=7, target=TARGET, references=refs)
    assert len(oversized) < MAX_OUTPUT_SOURCE_BYTES
    assert reader.preflight[0]["response_bytes"] > MAX_OUTPUT_SOURCE_BYTES
    assert reader.calls == 1 and reader.hydrated == []


@pytest.mark.anyio
@pytest.mark.parametrize("mutation", ["same_size_hash", "growth", "shrink", "job_owner"])
async def test_actual_interleaved_changes_never_freeze_stale_or_unbounded_response(postgres_sources, mutation):
    refs = await seed_run(postgres_sources, job_ids=(11,))

    async def mutate_between_reads():
        async with postgres_sources.sessions() as writer:
            job = await writer.get(Job, 11)
            if mutation == "same_size_hash":
                job.response = job.response.replace('"ABC"', '"XYZ"')
            elif mutation == "growth":
                job.response += "\n" + "é" * MAX_OUTPUT_SOURCE_BYTES
            elif mutation == "shrink":
                job.response = "shorter"
            else:
                job.user_id = 8
            await writer.commit()

    async with ObservedSession(postgres_sources.engine, expire_on_commit=False,
                               between_reads=mutate_between_reads) as reader:
        with pytest.raises(ValidationException, match="response changed"):
            await freeze_output_source_context(reader, user_id=7, target=TARGET, references=refs)
    assert reader.calls == 2
    if mutation == "same_size_hash":
        assert len(reader.hydrated) == 1
        _, response = reader.hydrated[0]
        assert len(response.encode("utf-8")) == reader.preflight[0]["response_bytes"]
        assert source_hash(response) != refs[0].response_sha256
    else:
        # PostgreSQL excludes changed-size/changed-owner rows before hydration.
        assert reader.hydrated == []


@pytest.mark.anyio
@pytest.mark.parametrize("case", ["run_owner", "job_owner", "wrong_link", "missing_link"])
async def test_actual_owner_and_run_job_link_rejection_precedes_response_fetch(postgres_sources, case):
    refs = await seed_run(postgres_sources, job_ids=(11,))
    # Same owner: the wrong-link case must fail on linkage, not accidentally pass
    # its test merely because the referenced job also belongs to another user.
    other = await seed_run(postgres_sources, run_id=601, job_ids=(21,), owner=7)
    async with postgres_sources.sessions() as writer:
        if case == "run_owner":
            run = await writer.get(Run, 501)
            run.user_id = 8
        elif case == "job_owner":
            job = await writer.get(Job, 11)
            job.user_id = 8
        elif case == "missing_link":
            link = (await writer.execute(select(RunJob).where(RunJob.job_id == 11))).scalar_one()
            await writer.delete(link)
        await writer.commit()
    if case == "wrong_link":
        refs = [other[0].model_copy(update={"run_id": 501})]
    async with ObservedSession(postgres_sources.engine, expire_on_commit=False) as reader:
        with pytest.raises(ValidationException, match="unavailable"):
            await freeze_output_source_context(reader, user_id=7, target=TARGET, references=refs)
    assert reader.calls == 1 and reader.preflight == [] and reader.hydrated == []
