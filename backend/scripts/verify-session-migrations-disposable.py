#!/usr/bin/env python3
"""Run inside a disposable Docker backend only; dedicated local synthetic DB.

Executes new migration upgrade/downgrade bodies with real Alembic operations.
Does not claim historical full-database upgrade or authorize production rollback.
"""
import socket, subprocess, os
original=socket.socket.connect
def deny(*a,**k):raise AssertionError('Migration proof egress forbidden')
def connect(sock,address):
    if sock.family==socket.AF_UNIX and str(address)=='/var/run/postgresql/.s.PGSQL.5432':return original(sock,address)
    return deny()
socket.socket.connect=connect;socket.socket.connect_ex=deny;socket.create_connection=deny
socket.getaddrinfo=deny;socket.socket.sendto=deny;subprocess.Popen=deny;os.system=deny
import ast, importlib.util
from pathlib import Path
from sqlalchemy import create_engine,MetaData,Table,Column,Integer,inspect
from sqlalchemy.schema import CreateSchema,DropSchema
from alembic.migration import MigrationContext
from alembic.operations import Operations

root=Path(__file__).resolve().parents[1]
revisions={}
for path in (root/'alembic/versions').glob('*.py'):
    values={}
    for node in ast.parse(path.read_text()).body:
        targets=node.targets if isinstance(node,ast.Assign)else[node.target]if isinstance(node,ast.AnnAssign)else[]
        for target in targets:
            if isinstance(target,ast.Name)and target.id in {'revision','down_revision'}:values[target.id]=ast.literal_eval(node.value)
    if values.get('revision'):revisions[values['revision']]=values.get('down_revision')
parents={p for v in revisions.values()for p in(v if isinstance(v,(tuple,list))else[v])if p}
assert not parents-set(revisions)
assert set(revisions)-parents=={'a12_cost_session_merge_001'}
def walk(rev,seen):
    assert rev not in seen,'migration cycle'
    for p in (revisions[rev]if isinstance(revisions[rev],(tuple,list))else[revisions[rev]]):
        if p:walk(p,seen|{rev})
walk('a12_cost_session_merge_001',set())
engine=create_engine('postgresql+psycopg://postgres@/a9_synthetic?host=/var/run/postgresql')
schema='a9_auth_migration_probe'
with engine.begin()as db:
    db.execute(CreateSchema(schema))
try:
    with engine.begin()as connection:
        db=connection.execution_options(schema_translate_map={None:schema})
        Table('users',MetaData(),Column('id',Integer,primary_key=True)).create(db)
        migrations=[]
        with Operations.context(MigrationContext.configure(db)):
            for filename in ['session_families_001.py','session_refresh_intents_001.py']:
                spec=importlib.util.spec_from_file_location(filename,root/'alembic/versions'/filename)
                module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
                module.upgrade();migrations.append(module)
            inspector=inspect(db)
            assert {c['name']for c in inspector.get_columns('auth_refresh_intents',schema=schema)}=={'token_digest','family_id','nonce_digest','started'}
            assert {'auth_session_families','auth_refresh_intents'}<=set(inspector.get_table_names(schema=schema))
            for module in reversed(migrations):module.downgrade()
            assert not {'auth_session_families','auth_refresh_intents'}&set(inspect(db).get_table_names(schema=schema))
            for module in migrations:module.upgrade()
    print('PASS: full static revision graph single head/no missing parents/cycles; actual new migrations upgrade/downgrade/upgrade in disposable Docker backend')
finally:
    with engine.begin()as db:db.execute(DropSchema(schema,cascade=True))
    engine.dispose()
