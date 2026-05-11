from fastapi import APIRouter, Depends

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.ai_providers.factory import ProviderFactory

router = APIRouter(prefix="/providers", tags=["providers"])


@router.get("")
async def list_providers(current_user: User = Depends(get_current_user)):
    return ProviderFactory.list_providers()
