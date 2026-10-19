"""Default-off UAT2 identity policy. No alias folding or production changes."""
import os
from fastapi import HTTPException

OWNER_EMAIL = "tarun.singh6893@gmail.com"


def uat2_mode():
    value = os.getenv("CREDX_UAT2", "0")
    if value not in {"0", "1"}:
        raise RuntimeError("CREDX_UAT2 must be 0 or 1")
    return value == "1"


def require_uat2_owner(email):
    if uat2_mode() and email != OWNER_EMAIL:
        raise HTTPException(403, "UAT2 is restricted to its owner")


def require_password_auth_allowed():
    if uat2_mode():
        raise HTTPException(403, "UAT2 requires verified Google sign-in")


def validate_uat2_startup():
    if not uat2_mode():
        return
    from app.core.config import settings
    if settings.auth_disabled or settings.environment.lower() == "development":
        raise RuntimeError("UAT2 forbids development authentication bypass")
    if not os.getenv("GOOGLE_SIGNIN_CLIENT_ID", "").strip():
        raise RuntimeError("UAT2 requires an independent Google sign-in client")
    # Deployment is deliberately locked until simulation/network barriers have
    # passed their focused integration tests. An environment flag cannot unlock it.
    raise RuntimeError("UAT2 deployment pending simulation and network isolation acceptance")
