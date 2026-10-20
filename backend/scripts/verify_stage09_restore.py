"""CI-only PostgreSQL16 dump/restore rehearsal; never a live rollback command."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import sqlalchemy as sa

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
APP_SOURCE = '6844989a55ea2408d6da7862fa07194079ff8b19'
STAGE08_SOURCE = '61ce447ba35f4db7cd06fd550c62557450247af3'
BASE_REVISION = 'module_lifecycle_001'
NEW_REVISION = 'integration_connections_001'
NEW_TABLES = frozenset({'integration_connections', 'connection_credentials'})
URL = 'postgresql+psycopg2://stage09:stage09@postgres:5432/credx_stage09_test'
REQUIRED = {'CI':'true', 'GITHUB_ACTIONS':'true', 'ENVIRONMENT':'test',
            'AUTH_DISABLED':'false', 'DATABASE_URL':URL, 'REDIS_URL':'redis://127.0.0.1:1/15',
            'CREDX_STAGE09_RESTORE_ACK':'disposable-ci-only'}
ALLOWED_CHANGES = frozenset({
    'backend/scripts/verify_stage09_restore.py',
    'backend/scripts/test_verify_stage09_restore.py',
    '.github/workflows/pr-checks.yml',
    'docs/public-launch/STAGE09_ROLLBACK_REHEARSAL.md',
    'docs/public-launch/STATUS.md',
})


def inside_container():
    return Path('/.dockerenv').is_file()


def guarded_environment(environment):
    if any(environment.get(k) != v for k,v in REQUIRED.items()) or not inside_container():
        raise RuntimeError('Exact disposable backend CI container required')
    if any((directory/name).exists() for directory in (ROOT, BACKEND)
           for name in ('.env','.env.local','.env.production','.env.production.local')):
        raise RuntimeError('Inherited application environment refused')
    # Fixed disposable libpq target and test password only; never inherit other
    # database/provider/cloud/libpq configuration from a developer environment.
    return {**REQUIRED, 'PATH':environment.get('PATH',''), 'PYTHONPATH':str(BACKEND),
            'PYTHONDONTWRITEBYTECODE':'1', 'LC_ALL':'C', 'PGPASSWORD':'stage09'}


def validate_changed_paths(paths):
    if set(paths) - ALLOWED_CHANGES:
        raise RuntimeError('Application runtime must remain identical to approved source')


def postgres16(version):
    if not re.search(r'\(PostgreSQL\) 16\.',version):
        raise RuntimeError('Native PostgreSQL16 client required')
    return version.strip()


def expected_dependency_failure(stderr):
    # A missing tool, authentication, permissions, network or generic SQL error
    # must not be reported as the predicted new-FK restore failure.
    return bool('because other objects depend on it' in stderr
                and 'integration_connections' in stderr
                and re.search(r'cannot drop (constraint|table|index)',stderr)
                and ('users_pkey' in stderr or re.search(r'table (public\.)?users',stderr)))


def normalize_schema(text):
    # PostgreSQL security restrict tokens are random per plain-text dump. Do not
    # discard SQL, ownership, grants, constraints, defaults or object definitions.
    return '\n'.join(line for line in text.splitlines()
                     if not line.startswith(('\\restrict ', '\\unrestrict ')))+'\n'


def digest(value):
    return hashlib.sha256(value).hexdigest()


def guarded_test_sequence(marker, revision, preserve, downgrade, restore, verify, finalize):
    """Test-only model of the proposed manual sequence, NOT a controller fix.

    Native ctl.py does not call this function. Finalize is a fake event recorder
    in this rehearsal; no application promotion/start/readiness is performed.
    """
    if revision != NEW_REVISION or not marker.is_file():
        raise RuntimeError('Exact Stage09 revision and existing pending marker required')
    preserve()
    downgrade()
    restore()
    verify()
    finalize()
    marker.unlink()


def main(mode):
    env = guarded_environment(os.environ)  # before imports with app configuration or any DB connection
    out = Path('/tmp/stage09-restore')/mode
    if out.exists():
        raise RuntimeError('Fresh receipt directory required; do not retry a partially restored fixture')
    out.mkdir(parents=True)
    receipt = {'scenario':mode, 'application_source':APP_SOURCE, 'stage08_source':STAGE08_SOURCE,
               'status':'running', 'skipped':0, 'commands':[], 'live_data_or_credentials':False}

    def save():
        (out/'receipt.json').write_text(json.dumps(receipt,indent=2,default=str)+'\n')

    def run(args, name, *, timeout=120, stdin=None, stdout=None, required=True, cwd=BACKEND):
        result = subprocess.run(args,cwd=cwd,env=env,stdin=stdin,
                                stdout=stdout or subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
        receipt['commands'].append({'name':name,'argv':[str(a) for a in args],
                                    'returncode':result.returncode,'timeout_seconds':timeout})
        (out/(name+'.stderr.log')).write_bytes(result.stderr)
        save()
        if required and result.returncode:
            raise RuntimeError('Bounded rehearsal command failed: '+name)
        return result

    def alembic(direction, target):
        return run([sys.executable,'-m','alembic',direction,target],direction+'-'+target,timeout=120)

    connect = ['-h','postgres','-p','5432','-U','stage09','-d','credx_stage09_test']
    engine = None
    marker = None
    try:
        receipt['verification_commit'] = run(['git','rev-parse','HEAD'],'verification-head').stdout.decode().strip()
        paths = run(['git','diff','--name-only',APP_SOURCE,'HEAD','--'],'source-diff').stdout.decode().splitlines()
        validate_changed_paths(paths); receipt['test_only_changed_paths']=paths
        receipt['approved_tree'] = run(['git','rev-parse',APP_SOURCE+'^{tree}'],'application-tree').stdout.decode().strip()
        run(['git','merge-base','--is-ancestor',STAGE08_SOURCE,APP_SOURCE],'stage08-ancestry')
        if run(['git','status','--porcelain'],'clean-source').stdout.strip():
            raise RuntimeError('Clean committed source required')
        receipt['pg_dump_version']=postgres16(run(['pg_dump','--version'],'dump-version').stdout.decode())
        receipt['pg_restore_version']=postgres16(run(['pg_restore','--version'],'restore-version').stdout.decode())
        engine = sa.create_engine(URL,connect_args={'options':'-c statement_timeout=10000 -c lock_timeout=3000'})
        with engine.connect() as db:
            server=int(db.scalar(sa.text('SHOW server_version_num')))
            assert 160000 <= server < 170000, 'PostgreSQL16 server required'
            assert db.scalar(sa.text('SELECT current_database()'))=='credx_stage09_test'
            assert db.scalar(sa.text('SELECT current_user'))=='stage09'
        receipt['server_version_num']=server
        assert not sa.inspect(engine).get_table_names(), 'Refuse any populated fixture'
        assert not sa.inspect(engine).get_view_names(), 'Refuse existing fixture views'
        alembic('upgrade',BASE_REVISION)
        import app.models  # canonical registry, never application servers/workers/provider calls
        from app.domains.auth.models import User,UserProfile
        from app.domains.zerodha.models import ZerodhaCredential
        from app.domains.jobs.models import Job
        from app.domains.modules.models import UserModulePreferences,UserModule
        from app.shared.types import JobStatus
        from sqlalchemy.orm import Session
        from datetime import datetime,timedelta,timezone
        with Session(engine) as db:
            for name in ('a','b'):
                user=User(email=f'{name}@stage09-restore.example.invalid',username='restore_'+name,
                          password_hash='unusable',full_name='Stage08 synthetic '+name,
                          is_active=True,is_verified=True,profile=UserProfile(bio='original-'+name,timezone='UTC'))
                db.add(user);db.flush()
                db.add(ZerodhaCredential(user_id=user.id,access_token='opaque-synthetic-legacy-ciphertext-'+name,
                        login_time=datetime.now(timezone.utc),expires_at=datetime.now(timezone.utc)+timedelta(hours=1)))
                db.add(Job(user_id=user.id,prompt='Synthetic owned '+name,provider='fake',model='offline',
                           status=JobStatus.COMPLETED,response='Stored synthetic result '+name))
                db.add(UserModulePreferences(user_id=user.id,version=1))
                db.add(UserModule(user_id=user.id,module_id='ai_studio',enabled=False,version=1,
                                  config={'schema_version':1},schedules_paused=True))
            db.commit()
        # Additional synthetic objects make the schema comparison cover more
        # than tables. No roles, GRANTs or extra privileges are created.
        with engine.begin() as db:
            db.execute(sa.DDL('CREATE VIEW public.restore_owned_profiles AS SELECT user_id,bio FROM public.user_profiles'))
            db.execute(sa.DDL("CREATE FUNCTION public.restore_noop_trigger() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'"))
            db.execute(sa.DDL('CREATE TRIGGER restore_profile_guard BEFORE UPDATE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION public.restore_noop_trigger()'))
        from verify_api_attempt_migration import baseline_snapshot

        def ciphertext():
            with engine.connect() as db:
                rows=db.execute(sa.select(ZerodhaCredential.id,ZerodhaCredential.user_id,
                                          ZerodhaCredential.access_token).order_by(ZerodhaCredential.id)).all()
            return digest(json.dumps([list(r) for r in rows],separators=(',',':')).encode())

        def snapshot(label):
            with engine.connect() as db:
                revision=db.scalar(sa.text('SELECT version_num FROM alembic_version'))
                # Definitions/owners/ACLs contain no unstable catalog OIDs.
                objects={
                    'schemas':[list(r) for r in db.execute(sa.text("SELECT nspname,pg_get_userbyid(nspowner),nspacl::text FROM pg_namespace WHERE nspname='public' ORDER BY nspname"))],
                    'views':[list(r) for r in db.execute(sa.text("SELECT schemaname,viewname,viewowner,definition FROM pg_views WHERE schemaname='public' ORDER BY viewname"))],
                    'functions':[list(r) for r in db.execute(sa.text("SELECT p.proname,pg_get_function_identity_arguments(p.oid),pg_get_userbyid(p.proowner),p.proacl::text,pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)"))],
                    'triggers':[list(r) for r in db.execute(sa.text("SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid,true) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname"))],
                    'relation_owners_acl':[list(r) for r in db.execute(sa.text("SELECT c.relname,c.relkind,pg_get_userbyid(c.relowner),c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname"))],
                    'table_grants':[list(r) for r in db.execute(sa.text("SELECT grantor,grantee,table_name,privilege_type,is_grantable FROM information_schema.table_privileges WHERE table_schema='public' ORDER BY table_name,grantor,grantee,privilege_type"))],
                }
                sequences={}
                for seq in sorted(sa.inspect(db).get_sequence_names(schema='public')):
                    # Vendor catalog state (including is_called) has no generic
                    # SQLAlchemy inspector API; quote server-derived identifiers.
                    name=db.dialect.identifier_preparer.quote_identifier(seq)
                    row=db.execute(sa.text('SELECT last_value,is_called FROM public.'+name)).one()
                    sequences[seq]=list(row)
            schema=run(['pg_dump',*connect,'--schema-only','--no-comments'],label+'-schema',timeout=60).stdout.decode()
            schema=normalize_schema(schema);(out/(label+'.schema.sql')).write_text(schema)
            state={'revision':revision,'tables':baseline_snapshot(engine,exclude_tables=frozenset()),
                   'sequences':sequences,'schema_sql':schema,'schema_objects':objects,'ciphertext_sha256':ciphertext()}
            (out/(label+'.json')).write_text(json.dumps(state,sort_keys=True,indent=2,default=str)+'\n')
            return state

        before=snapshot('stage08-before');assert before['revision']==BASE_REVISION
        backup=out/'stage08.dump'
        with backup.open('wb') as stream:run(['pg_dump',*connect,'-Fc'],'stage08-backup',timeout=60,stdout=stream)
        assert backup.stat().st_size>5
        receipt['backup']={'source_commit':STAGE08_SOURCE,'revision':BASE_REVISION,'sha256':digest(backup.read_bytes()),
                           'format':'custom','bytes':backup.stat().st_size}
        receipt['baseline_snapshot_sha256']=digest(json.dumps(before,sort_keys=True,default=str).encode())
        alembic('upgrade',NEW_REVISION)
        after=snapshot('stage09-upgraded')
        assert after['revision']==NEW_REVISION and after['ciphertext_sha256']==before['ciphertext_sha256']
        assert set(after['tables'])==set(before['tables'])|NEW_TABLES
        assert {k:v for k,v in after['tables'].items() if k not in NEW_TABLES}==before['tables']
        assert after['sequences']==before['sequences']
        inspector=sa.inspect(engine)
        assert any(f['referred_table']=='users' for f in inspector.get_foreign_keys('integration_connections'))
        assert any(f['referred_table']=='integration_connections' and f['constrained_columns']==['connection_id','owner_id']
                   for f in inspector.get_foreign_keys('connection_credentials'))
        with engine.connect() as db:
            assert db.scalar(sa.text('SELECT count(*) FROM connection_credentials'))==0
            assert db.scalar(sa.text("SELECT count(*) FROM integration_connections WHERE status='legacy_review' AND version=1 AND provider_account_id IS NULL"))==2
        receipt['additive_migration_and_ciphertext_preservation']=True
        # A real post-backup mutation ensures successful restore cannot be a no-op.
        with engine.begin() as db:
            db.execute(sa.update(User).where(User.username=='restore_a').values(full_name='post-backup mutation'))
        changed=snapshot('post-backup-mutated');assert changed['tables']!=before['tables']
        marker=out/'pending-deployment.json'
        marker.write_text(json.dumps({'candidate':APP_SOURCE,'fixture_only':True})+'\n')
        original_backup_hash=receipt['backup']['sha256']
        final_events=[]

        def preserve():
            from app.domains.connections.models import IntegrationConnection,ConnectionCredential
            with Session(engine) as db:
                owner=db.scalar(sa.select(User.id).where(User.username=='restore_a'))
                db.add(IntegrationConnection(id='synthetic-candidate-binding',owner_id=owner,provider='zerodha',
                       app_ownership_mode='user_owned',credential_ref='synthetic-private-material',version=1,
                       status='configured',is_current=False))
                db.flush()
                db.add(ConnectionCredential(id='synthetic-private-material',connection_id='synthetic-candidate-binding',
                       owner_id=owner,ciphertext='opaque-synthetic-post-migration-material',key_version=1))
                db.commit()
            with engine.connect() as db:
                material={name:[dict(r) for r in db.execute(sa.select(sa.Table(name,sa.MetaData(),autoload_with=db))).mappings()]
                          for name in sorted(NEW_TABLES)}
            exported=json.dumps(material,sort_keys=True,default=str).encode()
            (out/'preserved-synthetic-bindings.json').write_bytes(exported)
            archive=out/'preserved-synthetic-bindings.dump'
            with archive.open('wb') as stream:
                run(['pg_dump',*connect,'-Fc','-t','public.integration_connections','-t','public.connection_credentials'],
                    'preserve-stage09-material',timeout=60,stdout=stream)
            receipt['preserved_material']={'synthetic_only':True,'rows':sum(len(v) for v in material.values()),
                                          'json_sha256':digest(exported),'dump_sha256':digest(archive.read_bytes())}

        def downgrade():
            assert snapshot('immediately-before-downgrade')['revision']==NEW_REVISION
            alembic('downgrade',BASE_REVISION)
            down=snapshot('after-downgrade')
            assert set(down['tables'])==set(before['tables']) and not NEW_TABLES.intersection(down['tables'])
            assert down['revision']==BASE_REVISION and down['schema_sql']==before['schema_sql']
            assert down['schema_objects']==before['schema_objects']
            assert down['ciphertext_sha256']==before['ciphertext_sha256']
            assert down['tables']!=before['tables'], 'Mutation must remain until real restore'
            receipt['downgrade_removed_only_stage09_schema']=True

        def restore():
            assert digest(backup.read_bytes())==original_backup_hash, 'Backup changed before restore'
            assert receipt['backup']['source_commit']==STAGE08_SOURCE and receipt['backup']['revision']==BASE_REVISION
            engine.dispose()
            with backup.open('rb') as stream:
                result=run(['pg_restore',*connect,'--clean','--if-exists','--exit-on-error'],
                           'native-flags-restore',stdin=stream,timeout=120,required=False)
            return result

        def verify():
            final=snapshot('restored-stage08')
            assert final==before, 'Full schema/data/revision/sequences/objects/ACLs/ciphertext mismatch'
            receipt['restored_snapshot_sha256']=digest(json.dumps(final,sort_keys=True,default=str).encode())
            receipt['full_schema_data_revision_sequences_objects_grants_equal']=True
            receipt['ciphertext_digest_preserved']=final['ciphertext_sha256']
            assert not NEW_TABLES.intersection(sa.inspect(engine).get_table_names())
            assert digest((out/'preserved-synthetic-bindings.json').read_bytes())==receipt['preserved_material']['json_sha256']
            assert digest((out/'preserved-synthetic-bindings.dump').read_bytes())==receipt['preserved_material']['dump_sha256']

        if mode=='direct_restore':
            restored=restore()
            error=restored.stderr.decode(errors='replace')
            assert restored.returncode!=0 and expected_dependency_failure(error), 'Direct restore did not demonstrate predicted new-FK dependency failure'
            receipt['expected_failure']='new Stage09 FK prevents dropping referenced users object'
            receipt['dependency_error_sha256']=digest(restored.stderr)
            receipt['partial_restore_fixture_disposition']='discard entire disposable CI service; never retry this database'
            assert marker.exists()
        else:
            def checked_restore():
                assert restore().returncode==0, 'Downgrade-then-restore failed'
            guarded_test_sequence(marker,NEW_REVISION,preserve,downgrade,checked_restore,verify,
                                  lambda:final_events.append('verified-test-completion-only'))
            assert final_events==['verified-test-completion-only'] and not marker.exists()
        receipt['application_promotion_restart_readiness_performed']=False
        receipt['native_controller_repaired']=False
        receipt['deployment_gate']='HOLD: standalone rollback marker and schema cleanup controller gaps remain'
        receipt['status']='passed';save();print(json.dumps(receipt,indent=2))
    except Exception as exc:
        receipt['status']='failed';receipt['failure_type']=type(exc).__name__
        receipt['pending_marker_present_on_failure']=bool(marker and marker.exists())
        receipt['failure_handling']='Stop; retain synthetic diagnostics; discard CI fixture. No live restore or retry.'
        save();raise
    finally:
        if engine is not None:engine.dispose()


if __name__=='__main__':
    parser=argparse.ArgumentParser(__doc__)
    parser.add_argument('mode',choices=['direct_restore','downgrade_then_restore'])
    main(parser.parse_args().mode)
