"""Explicit private JSON analysis download; no external destination or sends."""
from datetime import datetime, timedelta, timezone
from sqlalchemy import select, func
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.ai_limits.private_effects import PrivateEffects, LocalSink, Destination, current_policy, TOPIC
from app.domains.runs.analysis_workflows.contracts import naive


def prepare_export(db, owner, workflow_id, *, analysis, key):
    evidence = analysis.completed_analysis(db, owner, workflow_id)
    identity = analysis.authorize(db, owner, evidence['source']['portfolio'])
    now = datetime.now(timezone.utc)
    from app.infrastructure.database.outbox.models import OutboxMessage
    count = db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic == TOPIC,
        OutboxMessage.payload['owner_id'].as_integer() == owner, OutboxMessage.created_at >= naive(now-timedelta(hours=24))))
    prior=db.scalar(select(OutboxMessage.id).where(OutboxMessage.topic == TOPIC,
        OutboxMessage.payload['owner_id'].as_integer() == owner,
        OutboxMessage.payload['request_key'].as_string() == key).limit(1))
    if count >= 50 and prior is None: raise BoundaryDenied('PRIVATE_EXPORT_DAILY_BOUND_REACHED')
    # Only verified advisory output and provenance enter the download. Prompts,
    # request bodies, private credentials and arbitrary file paths are omitted.
    content = {'schema_version':1,'simulation_only':True,'owner_id':owner,
        'workflow_id':workflow_id,'module_id':evidence['module_id'],
        'module_version':evidence['module_version'],'source_hash':evidence['source_hash'],
        'plan_hash':evidence['plan_hash'],'actionables_result_hash':evidence['actionables_result_hash'],
        'recommendations':evidence['recommendations'],'orders_authorized':False}
    service = PrivateEffects(db,current_policy,sink=LocalSink(),
        preferences=lambda session, identity, kind: kind == 'export')
    artifact = service.enqueue(identity,key,content,destination=Destination(owner,identity.module_id,
        'local:owned-analysis-download'),kind='export',preference=True,now=now)
    service.dispatch(owner,artifact.id,now=now)
    service.download(owner,artifact.id,now=now)
    return {'artifact_id':str(artifact.id),'owner_id':owner,'simulation_only':True,
        'download_path':'/api-usage/limits/private-artifacts/'+str(artifact.id),
        'external_delivery':False,'complete_account_export':False}
