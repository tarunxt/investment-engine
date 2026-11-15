#!/usr/bin/env python3
"""Actual auth ORM/lifecycle against ONLY the dedicated disposable Unix socket.

No application config, production DB, Redis, provider, email or process access.
Creates synthetic fixture tables; this is NOT full Alembic graph acceptance.
"""
import socket, subprocess, os, sys, types
SOCKET_DIR = '/tmp/a9-session-pg-socket-20261103'
original_connect = socket.socket.connect
def blocked(*args, **kwargs): raise AssertionError('Session acceptance egress blocked')
def local_connect(sock, address):
    if sock.family != socket.AF_UNIX or str(address) != SOCKET_DIR+'/.s.PGSQL.5432': return blocked()
    return original_connect(sock,address)
socket.socket.connect = local_connect
socket.socket.connect_ex = blocked
socket.socket.sendto = blocked
socket.create_connection = socket.getaddrinfo = blocked
subprocess.Popen = blocked
for name in ['system','fork','posix_spawn','posix_spawnp']:
    if hasattr(os,name):setattr(os,name,blocked)

from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from pydantic import SecretStr
config=types.ModuleType('app.core.config')
config.settings=types.SimpleNamespace(jwt_signing_key=SecretStr('synthetic-disposable-session-signing-material-'*3))
sys.modules['app.core.config']=config
import asyncio, unittest, json, time
from sqlalchemy import ForeignKey, Integer, select
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.infrastructure.database.base import Base
from app.domains.auth.models import User, UserRole, AuthSessionFamily, AuthRefreshIntent
from app.domains.auth.session_lifecycle import SessionLifecycle, digest
from app.domains.auth.session_store import SqlSessionFamilies
from app.domains.auth.refresh_intent import RefreshIntents
from app.domains.auth.session_startup import require_session_schema
from app.core.security import JWTUtils, AuthUtils
from fastapi import HTTPException

# Only unrelated relationship targets are doubled; auth rows/store/JWT are real.
class Job(Base):
    __tablename__='jobs'
    id:Mapped[int]=mapped_column(primary_key=True)
    user_id:Mapped[int]=mapped_column(ForeignKey('users.id'))
    user:Mapped[User]=relationship(back_populates='jobs')
class Prompt(Base):
    __tablename__='prompts'
    id:Mapped[int]=mapped_column(primary_key=True)
    user_id:Mapped[int]=mapped_column(ForeignKey('users.id'))
    user:Mapped[User]=relationship(back_populates='prompts')

