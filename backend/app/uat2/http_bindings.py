"""Explicit application composition; no dependency overrides or global runtime.

The normal request session and runtime dependencies consult this exact binding.
Installation itself mounts no routes and performs no hosted activation.
"""
from fastapi import HTTPException
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
from app.domains.runs.analysis_workflows.runtime import policy
from app.domains.runs.analysis_workflows.synthetic_composition import SyntheticAnalysis
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from app.uat2.policy_bindings import install_session_binding

STATE = 'simulation_http_binding'


class SimulationHTTPBinding:
    def __init__(self, *, scope, source_storage=None):
        if type(scope) is not SimulationSourceScope:
            raise WorkflowDenied('Explicit simulation HTTP scope required')
        self.scope = scope
        self.analysis = SyntheticAnalysis(scope=scope, policy=policy, source_storage=source_storage)
        from .synthetic_orders import SyntheticOrders
        self.orders = SyntheticOrders(self.analysis)
        self._app = None

    def install(self, app):
        from app.domains.public_service.application_bindings import STATE as PUBLIC_STATE
        from app.infrastructure.database.session import get_async_db
        from app.domains.runs.analysis_router import optional_analysis_runtime
        if (self._app is not None or getattr(app.state, STATE, None) is not None
                or any(target in app.dependency_overrides for target in (get_async_db, optional_analysis_runtime))
                or getattr(app.state, PUBLIC_STATE, None) is not None):
            raise WorkflowDenied('Existing application bindings cannot be replaced')
        setattr(app.state, STATE, self)
        self._app = app
        return self


def request_binding(request):
    value = getattr(request.app.state, STATE, None) if request is not None else None
    if value is None: return None
    if type(value) is not SimulationHTTPBinding or value._app is not request.app:
        raise HTTPException(503, 'Exact simulation application binding required')
    return value


def attach_request_binding(request, session):
    value = request_binding(request)
    if value is None: return None
    try: install_session_binding(session.sync_session, value.scope)
    except WorkflowDenied: raise HTTPException(503, 'Explicit simulation session unavailable') from None
    return value


async def analysis_runtime(request, db, owner):
    value = request_binding(request)
    if value is None: return None
    try: await db.run_sync(lambda session: value.scope.validate(session, owner))
    except WorkflowDenied: raise HTTPException(503, 'Current simulation owner or environment unavailable') from None
    return value.analysis.runtime
