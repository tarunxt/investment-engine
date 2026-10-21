"""Fixed UAT2 schema actions inside the existing confined migration service.

Never a general SQL/credential interface. Result files expose hashes/counts only;
material exports contain ciphertext and stay in private UAT2 artifact storage.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import stat
from urllib.parse import urlsplit

BASE = 'module_lifecycle_001'
STAGE09 = 'integration_connections_001'
STAGE10 = 'connection_attempts_001'
STAGE11 = 'indmoney_integrity_001'
STAGE12 = 'durable_analysis_001'
STAGE13 = 'ai_limits_001'
SPEND_COLUMNS={'recommendation_spend_accounts':frozenset({'last_admitted_owner'}),'recommendation_spend_attempts':frozenset({'operation_key','module_id','module_version','request_hash','limits_json','input_tokens','output_tokens'})}
WORKFLOW_COLUMNS={'zerodha_portfolio_snapshots':frozenset({'acquisition_json'}),'auto_rebalance_workflows':frozenset({'orchestration_kind','request_key','execution_json','control_version'}),'auto_rebalance_workflow_stages':frozenset({'checkpoint_json','attempt_count'})}
ANALYSIS_MATERIAL = frozenset(WORKFLOW_COLUMNS)|{'jobs','outbox'}
IMPORT_TABLE = 'indmoney_us_portfolio_snapshots'
IMPORT_COLUMNS = frozenset({'acceptance_state','import_key','content_hash','import_provenance','accepted_at','supersedes_id'})
ATTEMPTS = frozenset({'connection_attempts','connection_binding_history'})
TABLES = frozenset({'connection_credentials','integration_connections'})
ARTIFACTS = Path('/var/lib/credx-uat2/artifacts/native-schema')
PREFIX = 'CREDX_UAT2_SCHEMA_'


def sha(data):return hashlib.sha256(data).hexdigest()


# PostgreSQL16 dump/restore can move this implicit varchar[] -> text[] cast
# onto each literal. These two exact catalog decompilations express the same
# fixed two-value text domain; do not strip casts or normalize arbitrary SQL.
MODE_CHECK_FORMS = (
    "app_ownership_mode::text = ANY (ARRAY['user_owned'::character varying, 'platform_managed'::character varying]::text[])",
    "app_ownership_mode::text = ANY (ARRAY['user_owned'::character varying::text, 'platform_managed'::character varying::text])",
)


def canonical_checks(table, checks):
    return [dict(check,sqltext=MODE_CHECK_FORMS[0])
            if table=='integration_connections' and check.get('name')=='ck_connection_mode'
            and check.get('sqltext') in MODE_CHECK_FORMS else dict(check)
            for check in checks]


def validate_shape(revision,names,import_columns,workflow_columns=None,spend_columns=None):
    if revision not in {BASE,STAGE09,STAGE10,STAGE11,STAGE12,STAGE13}:raise RuntimeError('Unexpected schema revision')
    if (set(names)&TABLES)!=(TABLES if revision in {STAGE09,STAGE10,STAGE11,STAGE12,STAGE13} else set()):raise RuntimeError('Partial schema state')
    if (set(names)&ATTEMPTS)!=(ATTEMPTS if revision in {STAGE10,STAGE11,STAGE12,STAGE13} else set()):raise RuntimeError('Partial attempt schema state')
    if (set(import_columns)&IMPORT_COLUMNS)!=(IMPORT_COLUMNS if revision in {STAGE11,STAGE12,STAGE13} else set()):raise RuntimeError('Partial import schema state')
    for table,expected in WORKFLOW_COLUMNS.items():
        actual=set((workflow_columns or {}).get(table,()))&expected
        if actual!=(expected if revision in {STAGE12,STAGE13} else set()):raise RuntimeError('Partial workflow schema state')
    for table,expected in SPEND_COLUMNS.items():
        actual=set((spend_columns or {}).get(table,()))&expected
        if actual!=(expected if revision==STAGE13 else set()):raise RuntimeError('Partial spend schema state')


def capture(engine):
    import sqlalchemy as sa
    inspector=sa.inspect(engine);names=sorted(inspector.get_table_names(schema='public'))
    with engine.connect() as db:
        versions=list(db.execute(sa.text('SELECT version_num FROM public.alembic_version')).scalars())
        if len(versions)!=1:raise RuntimeError('Unexpected schema revision')
        revision=versions[0]
        import_columns={c['name'] for c in inspector.get_columns(IMPORT_TABLE,schema='public')} if IMPORT_TABLE in names else set()
        workflow_columns={name:{c['name'] for c in inspector.get_columns(name,schema='public')} if name in names else set() for name in WORKFLOW_COLUMNS}
        spend_columns={name:{c['name'] for c in inspector.get_columns(name,schema='public')} if name in names else set() for name in SPEND_COLUMNS}
        validate_shape(revision,names,import_columns,workflow_columns,spend_columns)
        data={}
        for name in names:
            table=sa.Table(name,sa.MetaData(),schema='public',autoload_with=db)
            data[name]={'columns':[(c['name'],str(c['type']),c['nullable'],c['default']) for c in inspector.get_columns(name,schema='public')],
                        'indexes':inspector.get_indexes(name,schema='public'),'fk':inspector.get_foreign_keys(name,schema='public'),
                        'pk':inspector.get_pk_constraint(name,schema='public'),'unique':inspector.get_unique_constraints(name,schema='public'),
                        'checks':canonical_checks(name,inspector.get_check_constraints(name,schema='public')),
                        'rows':sorted(json.dumps(dict(r),sort_keys=True,default=str) for r in db.execute(sa.select(table)).mappings())}
        sequences={}
        for name in sorted(inspector.get_sequence_names(schema='public')):
            quoted=db.dialect.identifier_preparer.quote_identifier(name)
            sequences[name]=list(db.execute(sa.text('SELECT last_value,is_called FROM public.'+quoted)).one())
        # PostgreSQL catalog definitions/ACLs deliberately omit unstable OIDs.
        catalog={key:[list(r) for r in db.execute(sa.text(query))] for key,query in {
            'schemas':"SELECT nspname,pg_get_userbyid(nspowner),nspacl::text FROM pg_namespace WHERE nspname='public' ORDER BY nspname",
            'views':"SELECT viewname,viewowner,definition FROM pg_views WHERE schemaname='public' ORDER BY viewname",
            'functions':"SELECT p.proname,pg_get_function_identity_arguments(p.oid),pg_get_userbyid(p.proowner),p.proacl::text,pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)",
            'triggers':"SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid,true) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname",
            'owners_acl':"SELECT c.relname,c.relkind,pg_get_userbyid(c.relowner),c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname",
        }.items()}
    return {'revision':revision,'fingerprint':sha(json.dumps({'tables':data,'sequences':sequences,'catalog':catalog},sort_keys=True,default=str).encode()),
            'stage13_columns':sorted(table+'.'+column for table,expected in SPEND_COLUMNS.items() for column in spend_columns[table]&expected),'stage12_columns':sorted(table+'.'+column for table,expected in WORKFLOW_COLUMNS.items() for column in workflow_columns[table]&expected),'stage11_columns':sorted(import_columns&IMPORT_COLUMNS),'stage09_tables':sorted(set(names)&TABLES),'stage10_tables':sorted(set(names)&ATTEMPTS),'table_count':len(names),
            'material_rows':sum(len(data[n]['rows']) for n in TABLES|ATTEMPTS|({IMPORT_TABLE} if revision in {STAGE11,STAGE12,STAGE13} else set()) if n in data)}


def private_write(path, value):
    payload=json.dumps(value,sort_keys=True,default=str).encode()
    fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'wb') as output:output.write(payload);output.flush();os.fsync(output.fileno())
    directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(directory)
    finally:os.close(directory)
    return sha(payload)


def execute(engine, action, request, expected, fingerprint=None, material_request=None, material_sha=None, migrate=None, target=None):
    import sqlalchemy as sa
    if not re.fullmatch(r'[0-9a-f]{32}',request):raise RuntimeError('Invalid schema request')
    before=capture(engine)
    if expected and before['revision']!=expected:raise RuntimeError('Schema revision changed')
    material=None
    if action=='preserve':
        if before['revision'] not in {STAGE09,STAGE10,STAGE11,STAGE12,STAGE13}:raise RuntimeError('Supported connection material state required')
        tables=(set(SPEND_COLUMNS) if before['revision']==STAGE13 else set())|(ANALYSIS_MATERIAL if before['revision'] in {STAGE12,STAGE13} else set())|TABLES|(ATTEMPTS if before['revision'] in {STAGE10,STAGE11,STAGE12,STAGE13} else frozenset())|({IMPORT_TABLE} if before['revision'] in {STAGE11,STAGE12,STAGE13} else frozenset())
        with engine.connect() as db:
            rows={name:[dict(r) for r in db.execute(sa.select(sa.Table(name,sa.MetaData(),schema='public',autoload_with=db))).mappings()] for name in sorted(tables)}
        path=ARTIFACTS/(request+'-material.json')
        material={'request':request,'sha256':private_write(path,{'revision':before['revision'],'tables':rows}),'rows':sum(map(len,rows.values()))}
        if capture(engine)!=before:raise RuntimeError('State changed during material preservation')
    elif action=='downgrade':
        baseline={STAGE09:BASE,STAGE10:STAGE09,STAGE11:STAGE10,STAGE12:STAGE11,STAGE13:STAGE12}.get(before['revision'])
        if baseline is None or expected!=before['revision'] or fingerprint!=before['fingerprint'] or (target or BASE)!=baseline:raise RuntimeError('Exact supported schema transition required for downgrade')
        if not re.fullmatch(r'[0-9a-f]{32}',material_request or ''):raise RuntimeError('Preservation receipt required')
        path=ARTIFACTS/(material_request+'-material.json')
        if path.is_symlink() or not path.is_file() or path.stat().st_uid!=os.geteuid() or stat.S_IMODE(path.stat().st_mode)&0o077 or sha(path.read_bytes())!=material_sha:raise RuntimeError('Preserved material mismatch')
        if migrate is None:raise RuntimeError('Confined migration required')
        if before['revision']==STAGE13:
            # Only after exact private preservation and matching fingerprint.
            # Legacy verification attempts are never removed by this cleanup.
            with engine.begin() as db:
                attempts=sa.Table('recommendation_spend_attempts',sa.MetaData(),autoload_with=db,schema='public')
                if db.scalar(sa.select(sa.func.count()).select_from(attempts).where(attempts.c.operation_key.is_not(None),attempts.c.verification_id.is_not(None))):raise RuntimeError('Ambiguous spend attempt parent')
                db.execute(sa.delete(attempts).where(attempts.c.operation_key.is_not(None),attempts.c.verification_id.is_(None)))
                # Cleanup and DDL share this one external transaction. Failed
                # downgrade must not commit deletion of preserved spend rows.
                migrate(baseline,connection=db)
        else:migrate(baseline)
        after=capture(engine)
        if (after['revision']!=baseline or after.get('stage13_columns')
            or (baseline!=STAGE12 and after.get('stage12_columns'))
            or (baseline in {STAGE11,STAGE12} and set(after.get('stage11_columns',[]))!=IMPORT_COLUMNS)
            or (baseline not in {STAGE11,STAGE12} and after.get('stage11_columns'))
            or (baseline in {STAGE10,STAGE11,STAGE12} and set(after.get('stage10_tables',[]))!=ATTEMPTS)
            or (baseline not in {STAGE10,STAGE11,STAGE12} and after.get('stage10_tables'))
            or (baseline==BASE and after['stage09_tables'])
            or (baseline in {STAGE09,STAGE10,STAGE11,STAGE12} and set(after['stage09_tables'])!=TABLES)):raise RuntimeError('Downgrade incomplete')
        return {'state':after}
    elif action=='verify':
        if expected not in {BASE,STAGE09,STAGE10,STAGE11,STAGE12,STAGE13} or before['fingerprint']!=fingerprint:raise RuntimeError('Restored database does not match backup')
    elif action!='inspect':raise RuntimeError('Unknown schema action')
    return {'state':before,**({'material':material} if material else {})}


def main():
    import sqlalchemy as sa
    from alembic import command
    from alembic.config import Config
    env=os.environ;url=env.get('DATABASE_URL','');parsed=urlsplit(url)
    if (env.get('CREDX_UAT2'),env.get('UAT2_RUNTIME'),env.get('UAT2_ADAPTERS'))!=('1','native','simulation') or (parsed.hostname,parsed.port,parsed.username,parsed.path)!=('127.0.0.1',5542,'credx_uat2','/credx_uat2'):
        raise RuntimeError('Dedicated simulated native UAT2 required')
    source=env.get(PREFIX+'SOURCE') or env.get('UAT2_SOURCE_COMMIT','')
    release=Path(__file__).resolve().parents[3]
    if not re.fullmatch(r'[0-9a-f]{40}',source) or json.loads((release/'native-manifest.json').read_text())['source_commit']!=source:
        raise RuntimeError('Schema helper release mismatch')
    config=Config('alembic.ini');action=env.get(PREFIX+'ACTION','upgrade')
    if action=='upgrade':command.upgrade(config,'head');return
    ARTIFACTS.mkdir(mode=0o700,parents=True,exist_ok=True)
    if ARTIFACTS.is_symlink() or ARTIFACTS.stat().st_uid!=os.geteuid() or stat.S_IMODE(ARTIFACTS.stat().st_mode)&0o077:raise RuntimeError('Unsafe schema artifact directory')
    request=env.get(PREFIX+'REQUEST','')
    engine=sa.create_engine(url.replace('postgresql+asyncpg://','postgresql+psycopg2://'),hide_parameters=True,
                            connect_args={'options':'-c statement_timeout=10000 -c lock_timeout=3000'})
    def migrate(target,*,connection=None):
        if connection is None:return command.downgrade(config,target)
        previous=config.attributes.get('connection')
        config.attributes['connection']=connection
        try:return command.downgrade(config,target)
        finally:
            if previous is None:config.attributes.pop('connection',None)
            else:config.attributes['connection']=previous
    try:
        result=execute(engine,action,request,env.get(PREFIX+'EXPECTED'),env.get(PREFIX+'FINGERPRINT'),
                       env.get(PREFIX+'MATERIAL_REQUEST'),env.get(PREFIX+'MATERIAL_SHA'),
                       migrate=migrate,target=env.get(PREFIX+'TARGET'))
        private_write(ARTIFACTS/(request+'-result.json'),{'request':request,'source':source,'action':action,**result})
    finally:engine.dispose()


if __name__=='__main__':
    try:main()
    except Exception:
        print('Confined UAT2 schema operation failed; values withheld',file=sys.stderr);sys.exit(1)