URL='postgresql+asyncpg://postgres@/a9_synthetic?host='+SOCKET_DIR
counter=0
class Proof(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        global counter
        counter+=1;self.uid=counter*10
        self.engine=create_async_engine(URL,pool_size=8,max_overflow=0)
        self.sessions=async_sessionmaker(self.engine,expire_on_commit=False)
        async with self.engine.begin()as db:await db.run_sync(Base.metadata.create_all)
        async with self.sessions()as db:
            for uid in [self.uid,self.uid+1]:
                existing = await db.get(User,uid)
                if existing is not None:
                    existing.is_active = True
                    existing.password_hash = 'synthetic-not-a-real-password'
                else:
                    db.add(User(id=uid,email=f'fixture{uid}@example.invalid',username=f'fixture{uid}',password_hash='synthetic-not-a-real-password',role=UserRole.USER,is_active=True,is_verified=True))
            await db.commit()
    async def asyncTearDown(self):await self.engine.dispose()
    async def issue(self,uid=None):
        async with self.sessions()as db:
            user=await db.get(User,uid or self.uid)
            pair=await SessionLifecycle(SqlSessionFamilies(db)).issue(user);await db.commit();return pair
    async def active(self,pair):
        async with self.sessions()as db:
            return await SessionLifecycle(SqlSessionFamilies(db)).require_active(JWTUtils.verify_access_token(pair['access_token']))
    async def rotate(self,pair,nonce=None):
        async with self.sessions()as db:
            _,result=await SessionLifecycle(SqlSessionFamilies(db)).rotate(pair['refresh_token'],nonce);await db.commit();return result
    async def claim(self,pair):
        async with self.sessions()as db:
            nonce=await RefreshIntents(SqlSessionFamilies(db)).claim(pair['refresh_token']);await db.commit();return nonce
    async def test_current_logout_isolation(self):
        a,b,c=await self.issue(),await self.issue(),await self.issue(self.uid+1)
        async with self.sessions()as db:
            await SessionLifecycle(SqlSessionFamilies(db)).revoke_current(JWTUtils.verify_access_token(a['access_token']));await db.commit()
        with self.assertRaises(HTTPException):await self.active(a)
        await self.active(b);await self.active(c)
    async def test_direct_refresh_reuse_commits_revocation(self):
        a,b=await self.issue(),await self.issue();new=await self.rotate(a)
        with self.assertRaises(HTTPException):await self.rotate(a)
        with self.assertRaises(HTTPException):await self.active(new)
        await self.active(b)
    async def test_real_connections_concurrent_refresh_strict_policy(self):
        a=await self.issue()
        results=await asyncio.gather(self.rotate(a),self.rotate(a),return_exceptions=True)
        self.assertEqual(sum(isinstance(r,dict)for r in results),1)
        self.assertEqual(sum(isinstance(r,HTTPException)and r.status_code==401 for r in results),1)
        with self.assertRaises(HTTPException):await self.active(next(r for r in results if isinstance(r,dict)))
    async def test_independent_bff_claims_exactly_one_dispatch_authorization(self):
        a,b=await self.issue(),await self.issue()
        results=await asyncio.gather(*(self.claim(a)for _ in range(6)),return_exceptions=True)
        nonces=[r for r in results if isinstance(r,str)]
        self.assertEqual(len(nonces),1)
        self.assertEqual(sum(isinstance(r,HTTPException)and r.status_code==409 for r in results),5)
        rotated=await self.rotate(a,nonces[0])
        # A delayed old cookie may query intent but can never recover/replay.
        with self.assertRaises(HTTPException)as error:await self.claim(a)
        self.assertEqual(error.exception.status_code,409)
        await self.active(rotated);await self.active(b)
    async def test_lost_claim_never_allows_takeover(self):
        a=await self.issue();await self.claim(a)
        with self.assertRaises(HTTPException)as error:await self.claim(a)
        self.assertEqual(error.exception.status_code,409)
        with self.assertRaises(HTTPException):await self.rotate(a)
        # Losing a nonce does not authorize another dispatch or invent logout.
        await self.active(a)
    async def test_commit_ack_loss_retains_intent_and_prohibits_nonce_omission(self):
        a=await self.issue();nonce=await self.claim(a)
        class LostAcknowledgement(SqlSessionFamilies):
            async def commit(self):
                await super().commit()
                raise RuntimeError('synthetic lost database commit acknowledgement')
        async with self.sessions()as db:
            with self.assertRaises(RuntimeError):await SessionLifecycle(LostAcknowledgement(db)).rotate(a['refresh_token'],nonce)
        with self.assertRaises(HTTPException):await self.rotate(a,nonce)
        with self.assertRaises(HTTPException):await self.rotate(a)
        with self.assertRaises(HTTPException):await self.claim(a)
        await self.active(a)
    async def test_password_wins_between_intent_commit_and_rotation_lock(self):
        a=await self.issue();nonce=await self.claim(a)
        started,release=asyncio.Event(),asyncio.Event()
        class PausedCommit(SqlSessionFamilies):
            async def commit(self):
                await super().commit();started.set();await release.wait()
        async def rotation():
            async with self.sessions()as db:return await SessionLifecycle(PausedCommit(db)).rotate(a['refresh_token'],nonce)
        task=asyncio.create_task(rotation());await started.wait()
        async with self.sessions()as db:
            await SessionLifecycle(SqlSessionFamilies(db)).revoke_all(self.uid);await db.commit()
        release.set()
        with self.assertRaises(HTTPException):await task
        with self.assertRaises(HTTPException):await self.active(a)

    async def test_actual_fastapi_intent_refresh_logout_paths(self):
        import ast, httpx
        from fastapi import FastAPI, Depends
        from sqlalchemy.ext.asyncio import AsyncSession
        from app.domains.auth.schemas import RefreshTokenRequest,LoginResponse,UserResponse
        from app.domains.auth.models import ActivityLog
        root=Path(__file__).resolve().parents[1]
        tree=ast.parse((root/'app/domains/auth/router.py').read_text())
        nodes=[n for n in tree.body if isinstance(n,ast.AsyncFunctionDef)and n.name in {'refresh_token','claim_refresh_intent','logout_refresh'}]
        for n in nodes:n.decorator_list=[]
        async def db_dependency():
            async with self.sessions()as db:yield db
        scope=dict(RefreshTokenRequest=RefreshTokenRequest,LoginResponse=LoginResponse,UserResponse=UserResponse,
            AsyncSession=AsyncSession,Depends=Depends,get_async_db=db_dependency,SessionLifecycle=SessionLifecycle,
            SqlSessionFamilies=SqlSessionFamilies,JWTUtils=JWTUtils,HTTPException=HTTPException,ActivityLog=ActivityLog,
            subject=__import__('app.domains.auth.session_lifecycle',fromlist=['subject']).subject)
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'actual-auth-http-paths','exec'),scope)
        app=FastAPI()
        for path,name in [('refresh','refresh_token'),('refresh-intent','claim_refresh_intent'),('logout-refresh','logout_refresh')]:app.post('/auth/'+path)(scope[name])
        pair,other=await self.issue(),await self.issue()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://synthetic.invalid')as client:
            wrong=await client.post('/auth/refresh-intent',json={'refresh_token':pair['access_token']});self.assertEqual(wrong.status_code,401)
            claim=await client.post('/auth/refresh-intent',json={'refresh_token':pair['refresh_token']});self.assertEqual(claim.status_code,200)
            result=await client.post('/auth/refresh',json={'refresh_token':pair['refresh_token'],'intent_nonce':claim.json()['intent_nonce']});self.assertEqual(result.status_code,200)
            rotated=result.json()
            duplicate=await client.post('/auth/refresh-intent',json={'refresh_token':pair['refresh_token']});self.assertEqual(duplicate.status_code,409)
            ack=await client.post('/auth/logout-refresh',json={'refresh_token':rotated['refresh_token']});self.assertEqual(ack.status_code,200)
            self.assertEqual(ack.json()['session_revocation'],'confirmed')
        with self.assertRaises(HTTPException):await self.active(rotated)
        await self.active(other)
    async def test_actual_api_dependency_preserves_inactive_403_and_enforces_family(self):
        import ast
        from fastapi import Depends, status
        from fastapi.security import HTTPAuthorizationCredentials,HTTPBearer
        from sqlalchemy.ext.asyncio import AsyncSession
        from sqlalchemy.orm import selectinload
        from time import monotonic
        lifecycle=__import__('app.domains.auth.session_lifecycle',fromlist=['subject'])
        tree=ast.parse((Path(__file__).resolve().parents[1]/'app/domains/auth/dependencies.py').read_text())
        node=next(n for n in tree.body if isinstance(n,ast.AsyncFunctionDef)and n.name=='get_current_user')
        async def unused():raise AssertionError('explicit test session required')
        scope=dict(Depends=Depends,HTTPException=HTTPException,HTTPAuthorizationCredentials=HTTPAuthorizationCredentials,
            AsyncSession=AsyncSession,security=HTTPBearer(auto_error=False),get_async_db=unused,User=User,select=select,
            selectinload=selectinload,monotonic=monotonic,add_auth_duration=lambda *a:None,JWTUtils=JWTUtils,
            subject=lifecycle.subject,SessionLifecycle=SessionLifecycle,SqlSessionFamilies=SqlSessionFamilies,
            is_auth_disabled=lambda:False,status=status)
        exec(compile(ast.Module(body=[node],type_ignores=[]),'actual-api-dependency','exec'),scope)
        pair=await self.issue();credentials=HTTPAuthorizationCredentials(scheme='Bearer',credentials=pair['access_token'])
        async with self.sessions()as db:
            user=await scope['get_current_user'](credentials,db);self.assertEqual(user.id,self.uid)
        async with self.sessions()as db:
            user=await db.get(User,self.uid);user.is_active=False;await db.commit()
        async with self.sessions()as db:
            with self.assertRaises(HTTPException)as denied:await scope['get_current_user'](credentials,db)
            self.assertEqual(denied.exception.status_code,403)
    async def test_started_intent_survives_rotation_rollback(self):
        a=await self.issue();nonce=await self.claim(a)
        async with self.sessions()as db:
            store=SqlSessionFamilies(db);uid=self.uid;sid=JWTUtils.verify_refresh_token(a['refresh_token'])['sid']
            await store.lock_user(uid);await store.lock_family(uid,sid)
            await RefreshIntents(store).begin(a['refresh_token'],nonce,uid,sid)
            await db.rollback()
        with self.assertRaises(HTTPException):await self.rotate(a,nonce)
        with self.assertRaises(HTTPException):await self.claim(a)
    async def test_password_transaction_rollback_and_account_isolation(self):
        a,b,c=await self.issue(),await self.issue(),await self.issue(self.uid+1)
        async with self.sessions()as db:
            store=SqlSessionFamilies(db);u=await store.lock_user(self.uid);u.password_hash='synthetic-new-hash'
            await SessionLifecycle(store).revoke_all(self.uid);await db.rollback()
        await self.active(a);await self.active(b)
        async with self.sessions()as db:
            store=SqlSessionFamilies(db);u=await store.lock_user(self.uid);u.password_hash='synthetic-new-hash'
            await SessionLifecycle(store).revoke_all(self.uid);await db.commit()
        for pair in [a,b]:
            with self.assertRaises(HTTPException):await self.active(pair)
        await self.active(c)
    async def test_password_or_logout_races_do_not_resurrect(self):
        for event in ['password','logout']:
            pair=await self.issue();nonce=await self.claim(pair)
            async def revoke():
                async with self.sessions()as db:
                    lifecycle=SessionLifecycle(SqlSessionFamilies(db))
                    if event=='password':await lifecycle.revoke_all(self.uid)
                    else:await lifecycle.revoke_current(JWTUtils.verify_access_token(pair['access_token']))
                    await db.commit()
            results=await asyncio.gather(self.rotate(pair,nonce),revoke(),return_exceptions=True)
            with self.assertRaises(HTTPException):await self.active(pair)
            for r in results:
                if isinstance(r,dict):
                    with self.assertRaises(HTTPException):await self.active(r)
    async def test_legacy_shape_crypto_compatibility_but_cutover_requires_login(self):
        old=AuthUtils.create_tokens(self.uid,'fixture@example.invalid','user')
        self.assertIsNotNone(JWTUtils.verify_access_token(old['access_token']))
        with self.assertRaises(HTTPException):await self.active(old)
        with self.assertRaises(HTTPException):await self.rotate(old)
        a=await self.issue();await self.active(a)
    async def test_schema_readiness_missing_table_fails_closed(self):
        async with self.engine.begin()as db:
            await db.run_sync(lambda connection:AuthRefreshIntent.__table__.drop(connection))
        try:
            async with self.sessions()as db:
                with self.assertRaises(Exception):await require_session_schema(db)
        finally:
            async with self.engine.begin()as db:await db.run_sync(lambda connection:AuthRefreshIntent.__table__.create(connection))
        async with self.sessions()as db:await require_session_schema(db)

