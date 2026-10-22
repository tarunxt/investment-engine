"""Explicit disposable application composition; absent bindings stay disabled.

No environment flag constructs policy, approves legal use, registers schedules
or starts a worker. Installation is test-only and caller-owned. Live adapters,
real export/deletion and external notifications have no composition here.
"""
from dataclasses import dataclass
import os
from fastapi import HTTPException, Request
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.connections.crypto import ConnectionKeyring
from .composition import PublicServiceServer, IsolatedConsumerComposition, ServerBindings
from .canonical_privacy_inventory import assert_owned_relationships
from .safe_privacy_projection import safe_canonical_inventory
from .sql_privacy_workflow import DisposablePrivacyScope, DisposableSQLPrivacyWorkflow
from .sql_privacy_plan import RetentionSchedule

STATE='public_service_disposable_bindings'
SESSION='public_service_reviewed_facts'
SIGNUP='public_service_signup_context'

@dataclass(frozen=True)
class DisposableApplicationBindings:
    reference:str
    server:PublicServiceServer
    scope:DisposablePrivacyScope
    consumers:IsolatedConsumerComposition|None=None
    signup_perimeter:object=None
    consumer_factory:object=None

    def validate(self):
        if (os.getenv('ENVIRONMENT')!='test' or type(self.reference) is not str
            or not self.reference.startswith('synthetic:') or not 12<=len(self.reference)<=120
            or type(self.server) is not PublicServiceServer
            or type(self.server.bindings) is not ServerBindings
            or type(self.scope) is not DisposablePrivacyScope or self.scope.reference!=self.reference
            or type(self.server.keyring) is not ConnectionKeyring
            or type(self.server.bindings.retention_schedule) is not RetentionSchedule
            or type(self.server.bindings.retention_schedule.reference) is not str
            or not self.server.bindings.retention_schedule.reference.startswith('synthetic:')
            or self.consumers is not None and type(self.consumers) is not IsolatedConsumerComposition):
            raise BoundaryDenied('DISPOSABLE_APPLICATION_BINDING_REQUIRED')
        if self.consumers is not None and (self.consumers.session_factory is not None or self.consumers.bindings_factory is not None):
            raise BoundaryDenied('DISPOSABLE_CONSUMER_FACTORY_UNAVAILABLE')
        if self.consumer_factory is not None:
            from .disposable_consumers import DisposableConsumerFactory
            if type(self.consumer_factory) is not DisposableConsumerFactory or self.consumers is not None:
                raise BoundaryDenied('DISPOSABLE_CONSUMER_FACTORY_REQUIRED')
            self.consumer_factory.validate(self.reference)
        from app.infrastructure.database.base import Base
        inventory=self.server.bindings.account_inventory
        from .sql_account import AccountInventory
        if (type(inventory) is not AccountInventory or type(inventory.reference) is not str
            or not inventory.reference.startswith('synthetic:')):
            raise BoundaryDenied('DISPOSABLE_APPLICATION_BINDING_REQUIRED')
        if inventory!=safe_canonical_inventory(Base.metadata,reference=inventory.reference):
            raise BoundaryDenied('CANONICAL_APPLICATION_INVENTORY_REQUIRED')
        if self.signup_perimeter is not None:
            from .signup_perimeter import SignupPerimeter,SignupPerimeterPolicy,ChallengeVerifier
            if (type(self.signup_perimeter) is not SignupPerimeter
                or type(self.signup_perimeter.policy) is not SignupPerimeterPolicy
                or not self.signup_perimeter.policy.reference.startswith('synthetic:')
                or not isinstance(self.signup_perimeter.verifier,ChallengeVerifier)):
                raise BoundaryDenied('DISPOSABLE_APPLICATION_BINDING_REQUIRED')
            self.signup_perimeter.policy.validate()
        return self

    def monitor(self,db):
        self.validate()
        from .monitor_dispatch import MonitorDispatch
        return MonitorDispatch(db) # No sink/roster: dispatch fails before any DB/effect.

    def privacy(self,db,owner_id):
        self.validate();self.scope.validate(db)
        from app.infrastructure.database.base import Base
        reader=assert_owned_relationships(db,Base.metadata,owner_id)
        # Preserve the explicitly configured review reference after the same
        # canonical structure and integrity have independently been checked.
        reader.inventory=self.server.bindings.account_inventory
        return DisposableSQLPrivacyWorkflow(db,reader,self.server.keyring,
            retention=self.server.bindings.retention_schedule,scope=self.scope)

    def register_consumers(self,app):
        self.validate()
        # Keep the composition attached to the caller-owned Celery app so
        # repeated registration cannot replace already registered handlers.
        if self.consumer_factory is not None:
            self.consumer_factory.check_transport(app)
            composition=getattr(app,'_credx_disposable_composition',None)
            if composition is None:
                composition=self.consumer_factory.composition()
                app._credx_disposable_composition=(self.consumer_factory,composition)
            else:
                factory,composition=composition
                if factory is not self.consumer_factory:
                    raise BoundaryDenied('APPLICATION_BINDING_ALREADY_INSTALLED')
        else:composition=self.consumers or IsolatedConsumerComposition()
        return composition.register(app)  # Explicit local app only; no send/Beat registration.

    def queues(self,db):
        self.validate()
        if self.consumer_factory is None:
            raise BoundaryDenied('DISPOSABLE_CONSUMER_FACTORY_UNAVAILABLE')
        from .dispatch import OperationalQueues
        return OperationalQueues(db,self.consumer_factory.bindings(db))


