# Synthetic security, holdings, scores, prices and times; no user portfolio data.
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from app.domains.recommendation_audit.capture import freeze_input, freeze_output, materialize_run, capture_terminal
from app.domains.recommendation_audit.models import EvidenceRecord, DecisionRecord, VerificationRecord, SpendAccount, SpendAttempt
from app.domains.recommendation_audit.schemas import AuditRunContext, CalculationCapture
from app.domains.recommendation_audit.calculation_capture import capture_calculation
from app.domains.recommendation_audit.deterministic import digest
from app.domains.jobs.models import Job
from app.domains.runs.models import Run, RunJob
from app.domains.jobs.output_contracts import REBALANCE_COLUMNS
from app.shared.types import JobStatus
from test_output_contracts import rebalance_row, table
from test_recommendation_audit import formula, decision, request


@pytest.fixture
def db():
    import app.models
    from app.infrastructure.database.base import Base
    engine=create_engine("sqlite://")
    tables=[m.__table__ for m in (EvidenceRecord, DecisionRecord, VerificationRecord, SpendAccount, SpendAttempt, Job, Run, RunJob)]
    Base.metadata.create_all(engine,tables=tables)
    with Session(engine,expire_on_commit=False) as session: yield session
    engine.dispose()


def source(db, *, user=1, current=1):
    prompt="[REBALANCE_FLOW:india]\n\n## 1. Latest Portfolio Snapshot\n| Exchange | Stock Symbol | Current Units |\n|---|---|---|\n| NSE | FIXTUREEQ | 1 |\n\n## 2. Threats\nCaptured threats."
    run=Run(user_id=user,prompt=prompt,prompt_preview=prompt[:280],auto_rebalance_portfolio="india",auto_rebalance_label="India Run 1 (Rebalance Scan)",status=JobStatus.COMPLETED)
    db.add(run);db.flush()
    row=rebalance_row("FIXTUREEQ",current_units=current,action="Sell All",units_change=-current,final_units=0)
    job=Job(user_id=user,prompt=prompt,provider="deepseek",model="model",status=JobStatus.COMPLETED,response=table(REBALANCE_COLUMNS,[row]))
    db.add(job);db.flush();db.add(RunJob(run_id=run.id,job_id=job.id,stage=1));db.commit()
    return run,job


def test_capture_preserves_bytes_and_reuses_revision(db):
    run,job=source(db)
    inp=freeze_input(db,run,[job],AuditRunContext(formula=formula()))
    before=job.response
    first=freeze_output(db,run,job,inp);second=freeze_output(db,run,job,inp)
    assert first.id==second.id and first.content==before and job.response==before
    assert first.payload["response_hash"]==digest(before)
    assert inp.payload["holdings"][0]["current_units"]=="1"
    capture_terminal(db,job);db.commit()
    assert len(list(db.scalars(select(DecisionRecord))))==1
    assert len(list(db.scalars(select(EvidenceRecord).where(EvidenceRecord.kind=="output"))))==1


def test_legacy_observation_does_not_invent_original_formula(db):
    run,job=source(db)
    records=materialize_run(db,run);db.commit()
    assert records[0].provenance=="legacy_observed"
    assert records[0].payload["original_completion_at"] is None
    assert records[0].payload["calculation"]["formula_action"] is None


def test_mutated_response_creates_revision_without_overwriting(db):
    run,job=source(db);inp=freeze_input(db,run,[job])
    original=freeze_output(db,run,job,inp);db.commit()
    job.response += "\nNew dissent.";db.commit()
    revision=freeze_output(db,run,job,inp);db.commit()
    assert original.id!=revision.id
    assert original.content!=revision.content
    assert original.content_hash!=revision.content_hash


