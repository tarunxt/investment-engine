"""Synthetic in-memory wiring only. No sockets, ports or persistent credentials."""
from pathlib import Path
import json
import time
from dataclasses import dataclass
import fakeredis
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm
from app.uat.owner_policy import OwnerPolicy,OWNER_EMAIL
from app.uat.google_login import GoogleVerifier,GoogleLogin,LoginChallenges
from app.uat.sessions import OwnerSessions
from offline_jwks import OfflineGoogleKeys
from .profiles import Base,Profiles
from .session_registry import Registry
from .application import assemble

# Public disposable fixture, never valid for a deployed system.
FIXTURE_SIGNING_KEY=b'PUBLIC-DISPOSABLE-OFFLINE-UAT-FIXTURE-ONLY-0000'


@dataclass
class Fixture:
    app: object
    engine: object
    redis: object
    profiles: object
    registry: object
    google_key: object
    policy: object
    now: int
    origin: str='https://uat.example.test'

    def close(self):
        self.redis.close()
        self.engine.dispose()


def build_fixture(*, engine=None, client=None):
    now=int(time.time())
    if engine is None:
        engine=create_engine('sqlite://',poolclass=StaticPool,connect_args={'check_same_thread':False})
        Base.metadata.create_all(engine)
    profiles=Profiles(engine)
    if client is None:
        client=fakeredis.FakeRedis(server=fakeredis.FakeServer())
    registry=Registry(client,signing_key=FIXTURE_SIGNING_KEY)
    policy=OwnerPolicy('uat',OWNER_EMAIL,'synthetic.apps.googleusercontent.com')
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    jwk=json.loads(RSAAlgorithm.to_jwk(key.public_key()));jwk.pop('key_ops',None)
    jwk.update(kid='synthetic',alg='RS256',use='sig')
    cache=OfflineGoogleKeys(clock=lambda:now)
    cache.replace(json.dumps(dict(fetched_at=now-1,expires_at=now+300,keys=[jwk])).encode())
    verifier=GoogleVerifier(policy,cache.snapshot)
    login=GoogleLogin(origin='https://uat.example.test',policy=policy,verifier=verifier,
        challenges=LoginChallenges(),resolve=profiles.resolve,issue=registry.issue)
    sessions=OwnerSessions(policy,verifier,profiles.resolve,registry.verify,profiles.load,registry.issue)
    app=assemble(sessions=sessions,google_login=login,registry=registry,frontend_directory=Path(__file__).parents[1]/'frontend/out')
    return Fixture(app,engine,client,profiles,registry,key,policy,now)
