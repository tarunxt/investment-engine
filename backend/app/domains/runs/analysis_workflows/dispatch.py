"""Reuse the existing bounded outbox relay; broker publication is not authority."""
from datetime import datetime,timezone,timedelta
from sqlalchemy import select,or_
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow
from .contracts import TOPIC,utc,naive,WorkflowDenied
from .service import Workflows


def dispatch(session,publisher,runtime,*,now=None,limit=10,fault=lambda point:None):
    now=utc(now or datetime.now(timezone.utc));counts={'published':0,'deferred':0,'denied':0}
    hints=list(session.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,OutboxMessage.execution_attempts==0,OutboxMessage.available_at<=naive(now),or_(OutboxMessage.published_at.is_(None),OutboxMessage.published_at<=naive(now-timedelta(seconds=30)))).order_by(OutboxMessage.created_at,OutboxMessage.id).limit(max(1,min(limit,10)))))
    for hint in hints:
        # Selection/account lock always precedes workflow/message locks.
        parent=session.scalar(select(Workflow).where(Workflow.id==hint.payload.get('workflow_id'),Workflow.user_id==hint.payload.get('owner_id')))
        if parent is None:continue
        try:runtime.policy(session,parent.user_id,parent.portfolio,version=parent.module_version,scheduled=parent.execution_json['scheduled'])
        except PermissionError:
            parent.status='paused';parent.error_message='Policy denied before dispatch';parent.control_version+=1;hint.execution_attempts+=1;session.commit();counts['denied']+=1;continue
        message=session.scalar(select(OutboxMessage).where(OutboxMessage.id==hint.id,OutboxMessage.execution_attempts==0).execution_options(populate_existing=True).with_for_update(skip_locked=True))
        if message is None:continue
        parent=Workflows(session,runtime).owned(parent.user_id,parent.id)
        if parent.status not in {'queued','processing'} or parent.control_version!=message.payload['generation']:message.execution_attempts+=1;session.commit();continue
        message.published_at=naive(now);message.attempts+=1;session.flush()
        try:
            fault('before_publish');publisher(str(message.id));fault('after_publish');counts['published']+=1
        except Exception:counts['deferred']+=1
        session.commit()
    return counts
