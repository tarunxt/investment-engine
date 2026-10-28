from uuid import UUID
import pytest
from sqlalchemy.orm import sessionmaker
from test_stage07_lifecycle import eligible,modules,private_api,payload
from app.domains.modules.dispatch import prepare_dispatch,HEADER,resource_locator,load_binding
from app.domains.public_service.public_outbox_export import PublicOutboxExport
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.modules.lifecycle import ModuleLifecycleDenied


def test_producer_resource_locator_is_validated_and_legacy_history_is_held(eligible):
    a=eligible;subject=a.users[0].id
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('zerodha_rebalance',True))).status_code==200
    factory=sessionmaker(a.session.get_bind(),expire_on_commit=False)
    name='app.domains.zerodha.tasks.sync_portfolio_snapshot_task'
    options=prepare_dispatch(name,[subject],{}, {},factory=factory)
    identifier=UUID(options['headers'][HEADER]);a.session.expire_all()
    row=a.session.get(OutboxMessage,identifier)
    assert row.payload['resource']=={'kind':'user','id':subject}
    result=PublicOutboxExport(a.session).export(subject)
    assert any(item['data']['kind']=='typed_task_locator' for item in result['items'])
    original=row.payload
    row.payload={key:value for key,value in original.items() if key!='resource'};a.session.commit()
    assert any(item['data']['kind']=='historical_task_locator' for item in PublicOutboxExport(a.session).export(subject)['items'])
    row.payload={**original,'resource':{'kind':'user','id':a.users[1].id}};a.session.commit()
    with pytest.raises(BoundaryDenied):PublicOutboxExport(a.session).export(subject)
    with pytest.raises(ModuleLifecycleDenied):load_binding(a.session,identifier,name,[subject],{})


def test_typed_locator_never_serializes_extra_task_arguments():
    assert resource_locator('app.domains.google_sheets.tasks.export_job',[1,2,'SYNTHETIC_PRIVATE'],{})=={'kind':'job','id':2}
    with pytest.raises(ModuleLifecycleDenied):resource_locator('app.domains.google_sheets.tasks.export_job',[1,'../../private'],{})
