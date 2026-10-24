"""Saved amended plans -> separate exact fake approval, fresh risk and receipts."""
from copy import deepcopy
from datetime import timedelta
import pytest
from sqlalchemy import select
from test_hosted_order_composition import order_env,worker_env,linked_env
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_workflows.action_plan import project
from app.domains.runs.analysis_workflows.plan_revisions import revise
from app.domains.order_intents.models import OrderIntent
from app.domains.order_intents.service import orders_for_runtime,TOPIC
from app.domains.order_intents.authority import authenticated_confirmation
from app.domains.order_intents.execution_fake import MarketDataFake
from app.domains.order_intents.contracts import OrderDenied
from app.domains.auth.models import User
from app.infrastructure.database.outbox.models import OutboxMessage
from app.uat2.revision_baskets import assess,annotate
from app.domains.public_service.native_outbox_export import NativeOutboxExport
from app.shared.exceptions import NotFoundException


def revision(db,analysis,owner,id,units,expected=None):
    flow=Workflows(db,analysis.runtime).owned(owner,id);receipt=analysis.completed_analysis(db,owner,id)
    original=project(receipt,workflow=flow,source=flow.execution_json['source']);stage=Workflows(db,analysis.runtime).stages(flow)[-1]
    return revise(stage,original,expected or original['version'],[{'instrument':'NSE:SYNTHETIC0','final_units':units}])


@pytest.mark.parametrize('target,side',[('2','SELL'),('4','BUY')])
@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
def test_amended_fake_review_has_new_digest_funds_and_one_actual_submission(order_env,target,side):
    e,analysis,worker,factory,app,deliveries,clock,flow_id,original_id=order_env
    with analysis.session() as db:
        original=db.get(OrderIntent,original_id);old_digest=original.review_digest
        plan=revision(db,analysis.analysis,1,flow_id,target);version=plan['version']
        current=annotate(db,analysis.analysis,plan);assert current['review_available'] is True and current['execution_assessment']['eligible'] is True
        row=worker.orders.prepare(db,1,flow_id,revision_version=version,now=clock[0]);id=row.id
        assert id!=original_id and row.review_digest!=old_digest and row.approved_at is None
        assert row.payload_json['legs'][0]['side']==side and row.payload_json['legs'][0]['quantity']==1
        assert worker.orders.prepare(db,1,flow_id,revision_version=version,now=clock[0]).id==id
        service=orders_for_runtime(db,worker.orders)
        with authenticated_confirmation(db.get(User,1),row.id,old_digest):
            with pytest.raises(OrderDenied):service.approve(1,id,old_digest,action='confirm_exact_order_or_basket',now=clock[0])
        with authenticated_confirmation(db.get(User,1),row.id,row.review_digest):service.approve(1,id,row.review_digest,action='confirm_exact_order_or_basket',now=clock[0])
        db.commit();event=db.scalar(select(OutboxMessage.id).where(OutboxMessage.topic==TOPIC,OutboxMessage.payload['intent_id'].as_string()==id))
        projection=NativeOutboxExport(db,scope=analysis.scope).export(1)
        assert any(r['data'].get('provenance',{}).get('revision_version')==version for r in projection['items'])
    clock[0]+=timedelta(seconds=1);worker.dispatch(event)
    with pytest.raises(OrderDenied,match='UNUSED_APPROVAL'):worker.dispatch(event)
    with analysis.session() as db:
        assert db.get(OrderIntent,id).state=='filled'
        assert db.get(OrderIntent,original_id).approved_at is None
        assert worker.orders.holdings(db,db.get(OrderIntent,id))==int(target)


@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
def test_new_revision_low_funds_stale_source_and_ambiguous_account_block_old_review(order_env,monkeypatch):
    e,analysis,worker,factory,app,deliveries,clock,flow_id,original_id=order_env
    with analysis.session() as db:
        plan=revision(db,analysis.analysis,1,flow_id,'4');version=plan['version'];db.commit()
        real=worker.orders.market
        def insufficient(session,row,now):
            data=real(session,row,now).read();data['funds']='0';return MarketDataFake(data)
        monkeypatch.setattr(worker.orders,'market',insufficient)
        with pytest.raises(OrderDenied):worker.orders.prepare(db,1,flow_id,revision_version=version,now=clock[0])
        monkeypatch.setattr(worker.orders,'market',real)
        row=worker.orders.prepare(db,1,flow_id,revision_version=version,now=clock[0]);db.commit()
        revision(db,analysis.analysis,1,flow_id,'2',expected=version);db.commit()
        with pytest.raises(OrderDenied):orders_for_runtime(db,worker.orders).review(1,row.id,now=clock[0])
        with pytest.raises(NotFoundException):worker.orders.prepare(db,2,flow_id,revision_version=version,now=clock[0])


