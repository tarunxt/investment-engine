import asyncio
import importlib.util
from pathlib import Path
import unittest
import httpx
from starlette.datastructures import QueryParams

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('viewer_browser', HERE / 'browser.py')
browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)


class FakeStore:
    def __init__(self):
        self.failed = False
        self.partial = False
        self.empty = False
        self.calls = []
        self.closed = False

    async def verify(self):
        pass

    async def structure(self):
        self.calls.append('structure')
        if self.failed:
            raise RuntimeError('postgresql://secret@private-host/private-database')
        return {key: [(name, 'text') for name in item['columns']] for key, item in browser.RELATIONS.items() if not self.partial or key != 'jobs'}

    async def rows(self, item, limit, condition=None, before=None, record=None):
        self.calls.append(('rows', item['relation'], limit, condition, before, record))
        data = [{name: 'synthetic' for name in item['columns']} for _ in range(60)]
        for index, row in enumerate(data):
            row.update(id=str(60-index))
            if 'status' in row:
                row['status'] = 'completed' if index % 2 == 0 else 'pending'
            if 'estimated_cost' in row:
                row['estimated_cost'] = '0.123456789123456789'
            if 'stock_name' in row:
                row['stock_name'] = '<script>synthetic</script>'
        if self.empty:
            return []
        if condition:
            data = [row for row in data if row[condition[0]] == condition[1]]
        if before is not None:
            data = [row for row in data if int(row['id']) < before]
        if record is not None:
            data = [row for row in data if int(row['id']) == record]
        return data[:limit]

    async def close(self):
        self.closed = True


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = FakeStore()
        self.app = browser.make_app(self.store)
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://viewer.invalid')

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.lifespan.__aexit__(None, None, None)
        self.assertTrue(self.store.closed)

    async def test_catalog_structure_rows_detail_precision_and_escaping(self):
        root = await self.client.get('/')
        self.assertEqual(root.status_code, 200)
        for key in browser.RELATIONS:
            self.assertIn(key, root.text)
        rows = await self.client.get('/tables/jobs')
        self.assertEqual(rows.status_code, 200)
        self.assertIn('0.123456789123456789', rows.text)
        self.assertIn('Next page', rows.text)
        self.assertIn('Permitted table structure', rows.text)
        self.assertNotIn('request_context_json', rows.text)
        detail = await self.client.get('/tables/final_actionable_history/rows/60')
        self.assertEqual(detail.status_code, 200)
        self.assertIn('&lt;script&gt;synthetic&lt;/script&gt;', detail.text)
        self.assertEqual((await self.client.get('/tables/jobs/rows/999')).status_code, 404)
        self.assertEqual((await self.client.head('/tables/jobs')).content, b'')
        self.assertEqual(rows.headers['cache-control'], 'no-store')

    async def test_empty_partial_failed_and_recovery_are_distinct(self):
        self.store.empty = True
        response = await self.client.get('/tables/jobs')
        self.assertEqual(response.status_code, 200)
        self.assertIn('No permitted records match', response.text)
        self.store.empty = False
        self.store.partial = True
        response = await self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn('Some permitted tables are unavailable', response.text)
        self.assertEqual((await self.client.get('/tables/jobs')).status_code, 503)
        self.store.failed = True
        response = await self.client.get('/tables/jobs')
        self.assertEqual(response.status_code, 503)
        self.assertIn('does not mean the database is empty', response.text)
        self.assertNotIn('secret', response.text)
        self.assertNotIn('private-host', response.text)
        self.store.failed = self.store.partial = False
        self.assertEqual((await self.client.get('/tables/jobs')).status_code, 200)

    async def test_unsupported_routes_methods_and_credentials_never_query(self):
        for method in ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']:
            self.assertEqual((await self.client.request(method, '/tables/jobs')).status_code, 405)
        for header in [{'Cookie': 'authjs.session-token=synthetic'}, {'Authorization': 'Bearer synthetic'}]:
            self.assertEqual((await self.client.get('/', headers=header)).status_code, 400)
        for path in ['/tables/users', '/tables/zerodha_credentials', '/openapi.json', '/docs']:
            self.assertEqual((await self.client.get(path)).status_code, 404)
        self.assertEqual(self.store.calls, [])

    async def test_bad_filters_duplicates_cursor_replay_and_injection_do_not_query(self):
        cases = ['column=id&value=1OR1%3D1', 'limit=51', 'limit=0', 'limit=NaN', 'column=user_id&value=71', 'column=id;DROP+TABLE+jobs&value=x',
                 'column=status', 'value=x', 'sql=SELECT+1', 'limit=25&limit=1', 'before=bad']
        for query in cases:
            response = await self.client.get('/tables/jobs?' + query)
            self.assertEqual(response.status_code, 400, query)
        item = browser.RELATIONS['jobs']
        token = browser.cursor(item, ('status', 'completed'), '30')
        self.assertEqual((await self.client.get('/tables/runs', params={'before': token})).status_code, 400)
        self.assertEqual((await self.client.get('/tables/jobs', params={'before': token,'column':'status','value':'pending'})).status_code, 400)
        self.assertEqual(self.store.calls, [])
        response = await self.client.get('/tables/jobs', params={'before': token,'column':'status','value':'completed'})
        self.assertEqual(response.status_code, 200)
        last = next(call for call in reversed(self.store.calls) if isinstance(call, tuple))
        self.assertEqual(last[4], 30)
        self.assertEqual(last[3], ('status', 'completed'))

    async def test_request_cancellation_releases_concurrency_slot(self):
        started = asyncio.Event()
        original = self.store.structure
        async def pending():
            started.set()
            await asyncio.Event().wait()
        self.store.structure = pending
        task = asyncio.create_task(self.client.get('/'))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.store.structure = original
        self.assertEqual((await self.client.get('/')).status_code, 200)

    def test_store_rejects_application_or_remote_credentials_without_connecting(self):
        for dsn in ['postgresql+asyncpg://application_writer:synthetic@127.0.0.1/test',
                    'postgresql+asyncpg://credx_viewer_read:synthetic@elsewhere.invalid/test',
                    'postgresql+asyncpg://credx_viewer_read:synthetic@127.0.0.1/test?options=unsafe',
                    'postgresql+asyncpg://credx_viewer_read@127.0.0.1/test']:
            with self.assertRaises(browser.Unavailable):
                browser.Store(dsn,approved_other_database="postgres")

    def test_cursor_context_and_blank_filter_contract(self):
        item = browser.RELATIONS['jobs']
        token = browser.cursor(item, None, '9')
        self.assertEqual(browser.cursor_key(token, item, None), 9)
        self.assertEqual(browser.filters(QueryParams('column=&value=&limit=25'), item), (25, None))
        with self.assertRaises(browser.Invalid):
            browser.cursor_key(token, browser.RELATIONS['runs'], None)

    def test_store_requires_exact_private_temporary_database_policy(self):
        for other in [None,'',123,'x'*64,'bad\0name','synthetic']:
            with self.subTest(other=other):
                with self.assertRaises(browser.Unavailable):
                    browser.Store('postgresql+asyncpg://credx_viewer_read:synthetic@127.0.0.1/synthetic',approved_other_database=other)


if __name__ == '__main__':
    unittest.main()
