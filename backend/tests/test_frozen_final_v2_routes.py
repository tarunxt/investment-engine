"""Real route/transaction checks for versioned source recomputation."""
from copy import deepcopy
import hashlib

import pytest
from fastapi import HTTPException
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
    assert replay.summary['frozen_final'] == before
    assert stored_capture == before
    forged = deepcopy(stored_capture)
    forged['rows'][0]['effectiveScore'] = 2
    with pytest.raises(HTTPException, match='effectiveScore') as error:
        await write(audit_db, 'actionables', 'completed', summary={'frozen_final': forged})
    assert error.value.status_code == 422
    async with audit_db.sessions() as db:
        stage = (await db.execute(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.stage == 'actionables'))).scalar_one()
        assert stage.summary_json['frozen_final'] == before


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
