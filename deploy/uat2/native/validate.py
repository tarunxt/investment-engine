#!/usr/bin/env python3
"""Native UAT2 config validation. Does not print values or resolve secrets."""
import importlib.util
from pathlib import Path
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location('uat2_shared_validation', Path(__file__).resolve().parents[1]/'validate.py')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
read_env = shared.read_env


def validate(directory):
    backend = read_env(directory/'backend.env')
    web = read_env(directory/'frontend.env')
    barrier = read_env(directory/'barrier.env')
    expected = {'CREDX_UAT2':'1','ENVIRONMENT':'uat2','AUTH_DISABLED':'false',
                'UAT2_RUNTIME':'native','UAT2_ADAPTERS':'simulation'}
    if any(backend.get(key) != value for key,value in expected.items()):
        raise ValueError('Authenticated native UAT2 simulation required')
    allowed = set(expected) | {'DATABASE_URL','REDIS_URL','GOOGLE_SIGNIN_CLIENT_ID',
                               'UAT2_JWT_SIGNING_KEY','UAT2_FIXTURE_STATE','FRONTEND_URL'}
    if set(backend)-allowed:
        raise ValueError('Unexpected backend settings; real integration configuration rejected')
    db, cache = urlsplit(backend.get('DATABASE_URL','')), urlsplit(backend.get('REDIS_URL',''))
    if db.hostname != '127.0.0.1' or db.port != 5542 or db.path != '/credx_uat2' or db.username != 'credx_uat2' or not db.password:
        raise ValueError('Dedicated native PostgreSQL required')
    if cache.hostname != '127.0.0.1' or cache.port != 6479 or cache.path != '/0':
        raise ValueError('Dedicated native Redis required')
    allowed_web={'CREDX_UAT2','BACKEND_API_URL','NEXTAUTH_URL','NEXT_PUBLIC_DISABLE_AUTH','NEXTAUTH_SECRET','AUTH_TRUST_HOST'}
    if set(web)-allowed_web or set(barrier)-{'UAT2_BARRIER_USER','UAT2_BARRIER_HASH'}:
        raise ValueError('Unexpected frontend/barrier configuration rejected')
    if web.get('CREDX_UAT2') != '1' or web.get('BACKEND_API_URL') != 'http://127.0.0.1:8002' or web.get('NEXTAUTH_URL') != 'https://uat2.cred-x.in' or web.get('NEXT_PUBLIC_DISABLE_AUTH') != 'false':
        raise ValueError('Native frontend origin/authentication required')
    jwt, auth = backend.get('UAT2_JWT_SIGNING_KEY',''), web.get('NEXTAUTH_SECRET','')
    if len(jwt)<32 or len(auth)<32 or jwt==auth:
        raise ValueError('Distinct UAT2 signing configuration required')
    client = backend.get('GOOGLE_SIGNIN_CLIENT_ID','')
    if not client or client == shared.PRODUCTION_GOOGLE_CLIENT_ID:
        raise ValueError('Independent UAT2 Google client required')
    if not barrier.get('UAT2_BARRIER_USER') or not barrier.get('UAT2_BARRIER_HASH','').startswith('$2'):
        raise ValueError('Independent access barrier required')
    return backend, web, barrier