def install_disposable_bindings(app,bindings):
    if type(bindings) is not DisposableApplicationBindings:
        raise BoundaryDenied('DISPOSABLE_APPLICATION_BINDING_REQUIRED')
    bindings.validate()
    previous=getattr(app.state,STATE,None)
    if previous is not None and previous is not bindings:
        raise BoundaryDenied('APPLICATION_BINDING_ALREADY_INSTALLED')
    setattr(app.state,STATE,bindings)


def request_bindings(request:Request):
    value=getattr(request.app.state,STATE,None)
    if type(value) is not DisposableApplicationBindings:
        raise HTTPException(503,'Reviewed disposable service binding unavailable')
    try:return value.validate()
    except BoundaryDenied:raise HTTPException(503,'Reviewed disposable service binding unavailable') from None


class RequestFactsResolver:
    def __init__(self,session,bindings):
        self.session,self.bindings=session,bindings
    async def resolve(self,owner_id,module_id):
        from app.domains.modules.policy import DefaultFactsResolver
        facts=await DefaultFactsResolver().resolve(owner_id,module_id)
        self.bindings.validate()
        def resolve(db):
            self.bindings.scope.validate(db)
            return self.bindings.server.module_facts(db,owner_id,facts)
        return await self.session.run_sync(resolve)


def attach_request_facts(request,session):
    session.info.pop(SESSION,None);session.info.pop(SIGNUP,None)
    bindings=getattr(request.app.state,STATE,None) if request is not None else None
    if bindings is None:return
    if type(bindings) is not DisposableApplicationBindings:
        raise HTTPException(503,'Reviewed disposable service binding unavailable')
    try:bindings.validate()
    except BoundaryDenied:raise HTTPException(503,'Reviewed disposable service binding unavailable') from None
    session.info[SESSION]=RequestFactsResolver(session,bindings)
    forwarded={b'forwarded',b'x-forwarded-for',b'x-real-ip'}
    session.info[SIGNUP]=RequestSignupContext(bindings,
        request.headers.get('x-credx-signup-challenge'),request.client.host if request.client else None,
        tuple((name,value) for name,value in request.scope.get('headers',[]) if name.lower() in forwarded))
    return bindings


def facts_for_session(session):
    info=getattr(session,'info',None)
    if info is None:return None # Legacy unconfigured session ports have no binding channel.
    if type(info) is not dict:raise BoundaryDenied('REQUEST_FACTS_BINDING_CHANGED')
    value=info.get(SESSION)
    if value is None:return None
    if type(value) is not RequestFactsResolver or value.session is not session:
        raise BoundaryDenied('REQUEST_FACTS_BINDING_CHANGED')
    value.bindings.validate()
    return value


@dataclass(frozen=True)
class RequestSignupContext:
    bindings:DisposableApplicationBindings
    token:str|None
    peer:str|None
    headers:tuple


async def configured_signup(db,email):
    info=getattr(db,'info',None)
    if info is None:return None # Preserve legacy unconfigured quota path.
    if type(info) is not dict:raise HTTPException(503,'Configured signup admission unavailable')
    context=info.get(SIGNUP)
    if context is None:return None # Existing unconfigured quota path remains unchanged.
    if type(context) is not RequestSignupContext:
        raise HTTPException(503,'Configured signup admission unavailable')
    try:context.bindings.validate()
    except BoundaryDenied:raise HTTPException(503,'Configured signup admission unavailable') from None
    if context.bindings.signup_perimeter is None:
        raise HTTPException(503,'Configured signup admission unavailable')
    def admit(s):
        context.bindings.scope.validate(s)
        return context.bindings.signup_perimeter.admit(s,email,context.token,peer=context.peer,headers=context.headers)
    try:return await db.run_sync(admit)
    except BoundaryDenied:raise HTTPException(429,'Configured signup admission unavailable') from None
