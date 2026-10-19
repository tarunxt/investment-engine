"""Default-off UAT2 identity and fail-closed runtime configuration."""
import os
import re
from urllib.parse import urlsplit
from fastapi import HTTPException

OWNER_EMAIL = 'tarun.singh6893@gmail.com'


def uat2_mode():
    value = os.getenv('CREDX_UAT2', '0')
    if value not in {'0', '1'}:
        raise RuntimeError('CREDX_UAT2 must be 0 or 1')
    return value == '1'


def require_uat2_owner(email):
    if uat2_mode() and email != OWNER_EMAIL:
        raise HTTPException(403, 'UAT2 is restricted to its owner')


def require_password_auth_allowed():
    if uat2_mode():
        raise HTTPException(403, 'UAT2 requires verified Google sign-in')


def validate_uat2_startup():
    if not uat2_mode():
        return
    from app.core.config import settings
    from app.core.security import signing_key
    from app.domains.auth.google_signin import DEFAULT_GOOGLE_SIGNIN_CLIENT_ID
    if settings.auth_disabled or settings.environment != 'uat2':
        raise RuntimeError('UAT2 requires environment=uat2 and authentication enabled')
    client = os.getenv('GOOGLE_SIGNIN_CLIENT_ID', '').strip()
    if not client or client == DEFAULT_GOOGLE_SIGNIN_CLIENT_ID:
        raise RuntimeError('UAT2 requires an independent Google sign-in client')
    signing_key()  # Validate presence; never print or persist its value.
    if os.getenv('UAT2_ADAPTERS') != 'simulation':
        raise RuntimeError('UAT2 requires simulation adapters')
    if not re.fullmatch(r'[0-9a-f]{40}', os.getenv('UAT2_SOURCE_COMMIT', '')):
        raise RuntimeError('UAT2 source commit must be a full SHA')
    db = urlsplit(settings.database_url)
    cache = urlsplit(settings.redis_url)
    if db.hostname != 'postgres' or db.path != '/credx_uat2' or db.username != 'credx_uat2':
        raise RuntimeError('UAT2 requires its dedicated database')
    if cache.hostname != 'redis' or cache.path != '/0':
        raise RuntimeError('UAT2 requires its dedicated Redis')
    # A no-egress network remains mandatory independently of this denylist.
    forbidden = ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
                 'DEEPSEEK_API_KEY', 'ZERODHA_API_KEY', 'ZERODHA_API_SECRET',
                 'GOOGLE_CLIENT_SECRET', 'SMTP_PASSWORD', 'SMTP_HOST',
                 'TAVILY_API_KEY', 'BULLPEN_API_KEY')
    if any(os.getenv(name) for name in forbidden):
        raise RuntimeError('UAT2 rejects external integration credentials/configuration')
    if os.getenv('UAT2_FIXTURE_STATE', 'populated') not in {'empty', 'populated'}:
        raise RuntimeError('Invalid UAT2 fixture state')
