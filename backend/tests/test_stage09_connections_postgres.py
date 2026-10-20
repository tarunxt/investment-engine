"""Named disposable backend Docker PostgreSQL migration and binding races."""
import asyncio,os,subprocess,sys,json
from datetime import datetime,timedelta,timezone
from pathlib import Path
from uuid import uuid4
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine,select,inspect
from sqlalchemy.orm import Session
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from sqlalchemy.pool import NullPool
from sqlalchemy.schema import CreateSchema,DropSchema
from app.domains.connections.crypto import ConnectionKeyring,ConnectionFault
from app.domains.connections.material import PlatformCredentialService
from app.domains.connections.service import ConnectionStore
URL='postgresql+psycopg2://stage09:stage09@postgres:5432/credx_stage09_test'
pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',reason='Named Stage09 backend Docker fixture only')

@pytest.fixture
def database():
    assert Path('/.dockerenv').is_file() and os.environ['DATABASE_URL']==URL
    assert not Path('.env').exists() and not Path('backend/.env').exists()
    import app.models
    from app.infrastructure.database.base import Base
    from app.domains.auth.models import User,UserProfile
    root=create_engine(URL,poolclass=NullPool);schema='stage09_'+uuid4().hex
    with root.begin() as c:c.execute(CreateSchema(schema))
    engine=create_engine(URL,connect_args={'options':f'-csearch_path={schema} -c statement_timeout=5000 -c lock_timeout=3000'},poolclass=NullPool)
    Base.metadata.create_all(engine)
    ae=create_async_engine(URL.replace('+psycopg2','+asyncpg'),poolclass=NullPool,connect_args={'server_settings':{'search_path':schema,'statement_timeout':'5000','lock_timeout':'3000'}})
    factory=async_sessionmaker(ae,expire_on_commit=False)
    with Session(engine) as s:
        u=User(email='owner@stage09.example.invalid',username='synthetic_owner',password_hash='unusable',is_active=True,is_verified=True,profile=UserProfile());s.add(u);s.commit();owner=u.id
    ring=ConnectionKeyring({1:Fernet.generate_key().decode(),2:Fernet.generate_key().decode()})
    try:yield engine,factory,owner,schema,ring
    finally:
        engine.dispose()
        with root.begin() as c:c.execute(DropSchema(schema,cascade=True))
        root.dispose()

async def provision(factory,owner,ring):
    async with factory() as db:return await ConnectionStore(db,keyring=ring,platform=PlatformCredentialService()).provision(owner,mode='user_owned',app_key='fake-key',app_secret='fake-secret')

@pytest.mark.asyncio
async def test_two_writers_one_current_connection(database):
    _,factory,owner,_,ring=database
    result=await asyncio.gather(provision(factory,owner,ring),provision(factory,owner,ring),return_exceptions=True)
    assert sum(not isinstance(x,Exception) for x in result)==1
    errors=[x for x in result if isinstance(x,Exception)];assert len(errors)==1 and isinstance(errors[0],ConnectionFault) and errors[0].code=='ONE_CURRENT_ACCOUNT_PER_PROVIDER'

@pytest.mark.asyncio
async def test_rotation_cas_one_winner_preserves_bound_token(database):
    _,factory,owner,_,ring=database;row=await provision(factory,owner,ring)
    async with factory() as db:
        store=ConnectionStore(db,keyring=ring);_,app=await store.prepare_app(owner,row.id)
        await store.install_session(owner,row.id,1,app=app,provider_account_id='FAKEACCOUNT',token='fake-token',expires_at=datetime.now(timezone.utc)+timedelta(hours=1))
    async def rotate():
        async with factory() as db:return await ConnectionStore(db,keyring=ring).rotate(owner,row.id,2,2)
    results=await asyncio.gather(rotate(),rotate(),return_exceptions=True)
    assert sum(not isinstance(x,Exception) for x in results)==1
    assert [x.code for x in results if isinstance(x,ConnectionFault)]==['CONNECTION_VERSION_CHANGED']
    async with factory() as db:
        store=ConnectionStore(db,keyring=ring);token=await store.resolve_token(owner);assert token.version==3 and token.token.get_secret_value()=='fake-token'

@pytest.mark.asyncio
async def test_disable_and_rotation_serialize_without_resurrecting_token(database):
    _,factory,owner,_,ring=database;row=await provision(factory,owner,ring)
    async with factory() as db:
        store=ConnectionStore(db,keyring=ring);_,app=await store.prepare_app(owner,row.id);await store.install_session(owner,row.id,1,app=app,provider_account_id='FAKE',token='fake-token',expires_at=datetime.now(timezone.utc)+timedelta(hours=1))
    async def disable():
        async with factory() as db:await ConnectionStore(db,keyring=ring).disable(owner)
    async def rotate():
        async with factory() as db:return await ConnectionStore(db,keyring=ring).rotate(owner,row.id,2,2)
    await asyncio.gather(disable(),rotate(),return_exceptions=True)
    async with factory() as db:
        store=ConnectionStore(db,keyring=ring);current=await store.current(owner);assert current.status=='disabled'
        with pytest.raises(ConnectionFault,match='CONNECTION_NOT_ACTIVE'):await store.resolve_token(owner)
        assert (await store.material(current))[1]['token'] is None

def test_actual_additive_migration_roundtrip_preserves_legacy_ciphertext(database):
    engine,_,_,schema,_=database
    from app.infrastructure.database.base import Base
    from app.domains.auth.models import User,UserProfile
    from app.domains.zerodha.models import ZerodhaCredential
    Base.metadata.drop_all(engine)
    env={**os.environ,'PGOPTIONS':f'-csearch_path={schema}'};backend=Path(__file__).resolve().parents[1]
    def migrate(direction,target):subprocess.run([sys.executable,'-m','alembic',direction,target],cwd=backend,env=env,check=True,capture_output=True,text=True,timeout=90)
    migrate('upgrade','module_lifecycle_001')
    # Cipher is opaque fixture bytes: migration must not attempt to decrypt it.
    cipher='opaque-fake-legacy-ciphertext-preserve-byte-for-byte'
    with Session(engine) as s:
        u=User(email='legacy@stage09.example.invalid',username='legacy',password_hash='unusable',is_active=True,is_verified=True,profile=UserProfile());s.add(u);s.flush();owner=u.id
        legacy=ZerodhaCredential(user_id=owner,access_token=cipher,login_time=datetime.now(timezone.utc),expires_at=datetime.now(timezone.utc)+timedelta(hours=1));s.add(legacy);s.commit();legacy_id=legacy.id
    sys.path.insert(0,str(backend/'scripts'));from verify_api_attempt_migration import baseline_snapshot
    before=baseline_snapshot(engine,exclude_tables=frozenset())
    migrate('upgrade','head')
    after=baseline_snapshot(engine,exclude_tables=frozenset({'integration_connections','connection_credentials'}))
    assert before==after
    from app.domains.connections.models import IntegrationConnection,ConnectionCredential
    for iteration in range(2):
        with Session(engine) as s:
            row=s.execute(select(IntegrationConnection)).scalar_one();assert row.owner_id==owner and row.version==1 and row.status=='legacy_review' and row.provider_account_id is None
            assert row.credential_ref==f'legacy:zerodha:{legacy_id}' and s.get(ZerodhaCredential,legacy_id).access_token==cipher
            assert not s.execute(select(ConnectionCredential)).first()
        migrate('downgrade','module_lifecycle_001')
        assert baseline_snapshot(engine,exclude_tables=frozenset())==before
        assert 'integration_connections' not in inspect(engine).get_table_names()
        migrate('upgrade','head')
