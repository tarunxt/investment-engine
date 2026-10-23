"""Explicit caller-owned HTTP composition; no global runtime registration.

Installation does not mount routes or change the existing UAT2 entrypoint. The
caller must finish and review its whole application before selecting this binding.
"""
from fastapi import Depends, HTTPException, Request
from app.domains.auth.dependencies import get_current_user
from app.domains.runs.analysis_router import optional_analysis_runtime
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
from app.domains.runs.analysis_workflows.runtime import policy
from app.domains.runs.analysis_workflows.synthetic_composition import SyntheticAnalysis
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from app.infrastructure.database.session import get_async_db
from app.uat2.policy_bindings import SESSION, install_session_binding


class SimulationHTTPBinding:
    def __init__(self, *, scope, source_storage=None):
        if type(scope) is not SimulationSourceScope:
            raise WorkflowDenied('Explicit simulation HTTP scope required')
        self.scope = scope
        self.analysis = SyntheticAnalysis(scope=scope, policy=policy, source_storage=source_storage)
        self._app = None

    def install(self, app):
        """Bind only this app's existing authentication/session dependencies."""
        from app.domains.public_service.application_bindings import STATE as PUBLIC_STATE
        targets = (get_async_db, optional_analysis_runtime)
        if (self._app is not None or getattr(app.state, 'simulation_http_binding', None) is not None
                or any(target in app.dependency_overrides for target in targets)
                or getattr(app.state, PUBLIC_STATE, None) is not None):
            raise WorkflowDenied('Existing application bindings cannot be replaced')
        binding = self

        async def database(request: Request):
            if request.app is not app:
                raise HTTPException(503, 'Simulation application binding mismatch')
            # Retain normal database timing, public-service collision checks and
            # session lifecycle. No separate auth session or connection pool.
            async for db in get_async_db(request):
                try:
                    await db.run_sync(lambda session: install_session_binding(session, binding.scope))
                    yield db
                except WorkflowDenied:
                    await db.rollback()
                    raise HTTPException(503, 'Explicit simulation session unavailable') from None
                finally:
                    db.info.pop(SESSION, None)

        async def runtime(request: Request, user=Depends(get_current_user), db=Depends(get_async_db)):
            if request.app is not app:
                raise HTTPException(503, 'Simulation application binding mismatch')
            try:
                await db.run_sync(lambda session: binding.scope.validate(session, user.id))
            except WorkflowDenied:
                raise HTTPException(503, 'Current simulation owner or environment unavailable') from None
            return binding.analysis.runtime

        app.dependency_overrides[get_async_db] = database
        app.dependency_overrides[optional_analysis_runtime] = runtime
        app.state.simulation_http_binding = self
        self._app = app
        return self
