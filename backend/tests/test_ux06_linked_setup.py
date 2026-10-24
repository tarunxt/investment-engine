"""Real accepted/acquired synthetic sources -> inert setup/preview; no network."""
import asyncio
from types import SimpleNamespace
import pytest
from sqlalchemy import select
from app.domains.runs.analysis_router import setup_context,preview_candidates,CandidatePreview
from app.domains.runs.models import AutoRebalanceWorkflow
from app.domains.jobs.models import Job
from app.infrastructure.database.outbox.models import OutboxMessage
from test_stage18_linked_analysis_preview import linked_env,current_source

@pytest.mark.parametrize('owner,portfolio',[(1,'india'),(2,'india'),(1,'indmoney_us'),(2,'indmoney_us')])
def test_actual_fake_owned_source_setup_and_canonical_preview_enqueue_nothing(linked_env,owner,portfolio):
    env=linked_env;snapshot=current_source(env,owner,portfolio)
    before=[len(list(env.db.scalars(select(model)))) for model in (AutoRebalanceWorkflow,Job,OutboxMessage)]
    async def run_sync(fn):return fn(env.db)
    async def run():
        ctx=await setup_context(portfolio=portfolio,db=SimpleNamespace(run_sync=run_sync),user=SimpleNamespace(id=owner),runtime=env.runtime)
        result=await preview_candidates(CandidatePreview(portfolio=portfolio,raw_text='SYNTHETIC0' if portfolio=='india' else 'UATA\nUATB',format='paste',snapshot_id=snapshot),db=SimpleNamespace(run_sync=run_sync),user=SimpleNamespace(id=owner),runtime=env.runtime)
        return ctx,result
    ctx,result=asyncio.run(run())
    assert ctx['owner_id']==result['owner_id']==owner
    assert ctx['source_hash']==result['source_hash']
    assert ctx['usage']['estimated_cost_usd']=='0' and ctx['usage']['simulation_only'] is True
    if portfolio=='india':
        assert ctx['connection']['mode']==('user_owned' if owner==1 else 'platform_managed')
        assert ctx['connection']['account_label'].startswith('***')
        assert 'FAKE_OWNER' not in ctx['connection']['account_label']
    else:assert ctx['connection'] is None
    assert result['rows'][0]['holdings_overlap'] is True
    assert result['counts']['analysed_candidates']==0
    assert result['accepted_for_analysis'] is False and result['orders_authorized'] is False
    assert before==[len(list(env.db.scalars(select(model)))) for model in (AutoRebalanceWorkflow,Job,OutboxMessage)]
    assert not env.db.new and not env.db.dirty
