"""Install the actual bounded owner-only workflow, independent of previews."""
from fastapi import APIRouter
from app.domains.runs.analysis_router import router as analysis_router
from app.domains.order_intents.router import router as orders_router
from app.domains.indmoney_us.router import router as import_router
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from .http_bindings import SimulationHTTPBinding
from .workflow_router import router as controls_router


def install_workflow(app, *, scope=None, source_storage=None):
    # Server composition only. Neither headers, request bodies nor flags can
    # replace this binding or add an external adapter.
    binding = SimulationHTTPBinding(scope=scope or SimulationSourceScope('hosted'),
        source_storage=source_storage).install(app)
    app.include_router(analysis_router)
    app.include_router(controls_router)
    allowed_imports = {('GET', '/indmoney-us/portfolio'), ('GET', '/indmoney-us/portfolio/{snapshot_id}'),
        ('GET', '/indmoney-us/imports/template'), ('POST', '/indmoney-us/imports/preview'),
        ('POST', '/indmoney-us/imports/{snapshot_id}/accept')}
    for route in import_router.routes:
        if len(route.methods) == 1 and (next(iter(route.methods)), route.path) in allowed_imports:
            app.include_router(APIRouter(routes=[route]))
    allowed_orders = {('GET', '/order-intents/reviews'), ('GET', '/order-intents/reviews/{id}'),
        ('GET', '/order-intents/positions'), ('GET', '/order-intents/status'), ('POST', '/order-intents/{id}/approve'),
        ('POST', '/order-intents/{id}/revoke')}
    for route in orders_router.routes:
        if len(route.methods) == 1 and (next(iter(route.methods)), route.path) in allowed_orders:
            app.include_router(APIRouter(routes=[route]))
    return binding