def test_calculation_capture_rejects_cross_tenant_and_changed_response(db):
    run,job=source(db)
    body=CalculationCapture(run_ids=[run.id],formula=formula(),expected_response_hashes={job.id:digest(job.response)})
    with pytest.raises(LookupError): capture_calculation(db,2,body)
    with pytest.raises(ValueError,match="changed"): capture_calculation(db,1,body.model_copy(update={"expected_response_hashes":{job.id:"0"*64}}))
    records=capture_calculation(db,1,body);db.commit()
    assert records[0].provenance=="calculation_observed"
    assert records[0].payload["original_completion_at"] is None


def test_missing_holding_context_remains_unknown(db):
    run,job=source(db);run.prompt="[REBALANCE_FLOW:india]\n\nNo snapshot";db.commit()
    inp=freeze_input(db,run,[job]);assert inp.payload["holdings"] is None
    output=freeze_output(db,run,job,inp);assert output.payload["rows"][0]["valid"] is False


def test_advisory_capture_failure_preserves_successful_job(db,monkeypatch):
    from app.core.config import settings
    from app.domains.jobs.repository import SyncJobRepository
    import app.domains.recommendation_audit.capture as capture
    run,job=source(db);original=job.response
    monkeypatch.setattr(settings,"recommendation_audit_enabled",True)
    def broken(*args): raise ValueError("invalid audit fixture")
    monkeypatch.setattr(capture,"capture_terminal",broken)
    SyncJobRepository(db).update_status(job,JobStatus.COMPLETED,response=original)
    assert job.status==JobStatus.COMPLETED and job.response==original
    assert job.runtime_metadata_json["recommendation_audit"]["status"]=="capture_failed"


def test_failed_and_partial_attempts_remain_coverage_gaps(db):
    run,job=source(db);job.status=JobStatus.PARTIAL;db.commit()
    records=materialize_run(db,run,context=AuditRunContext(formula=formula()));db.commit()
    assert records[0].payload["coverage"]["successful"]==0
    assert records[0].payload["calculation"]["formula_action"] is None


def test_technical_finalization_uses_input_frozen_output_ids(db):
    run,job=source(db)
    freeze_input(db,run,[job],AuditRunContext(formula=formula()));capture_terminal(db,job);db.commit()
    technical=Run(user_id=1,prompt="## Technical Scan Input Bundle\nMarket: India equities",prompt_preview="technical",auto_rebalance_portfolio="india",auto_rebalance_label="India Run 1 (Technical Scan)",status=JobStatus.COMPLETED)
    db.add(technical);db.flush()
    content="| Exchange Symbol | Stock Symbol | Bias | Confidence Score | Premarket trend | Last 5 candles trend | Trigger Level | Invalidation Level |\n|---|---|---|---|---|---|---|---|\n| NSE | FIXTUREEQ | Bearish | 7.0 | 0 | -2 | close below 80 | close above 120 |\n"
    tech_job=Job(user_id=1,prompt=technical.prompt,provider="deepseek",model="model",status=JobStatus.COMPLETED,response=content)
    db.add(tech_job);db.flush();db.add(RunJob(run_id=technical.id,job_id=tech_job.id,stage=1));db.flush()
    tech_input=freeze_input(db,technical,[tech_job],AuditRunContext(formula=formula(),rebalance_run_ids=[run.id],expected_response_hashes={job.id:digest(job.response)}));db.commit()
    frozen_ids=tech_input.payload["rebalance_sources"][0]["output_ids"]
    # Later source mutation must not enter a previously frozen technical input.
    job.response=table(REBALANCE_COLUMNS,[rebalance_row("FIXTUREEQ",current_units=1,action="Sell All",units_change=-1,final_units=0,score_rationale_cruxx=3)])
    db.commit();capture_terminal(db,job);db.commit();capture_terminal(db,tech_job);db.commit()
    final=db.scalar(select(DecisionRecord).where(DecisionRecord.provenance==f"technical:{technical.id}"))
    assert final.payload["output_ids"]==frozen_ids
    assert final.payload["calculation"]["averages"]["cruxx"]=="0"


