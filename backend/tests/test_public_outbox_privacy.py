from copy import deepcopy
import pytest
from test_stage17_reviewed_residency import setup,NOW
from test_stage17_monitor_dispatch import monitor,report
from app.domains.public_service.support import SupportAccess
from app.domains.public_service.privacy import PrivacyRequests
from app.domains.public_service.public_outbox_export import PublicOutboxExport
from app.domains.ai_limits.contracts import BoundaryDenied


def test_closed_historical_consent_requests_and_local_monitor_have_owner_proof(setup):
    db,_=setup
    consent=SupportAccess(db).consent(1,2,['diagnostics'],'synthetic-private-ticket',confirmed=True,now=NOW)
    request=PrivacyRequests(db).request(1,'synthetic-private-request-key','export',confirmed=True,now=NOW)
    alert=monitor(db).enqueue(1,report(),now=NOW)
    PrivacyRequests(db).request(3,'foreign-private-request-key','delete',confirmed=True,now=NOW)
    db.commit()
    result=PublicOutboxExport(db).export(1)
    assert len(result['items'])==3
    assert {item['data']['kind'] for item in result['items']}=={'support_consent','privacy_request','local_monitor_delivery'}
    assert 'private-ticket' not in str(result) and 'private-request-key' not in str(result)
    assert result['complete_account_export'] is False
    assert len(PublicOutboxExport(db).export(3)['items'])==1
    old=deepcopy(consent.payload);consent.payload={**old,'actor_id':4};db.commit()
    with pytest.raises(BoundaryDenied):PublicOutboxExport(db).export(1)
    consent.payload=old;db.commit()
    old=deepcopy(request.payload);request.payload={**old,'kind':'delete'};db.commit()
    with pytest.raises(BoundaryDenied):PublicOutboxExport(db).export(1)
    request.payload=old;db.commit()
    alert.payload={**alert.payload,'report':{**alert.payload['report'],'owner_id':3}};db.commit()
    with pytest.raises(BoundaryDenied):PublicOutboxExport(db).export(1)


def test_module_history_and_job_dispatch_require_physical_owner_resources(setup):
    from app.domains.jobs.models import Job
    from app.domains.modules.models import UserModulePreferences
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.domains.public_service.public_outbox_export import JOB,SELECTION,RESUME
    db,_=setup
    Job.__table__.create(db.get_bind());UserModulePreferences.__table__.create(db.get_bind())
    db.add(Job(id=1,user_id=1,prompt='synthetic private prompt',provider='fake',model='fake'))
    db.add(UserModulePreferences(user_id=1,version=3));db.flush()
    job=OutboxMessage(topic=JOB,payload={'user_id':1,'job_id':1})
    db.add_all([job,OutboxMessage(topic=SELECTION,payload={'schema_version':1,'user_id':1,'version':1,
        'disabled':['indmoney_us'],'changed':['indmoney_us']}),
        OutboxMessage(topic=RESUME,payload={'schema_version':1,'user_id':1,'version':2,'module_id':'indmoney_us'})])
    db.commit();result=PublicOutboxExport(db).export(1)
    assert len(result['items'])==3 and 'private prompt' not in str(result)
    db.get(Job,1).user_id=3;db.commit()
    with pytest.raises(BoundaryDenied):PublicOutboxExport(db).export(1)


from test_stage15_execution import setup as order_setup,env,NOW as ORDER_NOW


def test_operational_queue_uses_resource_proof_not_only_its_owner_claim(order_setup):
    from test_stage17_dispatch import queue
    e=order_setup();q,_,_=queue(e)
    q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=ORDER_NOW);e.env.db.commit()
    result=PublicOutboxExport(e.env.db).export(e.row.owner_id)
    assert any(item['data']['kind']=='owned_operational_queue' for item in result['items'])
    e.row.request_digest='f'*64;e.env.db.commit()
    with pytest.raises(BoundaryDenied):PublicOutboxExport(e.env.db).export(e.row.owner_id)
