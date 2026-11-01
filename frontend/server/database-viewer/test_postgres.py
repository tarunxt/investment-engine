"""Destructive synthetic fixtures ONLY in an explicit, isolated PostgreSQL 18 cluster.

Never run against production. Environment acknowledgement, host, database prefix
and fixture administrator are validated BEFORE any connection or mutation.
"""
import importlib.util
import os
from pathlib import Path
import unittest

from sqlalchemy import BigInteger, Boolean, Column, MetaData, Table, Text, insert, select, text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.engine import make_url
from sqlalchemy.pool import NullPool
from sqlalchemy.exc import DBAPIError

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('pg_viewer_plan', HERE / 'plan_sql.py')
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


def statements(sql):
    """Split our fixed SQL, respecting dollar bodies and quoted identifiers/text."""
    parts, current, index, quote = [], [], 0, None
    while index < len(sql):
        if quote is None and sql.startswith('--', index):
            index = sql.find('\n', index)
            if index < 0:
                break
            continue
        if quote is None and sql.startswith('$audit$', index):
            quote = '$audit$'; current.append(quote); index += len(quote); continue
        if quote == '$audit$' and sql.startswith(quote, index):
            current.append(quote); index += len(quote); quote = None; continue
        char = sql[index]
        if quote != '$audit$':
            if quote is None and char in "'\"":
                quote = char
            elif quote == char:
                if index + 1 < len(sql) and sql[index+1] == char:
                    current += [char, char]; index += 2; continue
                quote = None
            elif quote is None and char == ';':
                value = ''.join(current).strip(); current = []
                if value and value not in {'BEGIN', 'ROLLBACK'}:
                    parts.append(value)
                index += 1; continue
        current.append(char); index += 1
    return parts


class PgIsolationTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get('CREDX_VIEWER_DISPOSABLE_DB') != '1':
            raise unittest.SkipTest('Actual PostgreSQL 18 tests require explicit disposable-cluster acknowledgement')
        url = make_url(os.environ['CREDX_VIEWER_TEST_URL'])
        if url.username != 'viewer_fixture_admin' or not (url.database or '').startswith('credx_viewer_test_') or url.host not in {'127.0.0.1','localhost','postgres'}:
            raise RuntimeError('Refusing a non-fixture database')
        cls.url = url

    async def asyncSetUp(self):
        self.engine = create_async_engine(self.url, poolclass=NullPool, hide_parameters=True)
        self.connection = await self.engine.connect()
        self.transaction = await self.connection.begin()
        version = int(await self.connection.scalar(text('SHOW server_version_num')))
        self.assertTrue(180000 <= version < 190000, 'Requires actual PostgreSQL 18')
        self.assertEqual(await self.connection.scalar(text('SELECT current_user')), 'viewer_fixture_admin')
        # Everything is rolled back, including fixture role/schema/default ACL changes.
        existing = await self.connection.scalar(text("SELECT count(*) FROM pg_roles WHERE rolname IN ('credx_viewer_read','credx_viewer_views','viewer_fixture_other')"))
        self.assertEqual(existing, 0, 'Refusing to replace existing role objects')
        self.public_defaults = (await self.connection.execute(text("SELECT d.datname, bool_or(a.grantee=0 AND a.privilege_type='CREATE'), bool_or(a.grantee=0 AND a.privilege_type='TEMPORARY') FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE d.datallowconn GROUP BY d.datname"))).all()
        self.public_schema_create = await self.connection.scalar(text("SELECT EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE')"))
        dbs = [row[0] for row in self.public_defaults]
        for database in dbs:
            quoted = self.connection.dialect.identifier_preparer.quote(database)
            await self.connection.exec_driver_sql(f'REVOKE CREATE,TEMP ON DATABASE {quoted} FROM PUBLIC')
        await self.connection.exec_driver_sql('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
        await self.connection.exec_driver_sql('CREATE ROLE viewer_fixture_other NOLOGIN')
        names=[item['relation'] for item in plan.catalog()['relations']]
        existing_tables=await self.connection.scalar(text("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(:names)"),{'names':names})
        self.assertEqual(existing_tables,0,'Refusing to replace existing fixture relations')
        self.metadata = MetaData()
        self.tables = {}
        for item in plan.catalog()['relations']:
            fields = set(item['columns'] + item['policy_columns'])
            fields.add('forbidden_payload')
            columns = [Column('id', BigInteger, primary_key=True)]
            columns += [Column(name, Boolean if name == 'is_system' else BigInteger if name.endswith('_id') else Text) for name in sorted(fields-{'id'})]
            self.tables[item['relation']] = Table(item['relation'], self.metadata, *columns, schema='public')
        await self.connection.run_sync(self.metadata.create_all)
        for item in plan.catalog()['relations']:
            table = self.tables[item['relation']]
            rows = []
            for record, owner in [(101,71),(201,72),(301,None)]:
                row = {column.name: False if column.name == 'is_system' else record if column.name.endswith('_id') else 'synthetic' for column in table.columns if column.name != 'id'}
                row['id'] = record
                if 'user_id' in row:
                    row['user_id'] = owner
                rows.append(row)
            name = item['relation']
            if name == 'run_jobs':
                rows += [{**rows[0], 'id':401,'job_id':201},{**rows[0], 'id':501,'run_id':201}]
            elif name == 'auto_rebalance_workflow_stages':
                rows += [{**rows[0], 'id':401,'run_id':201},{**rows[0], 'id':501,'job_id':201}]
            elif name == 'prompts':
                rows += [{**rows[0], 'id':401,'is_system':True}]
            elif name == 'final_actionable_history':
                rows += [{**rows[0], 'id':401,'rebalance_run_id':201},{**rows[0], 'id':501,'workflow_id':201},
                         {**rows[0], 'id':601,'technical_scan_run_id':201},{**rows[0], 'id':701,'workflow_id':None,'technical_scan_run_id':None}]
            elif name == 'llm_provider_usage_calls':
                rows += [{**rows[0], 'id':401,'job_id':201},{**rows[0], 'id':501,'job_id':None}]
            await self.connection.execute(insert(table), rows)
        self.ddl = statements(plan.review_sql().replace(plan.OWNER_PLACEHOLDER, '71').replace('__VERIFIED_DATABASE_IDENTIFIER__', self.url.database))
        self.audit = plan.audit_sql()
        await self.connection.exec_driver_sql('SAVEPOINT before_provision')

    async def asyncTearDown(self):
        if self.transaction.is_active:
            await self.transaction.rollback()
        await self.connection.close()
        await self.engine.dispose()

    async def provision(self, with_audit=True, before_schema=None):
        for statement in self.ddl:
            if before_schema and statement.startswith('CREATE SCHEMA'):
                await self.connection.exec_driver_sql(before_schema)
            if not with_audit and statement.startswith('DO $audit$'):
                continue
            await self.connection.exec_driver_sql(statement)

    async def reject(self, operation, state='42501'):
        await self.connection.exec_driver_sql('SAVEPOINT denied_operation')
        try:
            with self.subTest(operation=operation, expected_sqlstate=state):
                with self.assertRaises(DBAPIError, msg=operation) as denied:
                    await self.connection.exec_driver_sql(operation)
                self.assertEqual(denied.exception.orig.sqlstate, state)
        finally:
            await self.connection.exec_driver_sql('ROLLBACK TO SAVEPOINT denied_operation')

    async def test_all_eleven_views_exclude_other_null_and_mismatched_owners(self):
        await self.provision()
        await self.connection.exec_driver_sql('SET LOCAL ROLE credx_viewer_read')
        for item in plan.catalog()['relations']:
            name = item['relation']
            ids = set((await self.connection.execute(text(f'SELECT id FROM credx_viewer."{name}"'))).scalars())
            expected = {101,701} if name == 'final_actionable_history' else {101,501} if name == 'llm_provider_usage_calls' else {101}
            self.assertEqual(ids, expected, name)
            self.assertIsNone(await self.connection.scalar(text(f'SELECT id FROM credx_viewer."{name}" WHERE id=201')))

    async def test_effective_role_denies_base_forbidden_columns_writes_ddl_sequence(self):
        await self.provision()
        await self.connection.exec_driver_sql('CREATE SEQUENCE public.fixture_sequence')
        await self.connection.exec_driver_sql('SET LOCAL ROLE credx_viewer_read')
        # Transaction is intentionally READ WRITE: prove ACL denial independently
        # from the additional default_transaction_read_only safeguard.
        for statement in [
            'SELECT id FROM public.jobs', 'SELECT forbidden_payload FROM public.jobs',
            "UPDATE credx_viewer.jobs SET status='changed' WHERE id=101",
            "UPDATE public.jobs SET status='changed' WHERE id=101",
            'CREATE TABLE public.viewer_forbidden(id int)', 'CREATE TEMP TABLE viewer_forbidden(id int)',
            'CREATE SCHEMA viewer_forbidden', "SELECT nextval('public.fixture_sequence')",
            # SET ROLE authority follows session_user, so switching denial is
            # tested below using an actual authenticated viewer connection.
        ]:
            await self.reject(statement)
        await self.connection.exec_driver_sql('RESET ROLE')
        await self.connection.exec_driver_sql('SET LOCAL ROLE credx_viewer_views')
        await self.reject('SELECT forbidden_payload FROM public.jobs')
        await self.reject('SELECT id,forbidden_payload FROM public.jobs')

    async def test_projected_schema_excludes_forbidden_columns(self):
        await self.provision()
        await self.connection.exec_driver_sql('SET LOCAL ROLE credx_viewer_read')
        for item in plan.catalog()['relations']:
            await self.reject('SELECT forbidden_payload FROM credx_viewer."'+item['relation']+'"',state='42703')

    async def test_public_and_role_hazards_fail_closed_without_global_production_changes(self):
        await self.provision()
        database = self.connection.dialect.identifier_preparer.quote(self.url.database)
        hazards = [
            f'GRANT TEMP ON DATABASE {database} TO PUBLIC',
            'GRANT CREATE ON SCHEMA public TO PUBLIC',
            'GRANT SELECT (forbidden_payload) ON public.jobs TO PUBLIC',
            'GRANT viewer_fixture_other TO credx_viewer_read',
            'GRANT credx_viewer_views TO credx_viewer_read',
            'GRANT SELECT ON public.jobs TO credx_viewer_views',
            'GRANT SELECT (status) ON public.jobs TO credx_viewer_views WITH GRANT OPTION',
            'ALTER ROLE credx_viewer_views LOGIN',
            'GRANT SELECT (rolpassword) ON pg_catalog.pg_authid TO PUBLIC',
            'GRANT SELECT (forbidden_payload) ON public.jobs TO credx_viewer_views',
            'GRANT UPDATE (status) ON public.jobs TO credx_viewer_views',
            'GRANT USAGE ON SCHEMA credx_viewer TO viewer_fixture_other',
            'GRANT SELECT ON credx_viewer.jobs TO viewer_fixture_other',
            'GRANT SELECT ON credx_viewer.jobs TO credx_viewer_read WITH GRANT OPTION',
            "CREATE FUNCTION public.viewer_fixture_function() RETURNS int LANGUAGE SQL SECURITY DEFINER AS 'SELECT 1'",
        ]
        for hazard in hazards:
            await self.connection.exec_driver_sql('SAVEPOINT hazard')
            await self.connection.exec_driver_sql(hazard)
            with self.subTest(hazard=hazard):
                with self.assertRaises(DBAPIError) as rejected:
                    await self.connection.exec_driver_sql(self.audit)
                self.assertEqual(rejected.exception.orig.sqlstate,'P0001')
            await self.connection.exec_driver_sql('ROLLBACK TO SAVEPOINT hazard')
            await self.connection.exec_driver_sql(self.audit)

    async def test_default_acl_grantee_and_schema_default_acl_are_rejected(self):
        for kind in ['TABLES','SCHEMAS','GRANT_OPTION']:
            await self.connection.exec_driver_sql('SAVEPOINT default_acl')
            if kind == 'SCHEMAS':
                hook='ALTER DEFAULT PRIVILEGES FOR ROLE credx_viewer_views GRANT USAGE ON SCHEMAS TO viewer_fixture_other'
            elif kind == 'TABLES':
                hook='ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO viewer_fixture_other'
            else:
                hook='ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO credx_viewer_read WITH GRANT OPTION'
            with self.subTest(default_acl=kind):
                with self.assertRaises(DBAPIError) as rejected:
                    await self.provision(before_schema=hook)
                self.assertEqual(rejected.exception.orig.sqlstate,'P0001')
            await self.connection.exec_driver_sql('ROLLBACK TO SAVEPOINT default_acl')

    async def test_audit_failure_rolls_back_roles_and_schema(self):
        database = self.connection.dialect.identifier_preparer.quote(self.url.database)
        await self.connection.exec_driver_sql(f'GRANT TEMP ON DATABASE {database} TO PUBLIC')
        with self.assertRaises(DBAPIError) as rejected:
            await self.provision()
        self.assertEqual(rejected.exception.orig.sqlstate,'P0001')
        await self.connection.exec_driver_sql('ROLLBACK TO SAVEPOINT before_provision')
        self.assertEqual(await self.connection.scalar(text("SELECT count(*) FROM pg_roles WHERE rolname IN ('credx_viewer_read','credx_viewer_views')")), 0)
        self.assertEqual(await self.connection.scalar(text("SELECT count(*) FROM pg_namespace WHERE nspname='credx_viewer'")), 0)


    async def test_actual_viewer_login_is_restricted_even_in_readwrite_transaction(self):
        await self.provision()
        await self.connection.exec_driver_sql("ALTER ROLE credx_viewer_read PASSWORD 'synthetic-viewer-password'")
        await self.connection.exec_driver_sql('CREATE SEQUENCE public.fixture_sequence')
        await self.transaction.commit()  # only in the explicitly disposable fixture cluster
        reader = create_async_engine(self.url.set(username='credx_viewer_read',password='synthetic-viewer-password'),poolclass=NullPool,hide_parameters=True)
        service = None
        try:
            module_spec=importlib.util.spec_from_file_location('pg_viewer_browser',HERE/'browser.py')
            browser=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(browser)
            service=browser.Store(self.url.set(username='credx_viewer_read',password='synthetic-viewer-password'))
            await service.verify()
            for item in plan.catalog()['relations']:
                records=await service.rows(item,51)
                expected={101,701} if item['relation']=='final_actionable_history' else {101,501} if item['relation']=='llm_provider_usage_calls' else {101}
                self.assertEqual({int(row['id']) for row in records},expected)
            await service.close();service=None
            async with reader.connect() as connection:
                self.assertEqual(tuple((await connection.execute(text('SELECT session_user,current_user'))).one()),('credx_viewer_read','credx_viewer_read'))
                self.assertEqual(await connection.scalar(text('SHOW default_transaction_read_only')),'on')
                ids=set((await connection.execute(text('SELECT id FROM credx_viewer.jobs'))).scalars())
                self.assertEqual(ids,{101})
            for statement in ['SELECT id FROM public.jobs', 'SELECT forbidden_payload FROM public.jobs',
                    "UPDATE credx_viewer.jobs SET status='changed'", "UPDATE public.jobs SET status='changed'",
                'CREATE TABLE public.forbidden(id int)', 'CREATE TEMP TABLE forbidden(id int)',
                'CREATE SCHEMA viewer_forbidden', "SELECT nextval('public.fixture_sequence')",
                'SET ROLE credx_viewer_views', 'SET ROLE viewer_fixture_admin']:
                async with reader.connect() as connection:
                    await connection.exec_driver_sql('SET TRANSACTION READ WRITE')
                    self.assertEqual(await connection.scalar(text('SHOW transaction_read_only')),'off')
                    self.assertEqual(tuple((await connection.execute(text('SELECT session_user,current_user'))).one()),('credx_viewer_read','credx_viewer_read'))
                    with self.subTest(viewer_login_statement=statement):
                        with self.assertRaises(DBAPIError, msg=statement) as denied:
                            await connection.exec_driver_sql(statement)
                        self.assertEqual(denied.exception.orig.sqlstate,'42501')
        finally:
            if service is not None:
                await service.close()
            await reader.dispose()
            # Explicit fixture cleanup only: no CASCADE, no unknown-object deletion.
            async with self.engine.begin() as connection:
                for item in reversed(plan.catalog()['relations']):
                    await connection.exec_driver_sql('DROP VIEW credx_viewer."'+item['relation']+'"')
                await connection.exec_driver_sql('DROP SCHEMA credx_viewer')
                await connection.run_sync(self.metadata.drop_all)
                await connection.exec_driver_sql('DROP SEQUENCE public.fixture_sequence')
                database=connection.dialect.identifier_preparer.quote(self.url.database)
                await connection.exec_driver_sql('REVOKE CONNECT ON DATABASE '+database+' FROM credx_viewer_read')
                await connection.exec_driver_sql('REVOKE USAGE ON SCHEMA public FROM credx_viewer_views')
                for role in ['credx_viewer_read','credx_viewer_views','viewer_fixture_other']:
                    await connection.exec_driver_sql('DROP ROLE '+role)
                for name,create,temp in self.public_defaults:
                    quoted=connection.dialect.identifier_preparer.quote(name)
                    if create:
                        await connection.exec_driver_sql('GRANT CREATE ON DATABASE '+quoted+' TO PUBLIC')
                    if temp:
                        await connection.exec_driver_sql('GRANT TEMP ON DATABASE '+quoted+' TO PUBLIC')
                if self.public_schema_create:
                    await connection.exec_driver_sql('GRANT CREATE ON SCHEMA public TO PUBLIC')


if __name__ == '__main__':
    unittest.main()
