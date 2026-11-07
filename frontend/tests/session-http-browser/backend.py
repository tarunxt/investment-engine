"""Disposable synthetic auth HTTP fixture. No production app/worker activation."""
import os,sys,socket,subprocess
from pathlib import Path
repo=Path(__file__).resolve().parents[3]
# Read no inherited application environment or .env. Values below are public
# synthetic fixtures, never credentials for any real account or service.
os.environ.clear();os.environ.update(JWT_SIGNING_KEY=bytes(range(32)).hex(),DATABASE_URL='postgresql+asyncpg://postgres@/a9_synthetic?host=/tmp/a9-session-pg-socket-20261103',REDIS_URL='redis://127.0.0.1:1',AWS_EC2_METADATA_DISABLED='true',ENVIRONMENT='test',AUTH_DISABLED='false')
os.chdir(Path('/tmp'));sys.path.insert(0,str(repo/'backend'))
original=socket.socket.connect
SOCKET='/tmp/a9-session-pg-socket-20261103/.s.PGSQL.5432'
def deny(*a,**kw):raise AssertionError('Synthetic backend egress/process denied')
def connect(sock,address):
 if sock.family!=socket.AF_UNIX or str(address)!=SOCKET:return deny()
 return original(sock,address)
socket.socket.connect=connect;socket.socket.connect_ex=deny;socket.socket.sendto=deny;socket.create_connection=socket.getaddrinfo=deny;subprocess.Popen=deny
for n in ['system','fork','posix_spawn','posix_spawnp']:
 if hasattr(os,n):setattr(os,n,deny)
import asyncio
from datetime import datetime,timedelta
from fastapi import FastAPI,Depends,Request
from sqlalchemy.ext.asyncio import AsyncSession
from app.infrastructure.database.session import async_engine,get_async_db
from app.infrastructure.database.base import Base
import app.models
from app.domains.auth.models import User,UserRole,UserProfile,AuthSessionFamily,AuthRefreshIntent,ActivityLog
from app.domains.auth.router import router
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.session_store import SqlSessionFamilies
from app.domains.auth.session_lifecycle import SessionLifecycle
from app.domains.auth.session_startup import require_session_schema
from app.core.security import PasswordUtils,JWTUtils
from contextlib import asynccontextmanager
@asynccontextmanager
async def lifespan(app):
 async with async_engine.begin() as c:await c.run_sync(lambda conn:Base.metadata.create_all(conn,tables=[User.__table__,UserProfile.__table__,AuthSessionFamily.__table__,AuthRefreshIntent.__table__,ActivityLog.__table__]))
 async with app.state.sessions() as db:await require_session_schema(db)
 yield
 await async_engine.dispose()
from sqlalchemy.ext.asyncio import async_sessionmaker
app=FastAPI(lifespan=lifespan);app.state.sessions=async_sessionmaker(async_engine,expire_on_commit=False);app.include_router(router)
state={'mode':'normal','events':[]}
@app.middleware('http')
async def fault(request:Request,call_next):
 response=await call_next(request);path=request.url.path
 if not path.startswith('/__proof/control'):
  state['events'].append({'path':path,'status':response.status_code})
 if path=='/__proof/private' and request.headers.get('x-proof-lane')=='b' and state['mode']=='concurrent':await asyncio.sleep(.6)
 if response.status_code==200 and ((state['mode']=='lost_claim' and path=='/auth/refresh-intent')or(state['mode']=='lost_refresh' and path=='/auth/refresh')):await asyncio.sleep(4.2)
 if response.status_code==200 and state['mode']=='concurrent' and path=='/auth/refresh':await asyncio.sleep(.3)
 return response
@app.get('/health')
async def health():return {'ok':True}
@app.get('/__proof/private')
async def private(user=Depends(get_current_user)):return {'id':user.id}
@app.post('/__proof/control/issue')
async def issue(body:dict,db:AsyncSession=Depends(get_async_db)):
 uid=body.get('uid',42);assert uid in (42,43)
 user=await db.get(User,uid)
 if user is None:
  user=User(id=uid,email=f'proof{uid}@example.com',username=f'proof{uid}',role=UserRole.USER,is_active=True,is_verified=True,password_hash='synthetic');db.add(user);await db.flush()
 user.password_hash=PasswordUtils.hash_password('SyntheticSession42!')
 pair=await SessionLifecycle(SqlSessionFamilies(db)).issue(user);await db.commit();payload=JWTUtils.verify_refresh_token(pair['refresh_token'])
 if body.get('expired',True):pair['access_token']=JWTUtils.create_access_token(uid,user.email,'user',expires_delta=timedelta(seconds=-1),session_id=payload['sid'])
 from app.domains.auth.schemas import UserResponse
 return {'pair':pair,'user':UserResponse.model_validate(user).model_dump(mode='json'),'sid':payload['sid']}
@app.post('/__proof/control/mode')
async def mode(body:dict):state.update(mode=body['mode'],events=[]);return {'ok':True}
@app.get('/__proof/control/state')
async def inspect(db:AsyncSession=Depends(get_async_db)):
 from sqlalchemy import select
 rows=(await db.execute(select(AuthSessionFamily))).scalars().all()
 return {**state,'families':{r.id:{'active':r.is_active,'user_id':r.user_id} for r in rows},'pid':os.getpid()}
@app.post('/__proof/control/reset')
async def reset(db:AsyncSession=Depends(get_async_db)):
 u=await db.get(User,42);u.reset_password_token='synthetic-reset-fixture';u.reset_password_expires=datetime.utcnow()+timedelta(minutes=5);await db.commit();return {'token':u.reset_password_token}
if __name__=='__main__':
 import uvicorn
 uvicorn.run(app,host='127.0.0.1',port=24381,loop='asyncio',http='h11',access_log=False)
