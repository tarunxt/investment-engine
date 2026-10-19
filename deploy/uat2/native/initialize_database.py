"""One-time native UAT2 role/database setup, after exact security approval.

Run as credx-uat2-db with runtime-resolved UAT2 configuration. Administrative DDL
requires SQL here; application data still uses existing SQLAlchemy models.
"""
import os
from urllib.parse import unquote, urlsplit
from sqlalchemy import create_engine, text

url = urlsplit(os.environ['DATABASE_URL'])
if (url.hostname,url.port,url.path,url.username) != ('127.0.0.1',5542,'/credx_uat2','credx_uat2'):
    raise RuntimeError('Refusing non-UAT2 database setup')
engine = create_engine('postgresql+psycopg2://credx-uat2-db@/postgres?host=/run/credx-uat2-postgres&port=5542', isolation_level='AUTOCOMMIT', hide_parameters=True)
with engine.connect() as db:
    role_exists = db.execute(text("SELECT 1 FROM pg_roles WHERE rolname='credx_uat2'")).scalar()
    database_exists = db.execute(text("SELECT 1 FROM pg_database WHERE datname='credx_uat2'")).scalar()
    if role_exists or database_exists:
        raise RuntimeError('UAT2 database/role already exists; use deploy or review partial initialization')
    db.execute(text('CREATE ROLE credx_uat2 LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :password'), {'password': unquote(url.password)})
    db.execute(text('CREATE DATABASE credx_uat2 OWNER credx_uat2'))
    db.execute(text('REVOKE CONNECT ON DATABASE credx_uat2 FROM PUBLIC'))
    db.execute(text('GRANT CONNECT ON DATABASE credx_uat2 TO credx_uat2'))
print('Dedicated native UAT2 role/database initialized; values withheld')
