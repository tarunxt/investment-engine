import os
from fastapi import APIRouter, Depends, HTTPException, Query, status
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User, UserRole
from .schemas import CostDriversDashboard
from .cache import RefreshCooldownError
from .service import get_dashboard
import re

router = APIRouter(prefix="/api/admin/cost-drivers", tags=["cost-drivers"])


def _allowed_admin(user: User = Depends(get_current_user)) -> User:
    allowed = {
        "tarun.singh6893@gmail.com",
        *(email.strip().lower() for email in os.getenv("COST_DASHBOARD_ADMIN_EMAILS", "").split(",") if email.strip()),
    }
    if user.role == UserRole.ADMIN or user.email.lower() in allowed:
        return user
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cost dashboard admin access required")

def _month_param(month: str | None) -> str | None:
    if month is None or month == "":
        return None
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="month must use YYYY-MM format")
    year, month_number = (int(part) for part in month.split("-", 1))
    if month_number < 1 or month_number > 12 or year < 2000 or year > 2100:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="month must use YYYY-MM format")
    return month

@router.get("/summary", response_model=CostDriversDashboard)
async def summary(month: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$"), _: User = Depends(_allowed_admin)):
    return get_dashboard(month=_month_param(month))

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
async def refresh(month: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$"), _: User = Depends(_allowed_admin)):
    try:
        return get_dashboard(force_refresh=True, month=_month_param(month))
    except RefreshCooldownError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after_seconds)},
        ) from exc
