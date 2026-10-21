from datetime import timedelta
from sqlalchemy import select
from app.domains.public_service.dispatch import OperationalQueues,SyntheticWorkBindings
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.domains.order_intents.models import OrderIntent,OrderLeg
from app.domains.connections.models import IntegrationConnection
from test_stage13_governed_jobs import governed,first_job
from test_stage12_durable_analysis import env,NOW
from test_stage17_dispatch import proof,monitors

def test_actual_governed_analysis_is_dispatched_with_existing_budget_and_owner_fences(env):
    e=env;runtime,providers=governed(e);row,job=first_job(e,runtime)
    # Monitor actual tables are initialized as they are by normal migrations.
    for m in (IntegrationConnection,OrderIntent,OrderLeg):m.__table__.create(e.engine,checkfirst=True)
    monitors(e.db,e.engine,1,NOW);p,_=proof(e.db,1,NOW)
    q=OperationalQueues(e.db,SyntheticWorkBindings(e.db,residency=p,analysis=runtime))
    item=q.enqueue(1,'analysis',str(job.id),now=NOW);e.db.commit()
    result=q.work_once('analysis',now=NOW)
    assert result['result']['status']=='completed' and len(providers)==1 and providers[0].calls==1
    assert q.work_once('analysis',now=NOW)is None
    assert len(providers)==1

def test_analysis_capacity_and_neighbor_fairness_use_persisted_leases(env):
    from test_stage12_durable_analysis import service,message,TOPIC as WORKFLOW_TOPIC
    from app.domains.jobs.models import Job
    from app.infrastructure.database.outbox.models import OutboxMessage
    e=env;runtime,providers=governed(e)
    for m in (IntegrationConnection,OrderIntent,OrderLeg):m.__table__.create(e.engine,checkfirst=True)
    jobs=[]
    for owner,key in [(1,'first-request'),(1,'second-request'),(2,'neighbor-request')]:
        row=service(e,runtime).create(owner,'indmoney_us',key,now=NOW);e.db.commit()
        event=e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==WORKFLOW_TOPIC,OutboxMessage.payload['workflow_id'].as_string()==row.id))
        assert service(e,runtime).consume(event.id,now=NOW)=='completed';e.db.commit()
        assert service(e,runtime).consume(message(e).id,now=NOW)=='waiting';e.db.commit()
        jobs.append(e.db.scalar(select(Job).where(Job.user_id==owner).order_by(Job.id.desc())))
    monitors(e.db,e.engine,1,NOW);monitors(e.db,e.engine,2,NOW);p,_=proof(e.db,1,NOW)
    p.record(e.db,2,country='IN',evidence_reference='synthetic:neighbor',reviewer='synthetic:operator',now=NOW,expires=NOW+timedelta(hours=1));e.db.commit()
    q=OperationalQueues(e.db,SyntheticWorkBindings(e.db,residency=p,analysis=runtime));ids=[]
    for job in jobs:
        ids.append(q.enqueue(job.user_id,'analysis',str(job.id),now=NOW).id)
    e.db.commit();one=q.claim('analysis',now=NOW);two=q.claim('analysis',now=NOW)
    assert {e.db.get(OutboxMessage,key).payload['owner_id'] for key,lease in [one,two]}=={1,2}
    assert q.claim('analysis',now=NOW)is None and not providers


def test_residency_revoked_after_claim_prevents_actual_provider_effect(env):
    e=env;runtime,providers=governed(e);row,job=first_job(e,runtime)
    for m in (IntegrationConnection,OrderIntent,OrderLeg):m.__table__.create(e.engine,checkfirst=True)
    monitors(e.db,e.engine,1,NOW);p,review=proof(e.db,1,NOW)
    q=OperationalQueues(e.db,SyntheticWorkBindings(e.db,residency=p,analysis=runtime))
    q.enqueue(1,'analysis',str(job.id),now=NOW);e.db.commit()
    def revoke():p.revoke(e.db,1,review.id);e.db.commit()
    result=q.work_once('analysis',now=NOW,after_claim=revoke)
    assert result['state']=='blocked' and not providers
