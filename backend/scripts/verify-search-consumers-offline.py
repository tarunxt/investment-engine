#!/usr/bin/env python3
"""Run A9 consumer evidence in a sanitized, guarded process before app imports.

No runtime policy/settings are modified. Application imports and tests run with
synthetic environment, no .env file, forbidden network/SDK/task/email transports.
"""
from contextlib import ExitStack
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

assert not any(name == 'app' or name.startswith('app.') for name in sys.modules)
ROOT = Path(__file__).resolve().parents[1]
violations = []


def deny(kind):
    def blocked(*args, **kwargs):
        violations.append(kind)  # Never record arguments/URLs/credentials.
        raise AssertionError('Offline transport forbidden: ' + kind)
    return blocked


# Install the lowest boundary BEFORE importing third-party or application code.
import socket
socket.socket.connect = deny('socket.connect')
socket.socket.connect_ex = deny('socket.connect_ex')
socket.create_connection = deny('socket.create_connection')
socket.getaddrinfo = deny('socket.getaddrinfo')


def audit(event, args):
    if event in {'socket.connect', 'socket.getaddrinfo', 'subprocess.Popen', 'os.system'}:
        deny(event)()


sys.addaudithook(audit)
os.environ.clear()
os.environ.update({
    'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
    'DATABASE_URL': 'postgresql+asyncpg://test:test@localhost:5432/testdb',
    'REDIS_URL': 'redis://localhost:6379/0',
    'A9_CONSUMER_GUARDED': '1', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1',
})
sys.path.insert(0, str(ROOT))
# Source fixture dependencies import each other as top-level test modules.
sys.path.insert(0, str(ROOT / 'tests'))

with TemporaryDirectory(prefix='a9-empty-cwd-') as cwd, ExitStack() as stack:
    os.chdir(cwd)  # BaseSettings must not discover a checkout/operator .env.
    import requests
    import httpx
    import openai
    from google import genai
    import smtplib
    from celery.app.task import Task
    for target, attr, kind in [
        (requests.Session, 'request', 'requests'),
        (httpx.Client, 'send', 'httpx'), (httpx.AsyncClient, 'send', 'httpx.async'),
        (openai.OpenAI, '__init__', 'openai.constructor'),
        (openai.AsyncOpenAI, '__init__', 'openai.async.constructor'),
        (genai.Client, '__init__', 'gemini.constructor'),
        (Task, 'apply_async', 'celery.dispatch'),
        (smtplib.SMTP, '__init__', 'smtp'), (smtplib.SMTP_SSL, '__init__', 'smtp.ssl'),
    ]:
        stack.enter_context(patch.object(target, attr, deny(kind)))
    # Import pytest only after guards; plugin loading is explicitly bounded.
    import pytest
    args = [str(ROOT / 'tests' / name) for name in [
        'test_providers.py::GeminiProviderConfigTests', 'test_gemini_search_egress.py', 'test_public_query_projection.py', 'test_search_consumer_dispatch.py', 'test_search_egress_boundary.py',
        'test_rebalance_side_effect_policy.py', 'test_openai_provider.py', 'test_deepseek_provider.py',
        'test_web_search_tool.py', 'test_polymarket_event_preflight.py',
        'test_polymarket_auto_live_evidence.py', 'test_output_contracts.py',
        'test_google_sheets_output_contracts.py',
    ]]
    result = pytest.main(['-q', '-p', 'anyio.pytest_plugin', *args])
    print('A9 guard violations:', len(violations))
    if violations:
        print('Forbidden transport kinds:', sorted(set(violations)))
    raise SystemExit(result if result else (1 if violations else 0))