async def cross_process(mode, fixture_path, outputs):
    engine=create_async_engine(URL)
    sessions=async_sessionmaker(engine,expire_on_commit=False)
    try:
        if mode=='--race-setup':
            uid=900000+int(time.time())
            async with sessions()as db:
                user=User(id=uid,email=f'process{uid}@example.invalid',username=f'process{uid}',password_hash='synthetic',role=UserRole.USER,is_active=True,is_verified=True)
                db.add(user);await db.flush()
                pair=await SessionLifecycle(SqlSessionFamilies(db)).issue(user);await db.commit()
            Path(fixture_path).write_text(json.dumps({'pair':pair,'start_at':time.time()+2}))
        elif mode=='--race-worker':
            fixture=json.loads(Path(fixture_path).read_text())
            await asyncio.sleep(max(0,fixture['start_at']-time.time()))
            async with sessions()as db:
                try:
                    await RefreshIntents(SqlSessionFamilies(db)).claim(fixture['pair']['refresh_token']);await db.commit();status=200
                except HTTPException as error:status=error.status_code
            Path(outputs[0]).write_text(json.dumps({'status':status}))
        elif mode=='--race-check':
            statuses=[json.loads(Path(p).read_text())['status']for p in outputs]
            assert sorted(statuses)==[200,409,409],statuses
            pair=json.loads(Path(fixture_path).read_text())['pair']
            async with sessions()as db:
                await SessionLifecycle(SqlSessionFamilies(db)).require_active(JWTUtils.verify_access_token(pair['access_token']))
            print('PASS: three actual OS processes, one committed refresh intent and two conflicts; family remains active')
    finally:await engine.dispose()

if __name__=='__main__':
    if len(sys.argv)>2 and sys.argv[1].startswith('--race-'):asyncio.run(cross_process(sys.argv[1],sys.argv[2],sys.argv[3:]))
    else:unittest.main(verbosity=2)
