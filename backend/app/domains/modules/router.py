from fastapi import APIRouter, Depends, Response
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.infrastructure.database.session import get_async_db
from .schemas import DisableImpactRequest, ModulePatch, ModuleCollection, DisableImpact
from .service import describe, disable_impact, patch_modules

router = APIRouter(prefix='/me/modules', tags=['modules'])


@router.get('', response_model=ModuleCollection)
async def get_modules(response: Response, user: User = Depends(get_current_user), db=Depends(get_async_db)):
    response.headers['Cache-Control'] = 'private, no-store'
    return await describe(db, user.id)


@router.patch('', response_model=ModuleCollection)
async def update_modules(body: ModulePatch, response: Response,
                         user: User = Depends(get_current_user), db=Depends(get_async_db)):
    response.headers['Cache-Control'] = 'private, no-store'
    return await patch_modules(db, user.id, body)


@router.post('/disable-impact', response_model=DisableImpact)
async def preview_disable(body: DisableImpactRequest, response: Response,
                          user: User = Depends(get_current_user), db=Depends(get_async_db)):
    response.headers['Cache-Control'] = 'private, no-store'
    return await disable_impact(db, user.id, body)
