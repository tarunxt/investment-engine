"""Explicit disposable financial consumer factory; never a runtime default.

The constructor is server-owned, not request data. Every request and worker
session must resolve to the same acknowledged disposable database scope before
the trusted builder runs. Only the existing durable fake venue is accepted.
Analysis composition and real provider factories remain unavailable here.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime,timezone
from typing import Callable
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from app.domains.ai_limits.contracts import BoundaryDenied,utc
from app.domains.order_intents.execution_fake import ExecutionBrokerFake, MarketDataFake
from .sql_privacy_workflow import DisposablePrivacyScope
from .dispatch import SyntheticWorkBindings
from .composition import IsolatedConsumerComposition


@dataclass(frozen=True)
class DisposableConsumerFactory:
    scope: DisposablePrivacyScope
    engine: Engine
    scope_hash: str
    builder: Callable[[Session], SyntheticWorkBindings]
    clock: Callable[[], datetime] | None = None

    @classmethod
    def from_session(cls, db, scope, builder):
        if type(scope) is not DisposablePrivacyScope or not callable(builder):
            raise BoundaryDenied('DISPOSABLE_CONSUMER_FACTORY_REQUIRED')
        fingerprint = scope.validate(db)
        engine = db.get_bind()
        if not isinstance(engine, Engine):
            raise BoundaryDenied('DISPOSABLE_CONSUMER_ENGINE_REQUIRED')
        return cls(scope, engine, fingerprint, builder)

    def validate(self, reference):
        if (type(self.scope) is not DisposablePrivacyScope or self.scope.reference != reference
            or not isinstance(self.engine, Engine) or not callable(self.builder)
            or type(self.scope_hash) is not str or len(self.scope_hash) != 64
            or self.clock is not None and not callable(self.clock)):
            raise BoundaryDenied('DISPOSABLE_CONSUMER_FACTORY_REQUIRED')
        # Static validation must not open a database or call the builder.
        import os
        if os.getenv('ENVIRONMENT') != 'test':
            raise BoundaryDenied('DISPOSABLE_CONSUMER_FACTORY_REQUIRED')
        return self

    def check_session(self, db):
        self.validate(self.scope.reference)
        if self.scope.validate(db) != self.scope_hash:
            raise BoundaryDenied('DISPOSABLE_CONSUMER_DATABASE_CHANGED')

    @contextmanager
    def session(self):
        with Session(self.engine, expire_on_commit=False) as db:
            self.check_session(db)
            yield db

    def bindings(self, db):
        self.check_session(db)  # Before any builder code or fake effect.
        value = self.builder(db)
        if (type(value) is not SyntheticWorkBindings or value.db is not db
            or value.analysis is not None or not value.executions):
            raise BoundaryDenied('DISPOSABLE_FINANCIAL_BINDING_REQUIRED')
        for worker in value.executions.values():
            if (worker.db is not db or type(worker.broker) is not ExecutionBrokerFake
                or type(worker.market) is not MarketDataFake
                or worker.broker.engine is self.engine):
                raise BoundaryDenied('DISPOSABLE_FAKE_VENUE_REQUIRED')
            # A second private pytest database is the fake venue, never an
            # operator file or a mutable shared application database.
            with Session(worker.broker.engine) as venue:
                if self.scope.validate(venue) == self.scope_hash:
                    raise BoundaryDenied('DISPOSABLE_FAKE_VENUE_REQUIRED')
        return value

    def composition(self, *, clock=None):
        self.validate(self.scope.reference)
        return IsolatedConsumerComposition(session_factory=self.session,
            bindings_factory=self.bindings, clock=clock or self.now)

    def check_transport(self, app):
        """Validate Celery's effective endpoints before task registration.

        Read/write URL properties can override broker_url (including via
        Celery's environment settings). Do not instantiate a connection or a
        transport plugin to inspect them: validation itself has no I/O.
        """
        from pathlib import Path
        import os,re,math
        self.validate(self.scope.reference)
        conf=app.conf
        url=conf.broker_url
        if (type(url) is not str or url not in {'memory://','redis://redis:6379/14'}
            or conf.broker_read_url != url or conf.broker_write_url != url
            or conf.result_backend not in (None,'cache+memory://')
            or conf.broker_transport is not None
            or any(getattr(conf,key) is not None for key in (
                'broker_user','broker_password','broker_vhost','broker_port','broker_login_method'))
            or conf.broker_use_ssl is not None and conf.broker_use_ssl is not False
            or conf.broker_failover_strategy not in (None,'round-robin')):
            raise BoundaryDenied('DISPOSABLE_CONSUMER_TRANSPORT_REQUIRED')
        options=conf.broker_transport_options
        if type(options) is not dict:
            raise BoundaryDenied('DISPOSABLE_CONSUMER_TRANSPORT_REQUIRED')
        if url == 'memory://':
            if options:raise BoundaryDenied('DISPOSABLE_CONSUMER_TRANSPORT_REQUIRED')
            return
        if (not Path('/.dockerenv').is_file()
            or os.getenv('CREDX_STAGE17_REDIS_ACK') != 'disposable-ci-only'
            or os.getenv('CREDX_STAGE17_REDIS_URL') != url
            or set(options)-{'global_keyprefix','visibility_timeout','polling_interval'}
            or type(options.get('global_keyprefix')) is not str
            or not re.fullmatch(r'stage17_[0-9a-f]{32}:',options['global_keyprefix'])
            or type(options.get('visibility_timeout',5)) is not int
            or not 1<=options.get('visibility_timeout',5)<=300
            or type(options.get('polling_interval',.2)) not in (int,float)
            or not math.isfinite(options.get('polling_interval',.2))
            or not .01<=options.get('polling_interval',.2)<=1):
            raise BoundaryDenied('DISPOSABLE_CONSUMER_TRANSPORT_REQUIRED')

    def now(self):
        return utc(self.clock() if self.clock else datetime.now(timezone.utc))
