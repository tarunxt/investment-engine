from fastapi import APIRouter, Depends, Response
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.infrastructure.database.session import get_async_db
from .schemas import DisableImpactRequest, ModulePatch, ModuleCollection, DisableImpact, ResumeSchedulesRequest
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


@router.post('/{module_id}/resume-schedules')
async def resume_module_schedules(module_id: str, body: ResumeSchedulesRequest,
                                 response: Response, user: User=Depends(get_current_user),db=Depends(get_async_db)):
    from .lifecycle import resume_schedules
    response.headers['Cache-Control']='private, no-store'
    return await resume_schedules(db,user.id,module_id,body.expected_version)


@router.get('/safety-activity')
async def get_safety_activity(response: Response,user: User=Depends(get_current_user),db=Depends(get_async_db)):
    from .safety import safety_activity
    response.headers['Cache-Control']='private, no-store'
    return await safety_activity(db,user)


@router.get('/resource-access/{kind}/{resource_id}')
async def resource_access(kind: str,resource_id: int,response: Response,user: User=Depends(get_current_user),db=Depends(get_async_db)):
    from fastapi import HTTPException
    from sqlalchemy import select
    from app.domains.jobs.models import Job
    from app.domains.runs.models import Run
    from .policy import ModulePolicy
    model={'jobs':Job,'runs':Run}.get(kind)
    if model is None:raise HTTPException(404,'Resource not found')
    row=(await db.execute(select(model.id,model.module_id).where(model.id==resource_id,model.user_id==user.id))).first()
    if row is None:raise HTTPException(404,'Resource not found')
    allowed=False
    if row.module_id:
        decision=await ModulePolicy(db).authorize(owner_id=user.id,resource_owner_id=user.id,module_id=row.module_id,capability='view',boundary='http')
        allowed=decision.allowed
    response.headers['Cache-Control']='private, no-store'
    return {'owner_id':user.id,'resource_id':resource_id,'allowed':allowed,'module_id':row.module_id}
