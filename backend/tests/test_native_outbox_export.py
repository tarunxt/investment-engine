"""Typed native evidence ownership; not complete account/privacy acceptance."""
from copy import deepcopy
from datetime import timedelta
import pytest
from sqlalchemy import select,func
from sqlalchemy.orm import Session
from test_hosted_order_composition import order_env,worker_env,linked_env
from app.domains.public_service.native_outbox_export import NativeOutboxExport,TOPICS
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from app.domains.connections.models import IntegrationConnection
from app.domains.order_intents.models import OrderIntent
from app.domains.order_intents.service import TOPIC as APPROVAL,orders_for_runtime
from app.domains.order_intents.authority import authenticated_confirmation
from app.domains.auth.models import User
from app.infrastructure.database.outbox.models import OutboxMessage
from app.uat2.private_exports import prepare_export
from app.uat2.operations import SimulationOperations
from app.uat2.synthetic_connections import connect


@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
def test_typed_export_follows_owned_resources_and_keeps_unknown_stores_held(order_env):
    e,analysis,worker,factory,celery,deliveries,clock,flow_id,intent=order_env
    with analysis.session() as db:
        # A native connection event plus new source/history, with no mutation
        # of the earlier completed source or its prepared review.
        connect(db,2,mode='platform_managed',key='private-export-conn',expected_id=db.scalar(select(IntegrationConnection.id).where(IntegrationConnection.owner_id==2)),expected_version=7)
        db.commit()
        prepare_export(db,1,flow_id,analysis=analysis.analysis,key='privacy-artifact-key')
        SimulationOperations(analysis.analysis).observe(db,1)
        # Only the real request-local authority can create the approval event.
        service=orders_for_runtime(db,worker.orders)
        row=db.get(OrderIntent,intent)
        with authenticated_confirmation(db.get(User,1),row.id,row.review_digest):
            service.approve(1,row.id,row.review_digest,action='confirm_exact_order_or_basket')
        db.commit()
        approval=db.scalar(select(OutboxMessage.id).where(OutboxMessage.topic==APPROVAL))
    clock[0]+=timedelta(seconds=1)
    worker.dispatch(approval)
    # SQLite execution uses a separate disposable venue file. Copy its exact
    # immutable packet into this read-projection fixture to exercise the unified
    # outbox layout; this is not PostgreSQL or unified-SQLite execution evidence.
    with Session(worker.venue_engine) as venue:
        packet=venue.scalar(select(OutboxMessage))
        packet_id,packet_topic,packet_payload=packet.id,packet.topic,deepcopy(packet.payload)
    with analysis.session() as db:
        db.add(OutboxMessage(id=packet_id,topic=packet_topic,payload=packet_payload));db.commit()
    with analysis.session() as db:
        before=db.scalar(select(func.count()).select_from(OutboxMessage))
        result=NativeOutboxExport(db,scope=analysis.scope).export(1)
        assert result['owner_id']==1 and result['complete_account_export'] is False
        assert result['complete_account_erasure'] is False and result['raw_payload_dump'] is False
        assert set(result['covered_topics'])==TOPICS
        assert {'files','cache','backups','other_outbox_contracts'}<=set(result['uncovered_stores'])
        kinds={item['data']['kind'] for item in result['items']}
        assert {'synthetic_acquisition','analysis_stage_dispatch','analysis_basket_provenance',
            'exact_synthetic_confirmation','private_analysis_artifact','local_operational_observation',
            'synthetic_venue_evidence'}<=kinds
        assert db.scalar(select(func.count()).select_from(OutboxMessage))==before
        from app.domains.modules.models import UserModule
        db.scalar(select(UserModule).where(UserModule.user_id==1,UserModule.module_id=='zerodha_rebalance')).enabled=False
        db.commit()
        assert NativeOutboxExport(db,scope=analysis.scope).export(1)==result
        other=NativeOutboxExport(db,scope=analysis.scope).export(2)
        assert all(item['data']['kind']=='synthetic_connection' for item in other['items'])
        assert not ({item['id'] for item in result['items']}&{item['id'] for item in other['items']})


@pytest.mark.parametrize('change',['owner','resource','hash','extra_field','oversized'])
@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
def test_malformed_owned_packet_never_becomes_raw_export(order_env,change):
    e,analysis,worker,factory,celery,deliveries,clock,flow_id,intent=order_env
    from app.domains.runs.analysis_workflows.synthetic_journal import TOPIC as SOURCE
    with analysis.session() as db:
        row=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==SOURCE))
        value=deepcopy(row.payload)
        if change=='owner':value['source']['owner_id']=2
        elif change=='resource':value['source']['connection']['id']=db.scalar(select(IntegrationConnection.id).where(IntegrationConnection.owner_id==2))
        elif change=='hash':value['source_hash']='0'*64
        elif change=='extra_field':value['unreviewed_private_field']='must-not-export'
        else:value['unreviewed_private_field']='x'*70000
        row.payload=value;db.commit()
        with pytest.raises((BoundaryDenied,PermissionError)):
            NativeOutboxExport(db,scope=analysis.scope).export(1)


def test_native_export_cannot_adopt_hosted_scope_or_untyped_scope(order_env):
    e,analysis,worker,factory,celery,deliveries,clock,flow_id,intent=order_env
    with analysis.session() as db:
        with pytest.raises(BoundaryDenied):NativeOutboxExport(db,scope=object())
        with pytest.raises(PermissionError):NativeOutboxExport(db,scope=SimulationSourceScope('hosted')).export(1)


@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
def test_optional_saved_technical_study_export_retains_exact_owned_contract(order_env):
    from app.domains.runs.analysis_workflows.synthetic_journal import TOPIC as SOURCE
    from app.domains.runs.analysis_workflows.contracts import digest,WorkflowDenied
    e,analysis,*_=order_env
    with analysis.session() as db:
        row=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==SOURCE))
        packet=deepcopy(row.payload)
        exporter=NativeOutboxExport(db,scope=analysis.scope)
        result=exporter.project(row.id,SOURCE,packet,1)
        assert result['source']['price_history']==packet['source']['price_history']
        assert result['source']['price_history']['provider']=='offline-fixed-samples-v1'
        changed=deepcopy(packet);changed['source']['price_history']['study']['rsi_14']='99.99'
        history=changed['source']['price_history'];history['history_hash']=digest({k:v for k,v in history.items() if k!='history_hash'})
        changed['source']['content_hash']=digest({k:v for k,v in changed['source'].items() if k!='content_hash'})
        changed['source_hash']=digest(changed['source'])
        with pytest.raises((BoundaryDenied,WorkflowDenied)):
            exporter.project(row.id,SOURCE,changed,1)
