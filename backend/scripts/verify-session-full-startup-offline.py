#!/usr/bin/env python3
"""Actual main/lifespan with synthetic DB only; never starts workers/providers.

Prerequisite: owned network-none PG fixture used by session-policy checks.
Reports honest full-startup blocker rather than stubbing runtime initialization.
"""
import runpy,asyncio,json,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
# This fixture installs socket/process guards and clears inherited config BEFORE
# any application imports. No production .env or credentials are loaded.
ns=runpy.run_path(str(root/'frontend/tests/session-http-browser/backend.py'),run_name='startup_fixture')
from app.main import app,lifespan
from app.domains.auth.models import AuthSessionFamily,AuthRefreshIntent
from app.infrastructure.database.session import async_engine
from app.infrastructure.database.base import Base
async def main():
 report={'actual_main_import':'PASS','missing_schema_startup':'PENDING','full_startup':'PENDING'}
 async with async_engine.begin() as db:
  await db.run_sync(Base.metadata.create_all)
  await db.run_sync(lambda c:AuthRefreshIntent.__table__.drop(c,checkfirst=True))
  await db.run_sync(lambda c:AuthSessionFamily.__table__.drop(c,checkfirst=True))
 try:
  try:
   async with lifespan(app):raise AssertionError('Missing schema admitted startup')
  except Exception as e:
   if 'auth_session_families' not in str(e):raise
   report['missing_schema_startup']='PASS'
 finally:
  async with async_engine.begin() as db:await db.run_sync(Base.metadata.create_all)
 if '--schema-only' in sys.argv:
  report['full_startup']='NOT_RUN';await async_engine.dispose();print(json.dumps(report,indent=2));return
 try:
  async with lifespan(app):report['full_startup']='PASS'
 except Exception as e:
  report['full_startup']='BLOCKED';report['blocker_type']=type(e).__name__;report['blocker']=str(e)[:1500]
 finally:await async_engine.dispose()
 print(json.dumps(report,indent=2))
 if report['full_startup']!='PASS':raise SystemExit(2)
asyncio.run(main())
