"""Real route/transaction checks for versioned source recomputation."""
from copy import deepcopy
import hashlib
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from sqlalchemy import select

# Reuse the existing isolated SQLite/no-network route fixture and its writers.
from test_auto_rebalance_audit_durability import audit_db, write
from test_final_recompute import inputs as calculation_inputs, capture
from app.domains.jobs.models import Job
from app.domains.runs.models import Run, RunJob, AutoRebalanceWorkflowStage
from app.domains.runs.final_recompute import source_calculations
from app.shared.types import JobStatus


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def stored_capture(audit_db, calculation_inputs):
    payload, context = calculation_inputs
    async with audit_db.sessions() as db:
        for source in context['sources']:
            stage = 'Technical' if source.id == 20 else 'Rebalance'
            db.add(Run(id=source.id, user_id=7, prompt=source.prompt, prompt_preview='synthetic', status=JobStatus.PARTIAL,
                       auto_rebalance_portfolio='india', auto_rebalance_sequence=42,
                       auto_rebalance_label=f'India Run #42 ({stage} Scan)'))
            for job in context['jobs_by_run'][source.id]:
                db.add(Job(id=job.id, user_id=7, prompt='synthetic', response=job.response, provider='test', model='test',
                           status=JobStatus(job.status)))
        await db.flush()
        for source in context['sources']:
            for job in context['jobs_by_run'][source.id]:
                db.add(RunJob(run_id=source.id, job_id=job.id, stage=1))
        await db.commit()
    calculations = source_calculations(payload, **context)
    frozen = capture(payload, calculations[('NSE', 'FIXTUREEQ')])
    frozen.update(schema='workflow-final-v2', formula_version='score-matrix-v1', scorePolicy='score-matrix-raw-effective-v2',
                  response_hashes={str(job.id): hashlib.sha256(job.response.encode()).hexdigest()
                                   for jobs in context['jobs_by_run'].values() for job in jobs})
    return frozen


@pytest.mark.anyio
async def test_v2_route_recomputes_raw_effective_and_preserves_first_snapshot(audit_db, stored_capture):
    before = deepcopy(stored_capture)
    first = await write(audit_db, 'actionables', 'completed', summary={'frozen_final': stored_capture})
    assert first.summary['frozen_final']['rows'][0]['rawScore'] == 74 / 24
    assert first.summary['frozen_final']['rows'][0]['score'] == 74 / 24
    assert first.summary['frozen_final']['rows'][0]['effectiveScore'] == 3
    replay = await write(audit_db, 'actionables', 'completed', summary={'frozen_final': stored_capture})
    assert replay.summary['frozen_final'] == {**before, 'sizing_policy': 'directional-v2'}
    assert stored_capture == before
    forged = deepcopy(stored_capture)
    forged['rows'][0]['effectiveScore'] = 2
    with pytest.raises(HTTPException, match='effectiveScore') as error:
        await write(audit_db, 'actionables', 'completed', summary={'frozen_final': forged})
    assert error.value.status_code == 422
    async with audit_db.sessions() as db:
        stage = (await db.execute(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.stage == 'actionables'))).scalar_one()
        assert stage.summary_json['frozen_final'] == {**before, 'sizing_policy': 'directional-v2'}


@pytest.mark.anyio
@pytest.mark.parametrize('mutation', ['raw', 'inputs', 'weight', 'count', 'revision', 'policy', 'formula_version', 'legacy_downgrade'])
async def test_v2_route_rejects_forgery_without_persisting_capture(audit_db, stored_capture, mutation):
    payload = deepcopy(stored_capture)
    if mutation == 'raw': payload['rows'][0]['rawScore'] = 1
    elif mutation == 'inputs': payload['rows'][0]['formula_inputs']['calculatedUnitsChange'] = 100
    elif mutation == 'weight': payload['rows'][0]['formula_inputs']['detailedRationaleRows'][0]['multiplier'] = 100
    elif mutation == 'count': payload['final_listing_count'] = 0
    elif mutation == 'revision': payload['response_hashes'] = {}
    elif mutation == 'policy': payload['scorePolicy'] = 'unregistered'
    elif mutation == 'formula_version': payload['formula_version'] = 'unregistered'
    elif mutation == 'legacy_downgrade': payload['schema'] = 'workflow-final-v1'
    with pytest.raises(HTTPException) as error:
        await write(audit_db, 'actionables', 'completed', summary={'frozen_final': payload})
    assert error.value.status_code in {409, 422}
    async with audit_db.sessions() as db:
        assert (await db.execute(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.stage == 'actionables'))).scalar_one_or_none() is None


