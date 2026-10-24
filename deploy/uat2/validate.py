#!/usr/bin/env python3
"""Validate local deployment configuration without emitting secret values."""
import os
import re
import stat
import sys
from pathlib import Path
from urllib.parse import urlsplit


PRODUCTION_GOOGLE_CLIENT_ID = "833980592098-0vt4iu94cqokkv1nmp6oqh6evdgmg5sj.apps.googleusercontent.com"

def read_env(path, private=True):
    if path.is_symlink():
        raise ValueError(f"Symlinked configuration rejected: {path.name}")
    if private and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError(f'{path.name} must be owner-readable only (0600)')
    result = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise ValueError(f'Invalid entry in {path.name}')
        if key in result or '{{resolve:' in value or value.startswith('REQUIRED_'):
            raise ValueError(f'Unresolved or duplicate entry in {path.name}')
        result[key] = value
    return result


def validate(root):
    images = read_env(root / '.env')
    if not re.fullmatch(r'[0-9a-f]{40}', images.get('UAT2_SOURCE_COMMIT', '')):
        raise ValueError('Full source commit required')
    for key in ['FRONTEND', 'BACKEND', 'PROXY', 'CERTS', 'POSTGRES', 'REDIS']:
        if not re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[0-9a-f]{64}', images.get(f'UAT2_{key}_IMAGE', '')):
            raise ValueError(f'Immutable {key} image digest required')
    backend = read_env(root / 'backend.env')
    frontend = read_env(root / 'frontend.env')
    database = read_env(root / 'database.env')
    barrier = read_env(root / 'barrier.env')
    if backend.get('CREDX_UAT2') != '1' or frontend.get('CREDX_UAT2') != '1':
        raise ValueError('UAT2 mode required')
    if backend.get('UAT2_ADAPTERS') != 'simulation' or backend.get('AUTH_DISABLED') != 'false' or backend.get('ENVIRONMENT') != 'uat2':
        raise ValueError('Simulation and authenticated uat2 environment required')
    db = urlsplit(backend.get('DATABASE_URL', ''))
    redis = urlsplit(backend.get('REDIS_URL', ''))
    if db.hostname != 'postgres' or db.username != 'credx_uat2' or db.path != '/credx_uat2' or not db.password:
        raise ValueError('Dedicated UAT2 database required')
    if redis.hostname != 'redis' or redis.path != '/0':
        raise ValueError('Dedicated Redis required')
    if database.get('POSTGRES_USER') != 'credx_uat2' or database.get('POSTGRES_DB') != 'credx_uat2' or not database.get('POSTGRES_PASSWORD'):
        raise ValueError('Dedicated PostgreSQL configuration required')
    if db.password != database['POSTGRES_PASSWORD']:
        raise ValueError('Database configuration does not match')
    jwt = backend.get('UAT2_JWT_SIGNING_KEY', '')
    auth = frontend.get('NEXTAUTH_SECRET', '')
    if len(jwt) < 32 or len(auth) < 32 or jwt == auth:
        raise ValueError('Distinct independent signing configuration required')
    if not backend.get('GOOGLE_SIGNIN_CLIENT_ID') or backend['GOOGLE_SIGNIN_CLIENT_ID'] == PRODUCTION_GOOGLE_CLIENT_ID:
        raise ValueError('Independent Google client required')
    if frontend.get('NEXTAUTH_URL') != 'https://uat2.cred-x.in' or frontend.get('BACKEND_API_URL') != 'http://backend:8000':
        raise ValueError('UAT2 frontend origins required')
    if frontend.get('NEXT_PUBLIC_DISABLE_AUTH') != 'false':
        raise ValueError('Frontend authentication must remain enabled')
    if not barrier.get('UAT2_BARRIER_USER') or not barrier.get('UAT2_BARRIER_HASH', '').startswith('$2'):
        raise ValueError('Independent access barrier configuration required')
    allowed = {'DATABASE_URL', 'REDIS_URL', 'CREDX_UAT2', 'ENVIRONMENT', 'AUTH_DISABLED',
               'UAT2_ADAPTERS', 'UAT2_JWT_SIGNING_KEY', 'GOOGLE_SIGNIN_CLIENT_ID',
               'UAT2_FIXTURE_STATE', 'FRONTEND_URL'}
    if set(backend) - allowed:
        raise ValueError('Unexpected backend configuration; reject real adapters/credentials')
    return images


if __name__ == '__main__':
    try:
        validate(Path(sys.argv[1] if len(sys.argv) > 1 else '.'))
    except (ValueError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    print('UAT2 configuration validated (values withheld)')
