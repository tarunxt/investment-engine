import os
from fastapi import APIRouter, Depends, HTTPException, status
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User, UserRole
from .schemas import CostDriversDashboard
from .service import get_dashboard
import time

router = APIRouter(prefix="/api/admin/cost-drivers", tags=["cost-drivers"])
_LAST_REFRESH = 0.0


def _allowed_admin(user: User = Depends(get_current_user)) -> User:
    allowed = {
        "tarun.singh6893@gmail.com",
        *(email.strip().lower() for email in os.getenv("COST_DASHBOARD_ADMIN_EMAILS", "").split(",") if email.strip()),
    }
    if user.role == UserRole.ADMIN or user.email.lower() in allowed:
        return user
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cost dashboard admin access required")

@router.get("/summary", response_model=CostDriversDashboard)
async def summary(_: User = Depends(_allowed_admin)):
    return get_dashboard()

@router.get("/aws")
async def aws(_: User = Depends(_allowed_admin)):
    d = get_dashboard(); return {k: d[k] for k in ("topServices", "topUsageTypes", "inventory", "debug")}

@router.get("/traffic")
async def traffic(_: User = Depends(_allowed_admin)):
    return {"traffic": get_dashboard()["traffic"]}

@router.get("/recommendations")
async def recommendations(_: User = Depends(_allowed_admin)):
    return {"recommendations": get_dashboard()["recommendations"]}

@router.post("/refresh", response_model=CostDriversDashboard)
async def refresh(_: User = Depends(_allowed_admin)):
    global _LAST_REFRESH
    now = time.time()
    if now - _LAST_REFRESH < 60:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Refresh is rate-limited to once per minute")
    _LAST_REFRESH = now
    return get_dashboard(force_refresh=True)