@pytest.mark.anyio
async def test_running_sources_fail_before_arithmetic(audit_db, stored_capture):
    async with audit_db.sessions() as db:
        job = await db.get(Job, 11)
        job.status = JobStatus.PROCESSING
        await db.commit()
    with pytest.raises(HTTPException) as error:
        await write(audit_db, 'actionables', 'completed', summary={'frozen_final': stored_capture})
    assert (error.value.status_code, error.value.detail) == (409, 'Final source jobs must be terminal')


@pytest.mark.anyio
async def test_reconcile_exact_sources_twice(audit_db, stored_capture, monkeypatch):
    from test_auto_rebalance_audit_durability import OWNER, snapshot
    from app.domains.runs.router import reconcile_auto_rebalance
    async with audit_db.sessions() as db:
        technical = await db.get(Run, 20)
        technical.status = JobStatus.COMPLETED
        technical.prompt += '\n[TECHNICAL_REBALANCE_SOURCES_V1]{"run_ids":[10],"job_ids":[11]}[/TECHNICAL_REBALANCE_SOURCES_V1]'
        await db.commit()
    for stage in ('sync', 'threats', 'swing'):
        await write(audit_db, stage, 'skipped')
    await write(audit_db, 'rebalance', 'partial', run_id=10)
    await write(audit_db, 'technical', 'completed', run_id=20, summary={
        'final_inputs': {key: stored_capture[key] for key in ('formula', 'rebalance_run_ids', 'response_hashes')}})
    await write(audit_db, 'actionables', 'processing')
    results = []
    for _ in range(2):
        async with audit_db.sessions() as db:
            result = await reconcile_auto_rebalance('india', 42, db, OWNER)
            results.append(result.summary['frozen_final'])
            if len(results) == 1:
                first_dispatch_count = audit_db.dispatch.call_count
    assert results[0] == results[1]
    assert results[0]['rows'][0]['rawScore'] == 74 / 24
    workflow, count, _ = await snapshot(audit_db)
    assert (workflow.status, count) == ('partial', 6)
    assert audit_db.dispatch.call_count == first_dispatch_count

    # The corrected calculation is stored separately and is idempotent, including after reload.
    from app.core.recovery import RecoveryMiddleware
    from app.domains.runs import router as routes

    async def get_db():
        async with audit_db.sessions() as db:
            yield db

    monkeypatch.setenv("CREDX_RECOVERY_MODE", "1")
    app = FastAPI()
    app.include_router(routes.router)
    app.add_middleware(RecoveryMiddleware)
    app.dependency_overrides[routes.get_async_db] = get_db
    path = "/runs/auto-rebalance-history/india/42/replay-score-v2"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post(path)).status_code in {401, 403}
        app.dependency_overrides[routes.get_current_user] = lambda: SimpleNamespace(id=8)
        assert (await client.post(path)).status_code == 404
        app.dependency_overrides[routes.get_current_user] = lambda: OWNER
        for _ in range(2):
            response = await client.post(path)
            assert response.status_code == 200, response.text
            assert response.json() == {"formula_version": "score-matrix-v2", "listings": 1, "sequence": 42}
        verification = path.replace("replay-score-v2", "score-verification")
        for _ in range(2):
            response = await client.get(verification)
            assert response.status_code == 200, response.text
            assert response.json()["verified"] is True
            assert response.json()["record"]["workflow_sequence"] == 42
        app.dependency_overrides[routes.get_current_user] = lambda: SimpleNamespace(id=8)
        assert (await client.get(verification)).status_code == 404
        app.dependency_overrides[routes.get_current_user] = lambda: OWNER
        for blocked in (path.replace("/india/", "/us/"), path.replace("/42/", "/0/"),
                        path.replace("replay-score-v2", "reconcile"), path + "/extra",
                        "/runs/auto-rebalance-completion-email"):
            response = await client.post(blocked)
            assert response.status_code == 503 and response.json()["code"] == "RECOVERY_CONTAINMENT"
    async with audit_db.sessions() as db:
        final = (await db.execute(select(AutoRebalanceWorkflowStage).where(
            AutoRebalanceWorkflowStage.stage == "actionables"))).scalar_one()
        assert final.summary_json["frozen_final"] == results[0]
        coverage = final.summary_json["corrected_final_v2"]["rows"][0]["source_coverage"][0]
        assert coverage["job_id"] == 11 and len(coverage["used_fields"]) == 6
    assert audit_db.dispatch.call_count == first_dispatch_count


