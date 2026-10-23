"""Test-only authenticated application -> typed worker on existing CI services."""
from dataclasses import replace
from datetime import datetime,timezone,timedelta
from fastapi import FastAPI
from httpx import ASGITransport,AsyncClient
from sqlalchemy.orm import Session
from app.core.config import settings
from app.core.security import JWTUtils
from app.infrastructure.database import session as sessions
from app.infrastructure.database.base import Base
from app.domains.public_service.application_bindings import DisposableApplicationBindings,install_disposable_bindings
from app.domains.public_service.disposable_consumers import DisposableConsumerFactory
from app.domains.public_service.composition import PublicServiceServer,ServerBindings
from app.domains.public_service.safe_privacy_projection import safe_canonical_inventory
from app.domains.public_service.sql_privacy_plan import RetentionSchedule
from app.domains.public_service.sql_privacy_workflow import DisposablePrivacyScope
from app.domains.public_service.router import router
from app.domains.modules.transports import install_route_policy


def configured_worker(database,builder,celery_app,monkeypatch,now):
    engine,async_factory,owner,_,ring=database
    reference='synthetic:http-to-worker'
    scope=DisposablePrivacyScope(reference)
    with Session(engine) as db:factory=DisposableConsumerFactory.from_session(db,scope,builder)
    factory=replace(factory,clock=lambda:now)
    server=PublicServiceServer(keyring=ring,bindings=ServerBindings(
        account_inventory=safe_canonical_inventory(Base.metadata,reference=reference),
        retention_schedule=RetentionSchedule(reference,datetime.now(timezone.utc)+timedelta(days=1))))
    binding=DisposableApplicationBindings(reference,server,scope,consumer_factory=factory)
    app=FastAPI();app.include_router(router);install_route_policy(app);install_disposable_bindings(app,binding)
    monkeypatch.setattr(sessions,'AsyncSessionLocal',async_factory)
    monkeypatch.setattr(settings,'auth_disabled',False)
    monkeypatch.setenv('JWT_SIGNING_KEY','synthetic-stage17-worker-http-'+('x'*48))
    tasks=binding.register_consumers(celery_app)
    composition=celery_app._credx_disposable_composition[1]

    async def admit(identity,resource,*,confirmed=True,lane='execution'):
        token=JWTUtils.create_access_token(identity,'synthetic@example.invalid','user')
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
            return await client.post('/account/operations/disposable/operational-queue',
                headers={'Authorization':'Bearer '+token},
                json={'lane':lane,'resource':str(resource),'confirmed':confirmed})
    return binding,composition,tasks,admit
