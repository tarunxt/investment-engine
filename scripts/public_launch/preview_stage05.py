"""Only the local synthetic harness imports these offline read adapters."""
from datetime import datetime, timezone
from fastapi import APIRouter

from app.domains.auth.admin_roles import AdministrativeRoleGrant
from app.domains.polymarket import router as runtime
from app.domains.polymarket.runtime_broker import BullpenRuntimePassiveHealth, BullpenRuntimeCachedHealth
from app.domains.cost_drivers import router as costs
from app.domains.cost_drivers.service import _empty_live_dashboard
from app.domains.sports_rankings import router as sports
from app.domains.sports_rankings.models import SportsRankingSnapshot

TABLES=(AdministrativeRoleGrant.__table__, SportsRankingSnapshot.__table__)
ALLOWED={('GET','/polymarket/state'),('GET','/polymarket/history'),
         ('GET','/polymarket/runtime/health'),('GET','/api/sports-rankings'),
         ('POST','/api/sports-rankings/classify'),('POST','/api/sports-rankings/refresh'),
         ('POST','/api/sports-rankings/cricket/reconcile')}


def install(app):
    class OfflineBroker:
        async def read_passive_health(self, *, strict_read_only):
            assert strict_read_only
            now=datetime.now(timezone.utc).isoformat()
            return BullpenRuntimePassiveHealth(ok=True, checked_at=now,
                broker_health=BullpenRuntimeCachedHealth(ok=True, checked_at=now,
                    message='SYNTHETIC OFFLINE operator health; no CLI or provider',
                    cli_version='offline'))
    runtime.get_bullpen_runtime_broker=lambda: OfflineBroker()
    costs.get_dashboard=lambda **kwargs: _empty_live_dashboard('2026-10')
    sports.CATALOGUE=[]
    sports.load_participant_index=lambda _user_id: {}
    for router in (runtime.router,costs.router,sports.router):
        for route in router.routes:
            if route.path.startswith('/api/admin/cost-drivers'):
                ALLOWED.update((m,route.path) for m in route.methods)
                app.include_router(APIRouter(routes=[route]))
            elif any((m,route.path) in ALLOWED for m in route.methods):
                app.include_router(APIRouter(routes=[route]))
