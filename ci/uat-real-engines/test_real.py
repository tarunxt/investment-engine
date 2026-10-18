"""Real isolated PostgreSQL/Redis acceptance. Fixed Unix sockets only."""
import asyncio
import importlib.util
import json
import socket
import unittest
from pathlib import Path
import httpx
import jwt
import redis
from sqlalchemy import create_engine, select, func, inspect, update
from alembic.migration import MigrationContext
from alembic.operations import Operations
from offline_stack.fixtures import build_fixture
from offline_stack.profiles import Profile
from offline_stack.session_registry import KEY, CAPACITY
from offline_stack.barrier import SESSION_COOKIE
from app.uat.owner_policy import OWNER_EMAIL, AdmissionDenied

spec=importlib.util.spec_from_file_location('migration',Path(__file__).parent/'candidate/migrations/0001_synthetic_owner.py')
migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)

def engine():
    return create_engine('postgresql+psycopg2://postgres@/uat_ci_disposable?host=/pg',
        pool_size=1,max_overflow=0,pool_timeout=2,
        connect_args={'connect_timeout':2,'options':'-c statement_timeout=3000 -c lock_timeout=1000'})

class RealTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db=engine()
        with self.db.begin() as c:
            with Operations.context(MigrationContext.configure(c)):
                migration.upgrade()
        self.redis=redis.Redis(unix_socket_path='/redis/redis.sock',socket_timeout=2)
        assert self.redis.ping()
        assert not self.redis.keys('*'), 'isolated fixture must start empty'
        self.f=build_fixture(engine=self.db,client=self.redis)
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.f.app),base_url=self.f.origin)
    async def asyncTearDown(self):
        await self.client.aclose()
        self.redis.delete(KEY)
        with self.db.begin() as c:
            with Operations.context(MigrationContext.configure(c)):
                migration.downgrade()
            self.assertNotIn('uat_synthetic_profiles',inspect(c).get_table_names())
        self.f.close()
    def count(self):
        with self.db.connect() as c:return c.scalar(select(func.count()).select_from(Profile))
    async def login(self,email=OWNER_EMAIL,sub='synthetic-ci'):
        h={'origin':self.f.origin}
        challenge=await self.client.post('/auth/google/challenge',headers=h,json={})
        self.assertEqual(challenge.status_code,200)
        nonce=challenge.json()['nonce']
        token=jwt.encode(dict(iss='https://accounts.google.com',aud=self.f.policy.google_audience,
            sub=sub,email=email,email_verified=True,iat=self.f.now,exp=self.f.now+120,nonce=nonce),
            self.f.google_key,algorithm='RS256',headers={'kid':'synthetic'})
        return await self.client.post('/auth/google',headers=h,json={'credential':token,'nonce':nonce})
    async def test_owner_flow_and_revocation(self):
        self.assertEqual((await self.login('other@example.test')).status_code,401)
        self.assertEqual(self.count(),0);self.assertEqual(self.redis.hlen(KEY),0)
        export={'rows':[{'symbol':'SYNTHETIC-INDEX','quantity':1}]}
        self.assertEqual((await self.client.post('/simulation/exports',headers={'origin':self.f.origin},json=export)).status_code,401)
        self.assertEqual(self.count(),0);self.assertEqual(self.redis.hlen(KEY),0)
        login=await self.login();self.assertEqual(login.status_code,200)
        self.assertNotIn('access_token',login.text)
        self.assertEqual((await self.client.get('/')).status_code,200)
        order={'request_id':'ci','symbol':'SYNTHETIC-INDEX','side':'buy','quantity':1}
        a=await self.client.post('/simulation/orders',headers={'origin':self.f.origin},json=order)
        b=await self.client.post('/simulation/orders',headers={'origin':self.f.origin},json=order)
        self.assertEqual(a.status_code,200);self.assertEqual(a.json(),b.json())
        self.assertTrue(a.json()['simulation']);self.assertEqual(self.count(),1)
        exported=await self.client.post('/simulation/exports',headers={'origin':self.f.origin},json=export)
        self.assertEqual(exported.status_code,200)
        self.assertEqual(exported.json(),dict(simulation=True,delivered=False,destination='memory-sink-v1',row_count=1,sink_sequence=1))
        self.assertEqual((await self.client.post('/simulation/exports',headers={'origin':'https://evil.invalid'},json=export)).status_code,401)
        self.assertEqual((await self.client.post('/simulation/exports',headers={'origin':self.f.origin},json=dict(export,destination='https://example.invalid'))).status_code,422)
        self.assertEqual(self.count(),1)
        self.assertEqual(self.redis.hlen(KEY),1)
        token=self.client.cookies.get(SESSION_COOKIE)
        self.assertEqual((await self.client.post('/auth/logout',headers={'origin':self.f.origin})).status_code,200)
        self.client.cookies.set(SESSION_COOKIE,token)
        self.assertEqual((await self.client.get('/')).status_code,401)
        self.assertEqual(self.redis.hlen(KEY),0)
        self.assertEqual((await self.client.post('/simulation/exports',headers={'origin':self.f.origin},json=export)).status_code,401)
    async def test_assets_and_wrong_origin(self):
        assets=list((Path(__file__).parent/'candidate/frontend/out').rglob('*'))
        assets=[p for p in assets if p.is_file()]
        self.assertGreater(len(assets),5)
        for p in assets:
            path='/'+p.relative_to(Path(__file__).parent/'candidate/frontend/out').as_posix()
            self.assertEqual((await self.client.get(path)).status_code,401)
        self.assertEqual((await self.client.post('/auth/google/challenge',headers={'origin':'https://evil.invalid'},json={})).status_code,401)
        self.assertEqual(self.count(),0)
        await self.login()
        for p in assets:
            path='/'+p.relative_to(Path(__file__).parent/'candidate/frontend/out').as_posix()
            self.assertEqual((await self.client.get(path)).status_code,200)
    async def test_subject_and_disabled_owner(self):
        self.assertEqual((await self.login()).status_code,200)
        self.assertEqual((await self.login(sub='conflict')).status_code,401)
        with self.db.begin() as c:c.execute(update(Profile).values(is_active=False))
        self.assertEqual((await self.client.get('/')).status_code,401)
        self.assertEqual((await self.login()).status_code,401)
    async def test_concurrent_profile_and_registry_bounds(self):
        owners=await asyncio.gather(*(self.f.profiles.resolve('synthetic-ci',OWNER_EMAIL) for _ in range(8)))
        self.assertEqual(self.count(),1)
        results=await asyncio.gather(*(self.f.registry.issue(owners[0]) for _ in range(8)),return_exceptions=True)
        successes=[r for r in results if isinstance(r,dict)]
        self.assertGreater(len(successes),0)
        self.assertEqual(self.redis.hlen(KEY),len(successes))
        self.redis.delete(KEY)
        for i in range(CAPACITY):await self.f.registry.issue(owners[0])
        with self.assertRaises(AdmissionDenied):await self.f.registry.issue(owners[0])
        self.assertEqual(self.redis.hlen(KEY),CAPACITY)
        self.assertGreater(self.redis.ttl(KEY),0);self.assertLessEqual(self.redis.ttl(KEY),900)
    async def test_real_redis_expiry(self):
        await self.login()
        self.redis.pexpire(KEY,1)
        await asyncio.sleep(.05)
        self.assertEqual((await self.client.get('/')).status_code,401)
    async def test_no_network_interfaces_or_route(self):
        self.assertEqual([p.name for p in Path('/sys/class/net').iterdir()],['lo'])
        self.assertEqual(len(Path('/proc/net/route').read_text().splitlines()),1)
        self.assertEqual(self.db.dialect.name,'postgresql')
        self.assertTrue(self.redis.info('server')['redis_version'].startswith('7.4.'))

if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(RealTests))
    print(json.dumps({'real_postgresql':True,'real_redis':True,'tests':result.testsRun,
        'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped),
        'production_activation':False}))
    raise SystemExit(0 if result.wasSuccessful() and result.testsRun==6 and not result.skipped else 1)

