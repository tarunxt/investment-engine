"""Only the isolated, network-denied local harness installs these fake bindings."""
import os
if os.environ.get('STAGE01_PREVIEW')!='synthetic-only':raise RuntimeError('Synthetic preview only')
from datetime import datetime,timedelta,timezone
from cryptography.fernet import Fernet
from pydantic import SecretStr
from app.domains.connections.crypto import ConnectionKeyring
from app.domains.connections.material import PlatformCredentialService,AppMaterial
from app.domains.connections.models import IntegrationConnection,ConnectionCredential
from app.domains.connections.service import ConnectionStore
TABLES=(IntegrationConnection.__table__,ConnectionCredential.__table__)
# Deterministic disposable local fixture keys, never deployment configuration.
ring=ConnectionKeyring({1:'c3ludGhldGljLXN0YWdlMDkta2V5LW9ubHktMDAwMDA=',2:'c3ludGhldGljLXN0YWdlMDkta2V5LW9ubHktMTExMTE='})
platform=PlatformCredentialService({('synthetic-approved-platform',1):AppMaterial(SecretStr('synthetic-shared-key'),SecretStr('synthetic-shared-secret'),'synthetic-approved-platform',1)},approved=True,approval_reference='LOCAL-FAKE-APPROVAL-NOT-PROVIDER-EVIDENCE')
ConnectionKeyring.from_settings=classmethod(lambda cls:ring)
PlatformCredentialService.from_settings=classmethod(lambda cls:platform)
async def seed(db,users):
    store=ConnectionStore(db,keyring=ring,platform=platform)
    for user in users:
        if await store.current(user.id):continue
        if user.username=='admin':await store.provision(user.id,mode='platform_managed',platform_ref='synthetic-pending-provider');continue
        row=await store.provision(user.id,mode='platform_managed',platform_ref='synthetic-approved-platform') if user.username=='userb' else await store.provision(user.id,mode='user_owned',app_key='synthetic-key-'+user.username,app_secret='synthetic-secret-'+user.username)
        _,app=await store.prepare_app(user.id,row.id)
        await store.install_session(user.id,row.id,1,app=app,provider_account_id='FAKE'+user.username.upper(),token='synthetic-token-'+user.username,expires_at=datetime.now(timezone.utc)+timedelta(days=1))
