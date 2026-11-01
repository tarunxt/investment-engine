"""GET-only native viewer. No application imports, credentials in HTTP, or SQL input."""
import asyncio
import base64
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from html import escape
import json
from pathlib import Path
from urllib.parse import urlencode

from fastapi import FastAPI, Request
from starlette.responses import HTMLResponse
from sqlalchemy import BigInteger, Column, MetaData, String, Table, Text, case, cast, func, literal, or_, select, text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.engine import make_url

HERE = Path(__file__).parent
CATALOG = json.loads((HERE / 'catalog.json').read_text())
RELATIONS = {item['relation']: item for item in CATALOG['relations']}
MAX_KEY = 2**63 - 1


class Unavailable(Exception):
    pass


class Invalid(Exception):
    pass


def positive(value):
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal() or not 0 < int(value) <= MAX_KEY:
        raise Invalid()
    return int(value)


def filters(params, item):
    pairs = list(params.multi_items())
    if len({key for key, _ in pairs}) != len(pairs) or set(params) - {'column', 'value', 'limit', 'before'}:
        raise Invalid()
    limit = positive(params.get('limit', '25'))
    if limit > 50:
        raise Invalid()
    column, value = params.get('column'), params.get('value')
    if column == '' and value == '':
        column, value = None, None
    if column is None and value is not None or column is not None and (column not in item['columns'] or value is None or len(value) > 256):
        raise Invalid()
    if column == 'id':
        positive(value)
    return limit, (column, value) if column is not None else None


def cursor(item, condition, key):
    payload = {'v': 1, 'relation': item['relation'], 'filter': condition, 'sort': 'id_desc', 'key': str(key)}
    return base64.urlsafe_b64encode(json.dumps(payload, separators=(',', ':')).encode()).decode().rstrip('=')


def cursor_key(value, item, condition):
    if not value or len(value) > 1024:
        raise Invalid()
    try:
        def unique(pairs):
            if len({key for key, _ in pairs}) != len(pairs):
                raise Invalid()
            return dict(pairs)
        raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
        payload = json.loads(raw, object_pairs_hook=unique)
        if not isinstance(payload, dict) or type(payload.get('v')) is not int:
            raise Invalid()
        key = positive(payload['key'])
        if payload != {'v': 1, 'relation': item['relation'], 'filter': list(condition) if condition else None, 'sort': 'id_desc', 'key': str(key)}:
            raise Invalid()
        return key
    except (ValueError, KeyError, TypeError, UnicodeError):
        raise Invalid() from None


class Store:
    def __init__(self, dsn):
        try:
            url = make_url(dsn)
            if url.drivername != 'postgresql+asyncpg' or url.host != '127.0.0.1' or url.username != 'credx_viewer_read' or not url.password or not url.database or url.query:
                raise Unavailable()
        except Exception:
            raise Unavailable() from None
        self.audit_sql = (HERE / 'privilege-audit.review.sql').read_text()
        self.engine = create_async_engine(dsn, pool_size=2, max_overflow=0, pool_timeout=.5,
            hide_parameters=True, echo=False, connect_args={'timeout': 3, 'server_settings': {
                'default_transaction_read_only': 'on', 'statement_timeout': '3000',
                'lock_timeout': '500', 'idle_in_transaction_session_timeout': '5000', 'TimeZone': 'UTC'}})
        metadata = MetaData()
        self.tables = {key: Table(key, metadata, *(Column(name, BigInteger if name == 'id' else Text) for name in item['columns']), schema='credx_viewer') for key, item in RELATIONS.items()}
        self.info = Table('columns', metadata, Column('table_schema', String), Column('table_name', String),
            Column('column_name', String), Column('data_type', String), Column('ordinal_position', BigInteger), schema='information_schema')

    @asynccontextmanager
    async def connection(self):
        async with self.engine.connect() as connection:
            async with connection.begin():
                await connection.exec_driver_sql('SET TRANSACTION READ ONLY')
                if await connection.scalar(text('SELECT current_user')) != 'credx_viewer_read':
                    raise Unavailable()
                await connection.exec_driver_sql(self.audit_sql)
                yield connection

    async def verify(self):
        async with self.connection():
            pass

    async def structure(self):
        async with self.connection() as connection:
            rows = (await connection.execute(select(self.info.c.table_name, self.info.c.column_name, self.info.c.data_type)
                .where(self.info.c.table_schema == 'credx_viewer', self.info.c.table_name.in_(RELATIONS))
                .order_by(self.info.c.table_name, self.info.c.ordinal_position))).all()
            result = {}
            for relation, column, kind in rows:
                result.setdefault(relation, []).append((column, kind))
            return result

    async def rows(self, item, limit, condition=None, before=None, record=None):
        table = self.tables[item['relation']]
        values = [cast(table.c[name], Text) for name in item['columns']]
        oversized = or_(*(func.octet_length(value) > 4096 for value in values))
        query = select(*(case((func.octet_length(value) > 4096, literal(None)), else_=value).label(name) for name, value in zip(item['columns'], values)), oversized.label('_oversized'))
        if condition:
            column, value = condition
            query = query.where(table.c.id == positive(value)) if column == 'id' else query.where(cast(table.c[column], Text) == value)
        if before is not None:
            query = query.where(table.c.id < before)
        if record is not None:
            query = query.where(table.c.id == record)
        async with self.connection() as connection:
            rows = [dict(row) for row in (await connection.execute(query.order_by(table.c.id.desc()).limit(limit))).mappings()]
            if any(row.pop('_oversized') for row in rows):
                raise Unavailable()
            size = sum(len(str(value).encode()) for row in rows for value in row.values() if value is not None)
            if size > (65_536 if record is not None else 262_144):
                raise Unavailable()
            return rows

    async def close(self):
        await self.engine.dispose()