@pytest.mark.anyio
async def test_untagged_icici_replay_keeps_verified_formula_and_archives_old_units(audit_db, stored_capture):
    """Exercise historical verification, replay, and the basket's verification receipt."""
    from test_auto_rebalance_audit_durability import OWNER
    from app.domains.runs.router import replay_india_score, verify_saved_india_score

    async with audit_db.sessions() as db:
        model = await db.get(Job, 11)
        technical_job = await db.get(Job, 21)
        technical = await db.get(Run, 20)
        technical.status = JobStatus.COMPLETED
        technical.prompt += '\n[TECHNICAL_REBALANCE_SOURCES_V1]{"run_ids":[10],"job_ids":[11,12]}[/TECHNICAL_REBALANCE_SOURCES_V1]'
        model.response = model.response.replace("NSE", "BSE").replace("FIXTUREEQ", "ICICIBANK")
        headers, separator, data = model.response.splitlines()
        def trim_response(change):
            columns = [v.strip() for v in headers.strip("|").split("|")]
            values = [v.strip() for v in data.strip("|").split("|")]
            for name, value in {"Current Units":"34", "Units Change":str(change), "Final Units":str(34+change),
                                "Action (Buy/Add/Sell All/Trim/Hold/Buy New)":"Trim", "Price Per Unit":"1600"}.items():
                values[columns.index(name)] = value
            return "\n".join([headers, separator, "| " + " | ".join(values) + " |"])
        model.response = trim_response(-10)
        second = Job(id=12, user_id=7, prompt="synthetic", response=trim_response(-12), provider="test", model="test", status=JobStatus.PARTIAL)
        db.add(second)
        await db.flush()
        db.add(RunJob(run_id=10, job_id=12, stage=1))
        technical_job.response = technical_job.response.replace("NSE", "BSE").replace("FIXTUREEQ", "ICICIBANK")
        hashes = {str(j.id):hashlib.sha256(j.response.encode()).hexdigest() for j in (model,second,technical_job)}
        await db.commit()
    for stage in ("sync", "threats", "swing"):
        await write(audit_db, stage, "skipped")
    await write(audit_db, "rebalance", "partial", run_id=10)
    await write(audit_db, "technical", "completed", run_id=20, summary={"final_inputs":{
        "formula":stored_capture["formula"], "rebalance_run_ids":[10], "response_hashes":hashes}})
    await write(audit_db, "actionables", "processing")
    async with audit_db.sessions() as db:
        await replay_india_score(42, db, OWNER)
        stage = (await db.scalars(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.stage=="actionables"))).one()
        old = deepcopy(stage.summary_json["corrected_final_v2"])
        old.pop("sizing_policy")
        row = old["rows"][0]
        assert row["action"] == "Add more" and row["estimate"]["units"] is None
        row["estimate"].update(units=11, amount=17600)
        row["formula_inputs"]["calculatedUnitsChange"] = 11
        row["formula_inputs"]["rows"][-1]["unitsChange"] = 11
        stage.summary_json = {"corrected_final_v2":old}
        await db.commit()
        first = await verify_saved_india_score(42, db, OWNER)
        assert first["verified"] and first["record"]["sizing_policy"] == "absolute-mean-v1"
        await replay_india_score(42, db, OWNER)
        new = await verify_saved_india_score(42, db, OWNER)
        assert new["verified"] and new["record"]["sizing_policy"] == "directional-v2"
        result = new["record"]["rows"][0]
        assert result["estimate"]["units"] is None and result["estimate"]["amount"] is None
        assert result["effectiveScore"] == row["effectiveScore"]
        assert new["record"]["formula"] == old["formula"]
        assert result["formula_inputs"]["detailedRationaleDenominator"] == row["formula_inputs"]["detailedRationaleDenominator"]
        assert stage.summary_json["previous_sizing_replay"] == old
        await replay_india_score(42, db, OWNER)
        assert stage.summary_json["corrected_final_v2"] == new["record"]
        bad = deepcopy(stage.summary_json)
        bad["corrected_final_v2"]["rows"][0]["estimate"]["units"] = 99
        stage.summary_json = bad
        await db.commit()
        error = await verify_saved_india_score(42, db, OWNER)
        assert not error["verified"] and "BSE:ICICIBANK estimate.units: saved 99, recomputed None" in error["reason"]