def test_failed_sibling_cannot_certify_surviving_stock(db):
    run,job=source(db)
    failed=Job(user_id=1,prompt=run.prompt,provider="deepseek",model="model",status=JobStatus.FAILED,error_message="fixture")
    db.add(failed);db.flush();db.add(RunJob(run_id=run.id,job_id=failed.id,stage=1));db.commit()
    records=materialize_run(db,run,context=AuditRunContext(formula=formula()))
    calc=records[0].payload["calculation"]
    assert calc["formula_action"] is None
    assert any(f["code"]=="stock_coverage_incomplete" for f in calc["findings"])


def test_comparison_separates_observed_calculation(db):
    from app.domains.recommendation_audit.service import comparison_view
    run,job=source(db)
    original=materialize_run(db,run)[0];db.commit()
    capture_calculation(db,1,CalculationCapture(run_ids=[run.id],formula=formula(),expected_response_hashes={job.id:digest(job.response)}));db.commit()
    view=comparison_view(db,1,run.id,"india","FIXTUREEQ","NSE")
    assert view["current"]["id"]==original.id
    assert view["present_calculation"]["provenance"]=="calculation_observed"
    assert view["current"]["calculation"]["formula_action"] is None


def test_stale_technical_linkage_is_rejected(db):
    run,job=source(db)
    freeze_input(db,run,[job],AuditRunContext(formula=formula()));capture_terminal(db,job);db.commit()
    expected=digest(job.response)
    job.response+="\nchanged";db.commit();capture_terminal(db,job);db.commit()
    tech=Run(user_id=1,prompt="## Technical Scan Input Bundle\nMarket: India equities",prompt_preview="technical",auto_rebalance_portfolio="india",auto_rebalance_label="India Run 2 (Technical Scan)",status=JobStatus.PENDING)
    db.add(tech);db.flush()
    with pytest.raises(ValueError,match="revisions"):
        freeze_input(db,tech,[],AuditRunContext(formula=formula(),rebalance_run_ids=[run.id],expected_response_hashes={job.id:expected}))


def test_failed_technical_sibling_suppresses_final_action(db):
    run,job=source(db)
    tech=Run(user_id=1,prompt="## Technical Scan Input Bundle\nMarket: India equities",prompt_preview="technical",auto_rebalance_portfolio="india",auto_rebalance_label="India Run 2 (Technical Scan)",status=JobStatus.COMPLETED)
    db.add(tech);db.flush()
    good=Job(user_id=1,prompt=tech.prompt,provider="deepseek",model="model",status=JobStatus.COMPLETED,response="| Exchange Symbol | Stock Symbol | Bias | Confidence Score | Premarket trend | Last 5 candles trend | Trigger Level | Invalidation Level |\n|---|---|---|---|---|---|---|---|\n| NSE | FIXTUREEQ | Bearish | 7.0 | 0 | -2 | close below 80 | close above 120 |")
    failed=Job(user_id=1,prompt=tech.prompt,provider="deepseek",model="model",status=JobStatus.FAILED)
    db.add_all([good,failed]);db.flush();db.add_all([RunJob(run_id=tech.id,job_id=j.id,stage=1) for j in [good,failed]]);db.commit()
    records=capture_calculation(db,1,CalculationCapture(run_ids=[run.id],technical_run_id=tech.id,formula=formula(),expected_response_hashes={j.id:digest(j.response or "") for j in [job,good,failed]}))
    assert records[0].payload["calculation"]["formula_action"] is None
    assert any(f["code"]=="technical_coverage_incomplete" for f in records[0].payload["calculation"]["findings"])