def page(title, body, status=200):
    html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(title) + '</title><style>' + '''
h1,li,dt,dd,a{overflow-wrap:anywhere}body{font:16px system-ui;margin:0;background:#f8fafc;color:#0f172a}main{max-width:1200px;margin:auto;padding:24px}a{color:#155e75}a,input,select,button{min-height:36px}a:focus-visible,input:focus-visible,select:focus-visible,button:focus-visible{outline:3px solid #0369a1;outline-offset:3px}table{border-collapse:collapse;min-width:100%;width:max-content}td,th{padding:10px;border:1px solid #cbd5e1;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;min-width:140px;max-width:320px}td:first-child,th:first-child{min-width:72px}th{background:#e2e8f0}form{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}label{display:grid;gap:4px}.scroll{overflow:auto;margin:16px 0;border:1px solid #cbd5e1}.notice{padding:16px;border:1px solid #cbd5e1;background:white}nav{display:flex;flex-wrap:wrap;gap:20px;margin:20px 0}small{display:block;margin-top:20px}@media(max-width:600px){main{padding:16px}td,th{padding:8px}}
''' + '</style></head><body><main><nav aria-label="Database navigation"><a href="/database">Database</a><a href="/console/dashboard">Back to console</a></nav><h1>' + escape(title) + '</h1>' + body + '<small>Only permitted owner-scoped columns and records are shown. No edits, SQL console, imports or exports.</small></main></body></html>'
    if len(html.encode()) > 1_048_576:
        return page('Read limit exceeded', '<p role="alert">This read exceeds the response limit. Use a smaller page or another exact filter.</p>', 503)
    return HTMLResponse(html, status_code=status, headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff'})


def make_app(store):
    @asynccontextmanager
    async def lifespan(_app):
        try:
            await store.verify()
        except Exception:
            raise RuntimeError('Viewer database privileges could not be verified') from None
        try:
            yield
        finally:
            await store.close()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    active = asyncio.Semaphore(2)

    @app.middleware('http')
    async def bounded(request, call_next):
        if request.method not in {'GET', 'HEAD'}:
            return page('Method unavailable', '<p>Only read requests are permitted.</p>', 405)
        if request.headers.get('authorization') or request.headers.get('cookie'):
            return page('Request unavailable', '<p>Application credentials must not reach this viewer.</p>', 400)
        if len(request.scope.get('raw_path', b'')) > 2048 or len(request.scope.get('query_string', b'')) > 2048:
            return page('Request unavailable', '<p>The request exceeds the read limit.</p>', 400)
        acquired = False
        try:
            await asyncio.wait_for(active.acquire(), timeout=.1)
            acquired = True
            async with asyncio.timeout(4):
                response = await call_next(request)
            return response
        except Exception:
            # No SQL, connection strings, row data, identity or exception text in logs/HTTP.
            return page('Database is unavailable', '<p role="alert">Records could not be checked. This does not mean the database is empty. Retry this read or return to the console.</p>', 503)
        finally:
            if acquired:
                active.release()

    async def available(item):
        structure = await store.structure()
        columns = structure.get(item['relation'])
        if not columns or [name for name, _ in columns] != item['columns']:
            raise Unavailable()
        return columns

    @app.api_route('/', methods=['GET', 'HEAD'])
    async def root():
        structure = await store.structure()
        entries, ready = [], 0
        for key, item in RELATIONS.items():
            ok = [name for name, _ in structure.get(key, [])] == item['columns']
            ready += int(ok)
            entries.append('<li>' + (f'<a href="/database/tables/{key}">{key}</a>' if ok else escape(key) + ' — unavailable; records unverified') + '</li>')
        notice = '' if ready == len(RELATIONS) else '<p role="alert">Some permitted tables are unavailable. Missing access is not an empty result.</p>'
        return page('Database', notice + '<p>Permitted table projections. Select a table to inspect structure and saved rows.</p><ul>' + ''.join(entries) + '</ul>', 200 if ready else 503)

    @app.api_route('/tables/{relation}', methods=['GET', 'HEAD'])
    async def rows(request: Request, relation: str):
        item = RELATIONS.get(relation)
        if not item:
            return page('Table unavailable', '<p>This table is outside the permitted catalog.</p>', 404)
        try:
            limit, condition = filters(request.query_params, item)
            before = cursor_key(request.query_params['before'], item, condition) if 'before' in request.query_params else None
        except Invalid:
            return page('Invalid read request', '<p>Use an approved column, bounded page size and matching page cursor.</p>', 400)
        structure = await available(item)
        data = await store.rows(item, limit + 1, condition, before)
        current, more = data[:limit], len(data) > limit
        options = '<option value="">Select a column</option>' + ''.join(f'<option value="{name}"'+(' selected' if condition and condition[0] == name else '')+'>'+name+'</option>' for name in item['columns'])
        form = f'<form method="get" action="/database/tables/{relation}"><label>Exact-match column<select name="column">{options}</select></label><label>Value<input name="value" maxlength="256" value="{escape(condition[1], quote=True) if condition else ""}"></label><label>Rows per page<input type="number" name="limit" min="1" max="50" value="{limit}"></label><button type="submit">Filter</button></form><a href="/database/tables/{relation}">Clear filters and pagination</a>'
        description = '<details><summary>Permitted table structure</summary><ul>' + ''.join('<li>'+escape(name)+' — '+escape(kind)+'</li>' for name, kind in structure) + '</ul></details>'
        if not current:
            body = '<p role="status">No permitted records match this read.</p>'
        else:
            header = ''.join('<th scope="col">'+escape(name)+'</th>' for name in item['columns']) + '<th scope="col">Detail</th>'
            body = '<p>Scroll the saved rows horizontally to inspect remaining columns. Keyboard users can focus the region and use arrow keys.</p><div class="scroll" role="region" aria-label="Saved rows" tabindex="0"><table><thead><tr>'+header+'</tr></thead><tbody>'
            for row in current:
                body += '<tr>' + ''.join('<td>'+('NULL' if row[name] is None else escape(row[name]))+'</td>' for name in item['columns']) + f'<td><a href="/database/tables/{relation}/rows/{row["id"]}">Open row {row["id"]}</a></td></tr>'
            body += '</tbody></table></div>'
        if more:
            values = {'limit': str(limit), 'before': cursor(item, condition, current[-1]['id'])}
            if condition:
                values.update(column=condition[0], value=condition[1])
            body += '<nav aria-label="Row pagination"><a href="/database/tables/'+relation+'?'+escape(urlencode(values), quote=True)+'">Next page</a></nav>'
        return page(relation, description + form + body + '<p>Read at '+datetime.now(timezone.utc).isoformat()+'. Rows are ordered by their unique ID; this is not a frozen cross-page snapshot.</p>')

    @app.api_route('/tables/{relation}/rows/{record}', methods=['GET', 'HEAD'])
    async def detail(request: Request, relation: str, record: str):
        item = RELATIONS.get(relation)
        if not item:
            return page('Row unavailable', '<p>This row could not be found in the permitted catalog.</p>', 404)
        try:
            key = positive(record)
            if request.query_params:
                raise Invalid()
        except Invalid:
            return page('Invalid read request', '<p>A valid saved-row identifier is required.</p>', 400)
        await available(item)
        data = await store.rows(item, 1, record=key)
        if not data:
            return page('Row unavailable', '<p>No permitted record matches this identifier.</p>', 404)
        body = '<dl>' + ''.join('<dt>'+escape(name)+'</dt><dd>'+('NULL' if data[0][name] is None else escape(data[0][name]))+'</dd>' for name in item['columns']) + '</dl>'
        return page(relation + ' — row ' + str(key), body)
    return app
