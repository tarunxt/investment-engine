from fastapi import APIRouter, Depends

from app.models.user import User
from app.providers.factory import ProviderFactory
from app.db.auth_dependencies import get_current_user

router = APIRouter(prefix="/providers", tags=["providers"])


@router.get("")
def list_providers(current_user: User = Depends(get_current_user)):
    return ProviderFactory.list_providers()
