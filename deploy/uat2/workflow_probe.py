"""Actual HTTP/SQL/Redis probe inside smoke.py's disposable Docker container.

Uses a synthetic row with the allowlisted email, never a real Google login.
No deployment credentials, owner acceptance or production effect is implied.
"""
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request


def guard():
    name=os.environ.get('CREDX_UAT2_SMOKE_CONTAINER','')
    if (not re.fullmatch(r'credx-uat2-test-[a-f0-9]{10}-backend',name)
            or socket.gethostname()!=name or os.environ.get('FRONTEND_URL')!='https://uat2.example.invalid'
            or os.environ.get('GOOGLE_SIGNIN_CLIENT_ID')!='independent-synthetic-test-client'
            or os.environ.get('UAT2_SIMULATION_SCENARIO')!='after_acceptance'):
        raise SystemExit('Synthetic workflow probe requires its uniquely named disposable test container')


def main(phase):
    guard()
    from sqlalchemy import select,func
    from app.core.uat2 import OWNER_EMAIL,validate_uat2_startup
    from app.core.security import JWTUtils
    from app.infrastructure.database.sync_session import SyncSessionLocal
    from app.domains.auth.models import User,UserProfile,UserRole
    from app.domains.prompts.models import Prompt  # noqa: F401: User.prompts mapper dependency
    from app.domains.modules.models import UserModule,UserModulePreferences
    from app.domains.runs.models import AutoRebalanceWorkflow
    from app.domains.order_intents.models import OrderIntent
    from app.domains.order_intents.execution_models import ExecutionAttempt
    from app.domains.order_intents.journal_fake import TOPIC as VENUE_TOPIC
    from app.infrastructure.database.outbox.models import OutboxMessage
    # The application under test owns worker/scheduler delivery. This probe
    # only creates explicit synthetic HTTP work and observes persisted state.
    validate_uat2_startup()
    with SyncSessionLocal() as db:
        owner=db.scalar(select(User).where(User.email==OWNER_EMAIL))
        if phase=='start':
            if owner is not None:raise AssertionError('Disposable synthetic owner must not already exist')
            owner=User(email=OWNER_EMAIL,username='native-simulation-fixture',password_hash='not-a-login-hash',
                role=UserRole.USER,is_active=True,is_verified=True,profile=UserProfile())
            db.add(owner);db.flush()
            db.add(UserModulePreferences(user_id=owner.id,version=1))
            for module in ('zerodha_rebalance','indmoney_us'):
                db.add(UserModule(user_id=owner.id,module_id=module,enabled=True,version=1,
                    schedules_paused=False,config={'schema_version':1}))
            db.commit()
        if owner is None or owner.username!='native-simulation-fixture':raise AssertionError('Synthetic owner fixture required')
        owner_id=owner.id
    token=JWTUtils.create_access_token(owner_id,OWNER_EMAIL,'user')
    def call(path,body=None,expected=200,bearer=token):
        data=json.dumps(body).encode() if body is not None else None
        request=urllib.request.Request('http://127.0.0.1:8000'+path,data=data,
            headers={'Authorization':'Bearer '+bearer,'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request,timeout=10) as response:
                assert response.status==expected
                value=response.read()
                return json.loads(value) if response.headers.get_content_type()=='application/json' else value.decode()
        except urllib.error.HTTPError as error:
            if error.code!=expected:raise AssertionError('Unexpected HTTP status '+str(error.code)) from None
            return None
    def completed(workflow_id):
        for _ in range(120):
            result=call('/runs/analysis-workflows/'+str(workflow_id))
            if result['status']=='completed':
                assert len(result['stages'])==6 and all(stage['status']=='completed' for stage in result['stages'])
                return result
            if result['status'] in {'failed','partial','cancelled','paused'}:raise AssertionError('Durable analysis did not complete')
            time.sleep(1)
        raise AssertionError('Bounded analysis completion timeout')
    if phase=='start':
        # Exercise the actual collection/static route, not only POST/detail paths.
        assert call('/runs/analysis-workflows/config')['enabled'] is True
        listing=call('/runs/analysis-workflows')
        assert listing['owner_id']==owner_id and isinstance(listing['items'],list)
        connected=call('/uat2/simulation/connections',{'mode':'user_owned','key':'smoke-user-mode','expected_id':None,'expected_version':None})
        call('/runs/analysis-workflows/synthetic-source',{'portfolio':'india','key':'smoke-user-source'})
        flow=call('/runs/analysis-workflows',{'portfolio':'india','key':'smoke-user-analysis'})
        completed(flow['id'])
        assert flow['id'] in {item['id'] for item in call('/runs/analysis-workflows')['items']}
        intent=call('/uat2/simulation/analysis/'+str(flow['id'])+'/prepare-basket',{})['id']
        review=call('/order-intents/reviews/'+intent)['intents'][0]
        assert review['actions']['confirm'] and review['simulation_scenario']=='after_acceptance'
        path='/order-intents/'+intent+'/approve'
        call(path,{'displayed_digest':'0'*64,'action':'confirm_exact_order_or_basket'},expected=409)
        call(path,{'displayed_digest':review['review_digest'],'action':'confirm_exact_order_or_basket'})
        call(path,{'displayed_digest':review['review_digest'],'action':'confirm_exact_order_or_basket'},expected=409)
        for _ in range(60):
            observed=call('/order-intents/reviews/'+intent)['intents'][0]
            if observed['state']=='unknown':break
            time.sleep(0.2)
        assert observed['state']=='unknown' and not any(observed['actions'].values())
        print(json.dumps({'phase':'start','synthetic_identity':True,'google_verification':False,
            'actual_http':True,'actual_postgresql':True,'actual_redis_tasks':True,
            'actual_scheduler_dispatch':True,'manual_relay_submission':False,
            'actual_static_analysis_collection':True,'user_owned_analysis':True,'unknown_observed':True,
            'intent_id':intent,'owner_acceptance':False}))
    elif phase=='before-restart':
        # smoke.py has stopped the worker and its Beat child. This check is
        # deliberately read-only and fails if reconciliation won the stop race.
        with SyncSessionLocal() as db:
            row=db.execute(select(OrderIntent).where(OrderIntent.owner_id==owner_id)).scalar_one()
            assert row.state=='unknown'
            assert db.scalar(select(func.count()).select_from(ExecutionAttempt).where(ExecutionAttempt.intent_id==row.id))==1
        print(json.dumps({'phase':'before-restart','unknown_while_worker_stopped':True,
            'manual_relay_submission':False,'owner_acceptance':False}))
    elif phase=='recover':
        with SyncSessionLocal() as db:
            intent=db.scalar(select(OrderIntent.id).where(OrderIntent.owner_id==owner_id))
        if intent is None:raise AssertionError('Persisted original intent required')
        for _ in range(40):
            record=call('/order-intents/reviews/'+intent)['intents'][0]
            if record['state']=='filled':break
            time.sleep(1)
        assert record['state']=='filled' and record['integrity_checked']
        with SyncSessionLocal() as db:
            assert db.scalar(select(func.count()).select_from(ExecutionAttempt).where(ExecutionAttempt.intent_id==intent))==1
            assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==VENUE_TOPIC))==1
        # Same dedicated PostgreSQL store, stable owned read snapshot. This is
        # a typed native evidence export, never a full-account/erasure claim.
        from sqlalchemy.orm import Session
        from app.infrastructure.database.sync_session import sync_engine
        from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
        from app.domains.public_service.native_outbox_export import NativeOutboxExport
        with Session(sync_engine.execution_options(isolation_level='REPEATABLE READ')) as db:
            evidence=NativeOutboxExport(db,scope=SimulationSourceScope('hosted')).export(owner_id)
            assert evidence['complete_account_export'] is False and evidence['complete_account_erasure'] is False
            assert any(item['data']['kind']=='synthetic_venue_evidence' for item in evidence['items'])
        # The same original account's receipt remains immutable across a mode switch.
        from app.domains.connections.models import IntegrationConnection
        with SyncSessionLocal() as db:
            current=db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id==owner_id,
                IntegrationConnection.is_current.is_(True)))
            connected={'id':current.id,'version':current.version}
        call('/uat2/simulation/connections',{'mode':'platform_managed','key':'smoke-managed-mode',
            'expected_id':connected['id'],'expected_version':connected['version']})
        call('/runs/analysis-workflows',{'portfolio':'india','key':'smoke-stale-source'},expected=403)
        call('/runs/analysis-workflows/synthetic-source',{'portfolio':'india','key':'smoke-managed-source'})
        managed=call('/runs/analysis-workflows',{'portfolio':'india','key':'smoke-managed-analysis'})
        completed(managed['id'])
        template=call('/indmoney-us/imports/template')
        from datetime import datetime,timezone
        preview=call('/indmoney-us/imports/preview',{'format':'csv','raw_text':template,'captured_at':datetime.now(timezone.utc).isoformat()})
        call('/runs/analysis-workflows',{'portfolio':'indmoney_us','key':'smoke-unaccepted-us'},expected=403)
        call('/indmoney-us/imports/'+str(preview['id'])+'/accept',{'content_hash':preview['content_hash'],'accept':True})
        us=call('/runs/analysis-workflows',{'portfolio':'indmoney_us','key':'smoke-accepted-us'})
        completed(us['id'])
        exported=call('/uat2/simulation/analysis/'+str(managed['id'])+'/private-export',{'key':'smoke-private-export'})
        download=call(exported['download_path'])
        assert download['owner_id']==owner_id and download['orders_authorized'] is False and exported['external_delivery'] is False
        observed=call('/account/operations/diagnostics')
        assert observed['source_unavailable'] is False and observed['unknown_orders'] is False and observed['external_delivery'] is False
        # Scheduled monitoring must run without this probe publishing a task.
        from app.domains.public_service.monitoring import TOPIC as MONITOR_TOPIC
        for _ in range(75):
            with SyncSessionLocal() as db:
                monitor=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==MONITOR_TOPIC,
                    OutboxMessage.payload['owner_id'].as_integer()==owner_id))
                if monitor is not None:break
            time.sleep(1)
        assert monitor is not None and monitor.payload['synthetic_sink'] is True
        print(json.dumps({'phase':'recover','actual_worker_restart':True,'original_account_reconciled':True,
            'actual_scheduler_dispatch':True,'manual_relay_submission':False,
            'both_modes_analysis':True,'accepted_us_analysis':True,'private_json_download':True,
            'source_aware_monitoring':True,'state':'filled','submission_attempts':1,'venue_receipts':1,'typed_native_evidence_export':True,
            'full_account_export':False,'owner_acceptance':False}))
    else:raise SystemExit('Expected start, before-restart or recover phase')


if __name__=='__main__':main(sys.argv[1] if len(sys.argv)>1 else '')
