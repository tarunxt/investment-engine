from datetime import timedelta
import pytest
from sqlalchemy import select,func
from test_hosted_order_composition import order_env,worker_env,linked_env
from app.domains.auth.models import User
from app.domains.order_intents.authority import authenticated_confirmation
from app.domains.order_intents.service import orders_for_runtime,TOPIC
from app.domains.order_intents.execution import ExecutionWorker
from app.domains.order_intents.execution_models import ExecutionAttempt,ExecutionRun
from app.domains.order_intents.models import OrderIntent
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.order_intents.contracts import OrderDenied

def test_crash_after_run_commit_is_invalidated_without_submission(order_env,monkeypatch):
    e,analysis,worker,factory,app,deliveries,clock,flow,intent=order_env
    with analysis.session() as db:
        row=db.get(OrderIntent,intent)
        with authenticated_confirmation(db.get(User,1),intent,row.review_digest):
            orders_for_runtime(db,worker.orders).approve(1,intent,row.review_digest,action='confirm_exact_order_or_basket',now=clock[0])
        db.commit()
        event=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)).id
    def crash(*args,**kwargs):raise SystemExit('worker power loss after run commit')
    with monkeypatch.context() as patch:
        patch.setattr(ExecutionWorker,'_advance',crash)
        with pytest.raises(SystemExit):worker.dispatch(event)
    with factory() as db:
        assert db.get(OrderIntent,intent).state=='submitting'
        assert db.get(ExecutionRun,intent) is not None
        assert db.scalar(select(func.count()).select_from(ExecutionAttempt))==0
    clock[0]+=timedelta(seconds=6)
    assert worker.relay()['reconcile']==1
    assert worker.reconcile(intent)['state']=='invalidated'
    with pytest.raises(OrderDenied):worker.dispatch(event)

