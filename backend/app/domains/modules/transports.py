"""Explicit route classification; existing authentication/domain checks remain."""
from fastapi import Depends, HTTPException, Request
from fastapi.routing import APIRoute
from fastapi.dependencies.utils import get_parameterless_sub_dependant
from fastapi.routing import request_response
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from .policy import ModulePolicy

from .coverage import DOMAIN_MODULES,SAFETY_ROUTES,SAFETY_ENDPOINTS,CORE_DOMAINS,classify_route


def route_policy(route):
    pieces=route.endpoint.__module__.split('.')
    domain=pieces[pieces.index('domains')+1] if 'domains' in pieces else None
    return classify_route(domain,route.endpoint.__name__,route.path,route.methods,route.endpoint.__module__)


def install_route_policy(app):
    for route in app.routes:
        if not isinstance(route,APIRoute) or getattr(route,'module_policy_installed',False):continue
        binding=route_policy(route)
        if binding is None:continue
        def dependency(module,capability):
            async def enforce(request:Request,user=Depends(get_current_user),db=Depends(get_async_db)):
                if module=='__safety__':
                    from .tasks import _reconciliation_read
                    token=_reconciliation_read.set(True)
                    try:yield
                    finally:_reconciliation_read.reset(token)
                    return
                admitted_module=module
                if module=='__analysis_consumer__':
                    from .lifecycle import analysis_module,ModuleLifecycleDenied
                    portfolio=request.path_params.get('portfolio') or request.query_params.get('portfolio')
                    if portfolio is None and request.method not in {'GET','HEAD'}:
                        try:
                            body=await request.json()
                            portfolio=body.get('auto_rebalance_portfolio') or body.get('portfolio') if isinstance(body,dict) else None
                        except ValueError:portfolio=None
                    try:admitted_module=analysis_module(portfolio)
                    except ModuleLifecycleDenied:raise HTTPException(403,{'code':'UNKNOWN_ANALYSIS_CONSUMER'})
                if request.method not in {'GET','HEAD'}:
                    from .lifecycle import lock_owner
                    await lock_owner(db,user.id)
                result=await ModulePolicy(db).authorize(owner_id=user.id,resource_owner_id=user.id,
                    module_id=admitted_module,capability=capability,boundary='http')
                if not result.allowed:raise HTTPException(403,{'code':'MODULE_POLICY_DENIED','reasons':result.reasons})
                yield result
            return enforce
        route.dependant.dependencies.insert(0,get_parameterless_sub_dependant(depends=Depends(dependency(*binding)),path=route.path))
        route.app=request_response(route.get_route_handler());route.module_policy_installed=True