@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
def test_revision_receipt_tampering_and_existing_unknown_never_authorise_a_residual(order_env):
    e,analysis,worker,factory,app,deliveries,clock,flow_id,original_id=order_env
    with analysis.session() as db:
        plan=revision(db,analysis.analysis,1,flow_id,'2');version=plan['version']
        row=worker.orders.prepare(db,1,flow_id,revision_version=version,now=clock[0]);db.commit()
        original=db.get(OrderIntent,original_id);original.state='unknown';db.commit()
        with pytest.raises(OrderDenied,match='RECONCILE'):assess(worker.orders,db,1,flow_id,version,now=clock[0])
        original.state='awaiting_approval';db.commit()
        from app.uat2.synthetic_orders import NAMESPACE
        from uuid import uuid5
        packet=db.get(OutboxMessage,uuid5(NAMESPACE,row.id));value=deepcopy(packet.payload);value['provenance']['revision_math_hash']='0'*64;packet.payload=value;db.commit()
        with pytest.raises(OrderDenied):worker.orders.provenance(db,row,clock[0])


@pytest.mark.parametrize('change',['funds','funds_sufficient','quote','holdings','account'])
@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
def test_mutable_fake_risk_is_rechecked_after_review_before_confirmation(order_env,monkeypatch,change):
    e,analysis,worker,factory,app,deliveries,clock,flow_id,original_id=order_env
    with analysis.session() as db:
        plan=revision(db,analysis.analysis,1,flow_id,'4');row=worker.orders.prepare(db,1,flow_id,revision_version=plan['version'],now=clock[0]);db.commit()
        real=worker.orders.market
        def changed(session,intent,now):
            data=real(session,intent,now).read()
            if change=='funds':data['funds']='0'
            elif change=='funds_sufficient':data['funds']='99999'
            elif change=='quote':data['instruments']['NSE:SYNTHETIC0']['quote']='20'
            elif change=='holdings':data['instruments']['NSE:SYNTHETIC0']['holdings']=2
            else:data['account_id']='FOREIGN_SYNTHETIC_ACCOUNT'
            return MarketDataFake(data)
        monkeypatch.setattr(worker.orders,'market',changed)
        with authenticated_confirmation(db.get(User,1),row.id,row.review_digest):
            with pytest.raises(OrderDenied):orders_for_runtime(db,worker.orders).approve(1,row.id,row.review_digest,action='confirm_exact_order_or_basket',now=clock[0])
        assert row.approved_at is None


@pytest.mark.parametrize('outcome',['partial','after_acceptance'])
@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
def test_revision_partial_unknown_restart_reconciles_without_resubmission(order_env,outcome):
    from app.uat2.order_worker import SimulationOrderWorker
    from app.domains.order_intents.execution_models import ExecutionAttempt
    e,analysis,worker,factory,app,deliveries,clock,flow_id,original_id=order_env
    with analysis.session() as db:
        plan=revision(db,analysis.analysis,1,flow_id,'0');row=worker.orders.prepare(db,1,flow_id,revision_version=plan['version'],now=clock[0]);id=row.id
        with authenticated_confirmation(db.get(User,1),id,row.review_digest):orders_for_runtime(db,worker.orders).approve(1,id,row.review_digest,action='confirm_exact_order_or_basket',now=clock[0])
        db.commit();event=db.scalar(select(OutboxMessage.id).where(OutboxMessage.topic==TOPIC,OutboxMessage.payload['intent_id'].as_string()==id))
    clock[0]+=timedelta(seconds=1);worker.dispatch(event)
    with analysis.session() as db:assert db.get(OrderIntent,id).state==('partial' if outcome=='partial' else 'unknown')
    restarted=SimulationOrderWorker(analysis,worker.venue_engine);clock[0]+=timedelta(seconds=2);restarted.reconcile(id)
    with analysis.session() as db:
        assert db.get(OrderIntent,id).state==('partial' if outcome=='partial' else 'filled')
        assert len(list(db.scalars(select(ExecutionAttempt).where(ExecutionAttempt.intent_id==id))))==1
