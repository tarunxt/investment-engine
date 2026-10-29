"""Read-only saved prompt inventory; never an AI dispatch or plan mutation."""
from fastapi import APIRouter,Depends,HTTPException,Query,Request,Response
from sqlalchemy import select,and_,or_
from sqlalchemy.ext.asyncio import AsyncSession
from app.domains.auth.dependencies import get_current_user
from app.domains.prompts.models import Prompt
from app.infrastructure.database.session import get_async_db
from .http_bindings import request_binding

router=APIRouter(prefix='/uat2/simulation/prompt-library',tags=['uat2'])
def owned(user):
    # A system record with a private owner is inconsistent, not public evidence.
    return or_(and_(Prompt.is_system.is_(True),Prompt.user_id.is_(None)),and_(Prompt.is_system.is_(False),Prompt.user_id==user.id))
def project(row,include_body=False):
    return {'id':row.id,'version':row.version,'name':row.name,'description':row.description[:4000] if row.description else None,
        'body':row.body[:128000] if include_body else None,'body_truncated':include_body and len(row.body)>128000,'body_length':len(row.body),'is_active':row.is_active,'source_owner':'system' if row.is_system else 'current_owner'}
def require(request,response):
    if request_binding(request) is None:raise HTTPException(503,'Installed simulation binding required')
    response.headers['Cache-Control']='private, no-store';response.headers['Vary']='Cookie, Authorization'
@router.get('')
async def library(request:Request,response:Response,q:str=Query(default='',max_length=120),limit:int=Query(default=100,ge=1,le=100),user=Depends(get_current_user),db:AsyncSession=Depends(get_async_db)):
    require(request,response)
    query=select(Prompt).where(owned(user))
    if q:query=query.where(Prompt.name.ilike('%'+q+'%'))
    rows=(await db.execute(query.order_by(Prompt.id.desc()).limit(limit+1))).scalars().all()
    return {'schema_version':1,'owner_id':user.id,'simulation_only':True,'items':[project(row) for row in rows[:limit]],'has_more':len(rows)>limit,'read_only':True,'governed_prompt_override_available':False}
@router.get('/{id}')
async def detail(id:int,request:Request,response:Response,user=Depends(get_current_user),db:AsyncSession=Depends(get_async_db)):
    require(request,response)
    row=(await db.execute(select(Prompt).where(Prompt.id==id,owned(user)))).scalar_one_or_none()
    if row is None:raise HTTPException(404,'Saved prompt not found in this account scope')
    return {'schema_version':1,'owner_id':user.id,'simulation_only':True,'read_only':True,'item':project(row,include_body=True),'governed_prompt_override_available':False}