@pytest.mark.asyncio
async def test_routes_are_owned_passive_and_retain_failed_dispatch(monkeypatch):
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    from app.infrastructure.database.base import Base
    from app.infrastructure.database.session import get_async_db
    from app.domains.auth.dependencies import get_current_user
    from app.domains.recommendation_audit.router import router
    from app.domains.recommendation_audit.tasks import verify_reversal
    from app.core.config import settings
    import app.models
    monkeypatch.setattr(settings,"recommendation_audit_enabled",True)
    monkeypatch.setattr(settings,"recommendation_audit_external_enabled",False)
    monkeypatch.setenv("CREDX_RECOVERY_MODE","0")
    engine=create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c,tables=[m.__table__ for m in (EvidenceRecord,DecisionRecord,VerificationRecord,SpendAccount,SpendAttempt,Run)]))
    sessions=async_sessionmaker(engine,expire_on_commit=False)
    async def db_dep():
        async with sessions() as session: yield session
    app=FastAPI();app.include_router(router);app.dependency_overrides[get_async_db]=db_dep;app.dependency_overrides[get_current_user]=lambda:SimpleNamespace(id=1)
    calls=[]
    def unavailable(*args,**kwargs): calls.append(1);raise RuntimeError("broker unavailable")
    monkeypatch.setattr(verify_reversal,"apply_async",unavailable)
    async with sessions() as session:
        run=Run(id=10,user_id=1,prompt="rebalance",prompt_preview="rebalance",status=JobStatus.COMPLETED);session.add(run)
        current=await session.run_sync(lambda s:decision(s));await session.commit();body=request(current).model_dump(mode="json")
    async with AsyncClient(transport=ASGITransport(app=app),base_url="http://test") as client:
        response=await client.post("/runs/recommendation-audit/verifications",json=body)
        assert response.status_code==200,response.text
        assert response.json()["dispatch_pending"] is True and len(calls)==1
        record_id=response.json()["id"]
        assert (await client.get(f"/runs/recommendation-audit/verifications/{record_id}")).status_code==200 and len(calls)==1
        duplicate=await client.post("/runs/recommendation-audit/verifications",json=body)
        assert duplicate.json()["id"]==record_id and len(calls)==1  # bounded explicit redispatch
        # An older API publisher must not clear a later relay delivery claim.
        import asyncio
        from datetime import timedelta
        from sqlalchemy import update
        from app.domains.recommendation_audit.models import utcnow
        async with sessions() as session:
            await session.execute(update(VerificationRecord).where(VerificationRecord.id==record_id).values(last_dispatch_at=utcnow()-timedelta(seconds=20)))
            await session.commit()
        loop=asyncio.get_running_loop()
        async def newer_claim():
            async with sessions() as session:
                await session.execute(update(VerificationRecord).where(VerificationRecord.id==record_id).values(last_dispatch_at=utcnow()+timedelta(seconds=16),dispatch_pending=True))
                await session.commit()
        def late_publisher(_): asyncio.run_coroutine_threadsafe(newer_claim(),loop).result(timeout=2)
        monkeypatch.setattr("app.domains.recommendation_audit.outbox.publish_verification",late_publisher)
        late=await client.post("/runs/recommendation-audit/verifications",json=body)
        assert late.status_code==200 and late.json()["dispatch_pending"] is True
        app.dependency_overrides[get_current_user]=lambda:SimpleNamespace(id=2)
        assert (await client.get(f"/runs/recommendation-audit/verifications/{record_id}")).status_code==404
        assert (await client.get("/runs/recommendation-audit/comparison",params={"run_id":10,"market":"india","symbol":"FIXTUREEQ","exchange":"NSE"})).status_code==404
        app.dependency_overrides[get_current_user]=lambda:SimpleNamespace(id=1)
        external={**body,"mode":"external_data"};assert (await client.post("/runs/recommendation-audit/verifications",json=external)).status_code==403
        monkeypatch.setattr(settings,"recommendation_audit_enabled",False)
        assert (await client.get(f"/runs/recommendation-audit/verifications/{record_id}")).status_code==404
    await engine.dispose()
