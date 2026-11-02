"""Opt-in bounded synthetic PostgreSQL conformance; never reads DATABASE_URL.

Only the marked A11 local Unix-socket fixture is supported. This is not an
archive/restore adapter or proof of any historical snapshot or production data.
"""
from dataclasses import replace
from datetime import date, datetime, timezone, timedelta
from decimal import Decimal
from pathlib import Path
import unittest
from uuid import UUID, uuid4

from acceptance import COVERAGE, VERSION, Manifest, compare, row_digest, table_digest
from scalar_codecs import scalar

SOCKET = Path('/tmp/a11-pg-socket/.s.PGSQL.55432')
MARKER = Path('/tmp/a11-pg-run/A11_SYNTHETIC_ONLY')


@unittest.skipUnless(SOCKET.exists() and MARKER.exists(), 'marked local synthetic PostgreSQL unavailable')
class PostgresConformance(unittest.TestCase):
    def setUp(self):
        import sqlalchemy as sa
        self.sa = sa
        self.engine = sa.create_engine('postgresql+psycopg2://agent@/postgres?host=/tmp/a11-pg-socket&port=55432')

    def tearDown(self):
        self.engine.dispose()

    def test_supported_scalar_roundtrips_and_server_timezone(self):
        cases = [('text', 'é'), ('text', ''), ('bytea', b'\x00\xff'),
                 ('int2', -32768), ('int4', 2147483647), ('int8', -(2**63)),
                 ('bool', False), ('numeric', Decimal('123456.7800')),
                 ('numeric', Decimal('-0.000')), ('numeric', Decimal('NaN')),
                 ('float8', -0.0), ('float8', 0.0), ('float8', float('nan')),
                 ('float8', float('inf')), ('float8', -float('inf')),
                 ('date', date(2026, 11, 1)), ('timestamp', datetime(2026, 11, 1, 12, 2, 3, 456789)),
                 ('timestamptz', datetime(2026, 11, 1, tzinfo=timezone(timedelta(hours=5)))),
                 ('uuid', UUID(int=123))]
        with self.engine.connect() as db:
            db.execute(self.sa.text("SET TIME ZONE 'America/New_York'"))
            for kind, original in cases:
                with self.subTest(kind=kind, value=repr(original)):
                    # Type names are a fixed test whitelist, never arbitrary input.
                    # Text input preserves float signed zero at the SQL boundary.
                    value = str(original) if kind in {'uuid', 'float8'} else original
                    actual = db.scalar(self.sa.text(f'SELECT CAST(:value AS {kind})'), {'value': value})
                    if kind == 'bytea': actual = bytes(actual)
                    if kind == 'uuid': actual = UUID(str(actual))
                    self.assertEqual(row_digest([scalar(kind, original)]), row_digest([scalar(kind, actual)]))
                    null = db.scalar(self.sa.text(f'SELECT CAST(NULL AS {kind})'))
                    self.assertEqual(row_digest([scalar(kind, None)]), row_digest([scalar(kind, null)]))

    def test_actual_shared_snapshot_rows_and_mismatch_rejection(self):
        sa = self.sa
        schema = 'a11_restore_synthetic_' + uuid4().hex
        table = sa.Table('rows', sa.MetaData(), sa.Column('id', sa.Integer, primary_key=True),
                         sa.Column('value', sa.Text), schema=schema)
        try:
            with self.engine.begin() as db:
                db.execute(sa.schema.CreateSchema(schema))
                table.create(db)
                db.execute(table.insert(), [{'id': 1, 'value': None}, {'id': 2, 'value': ''}, {'id': 3, 'value': 'synthetic'}])
            with self.engine.connect().execution_options(isolation_level='REPEATABLE READ') as left:
                with left.begin():
                    snapshot = left.scalar(sa.text('SELECT pg_export_snapshot()'))
                    def digest(db):
                        return table_digest(sorted(row_digest([scalar('int4', r.id), scalar('text', r.value)])
                                                   for r in db.execute(sa.select(table))))
                    baseline = digest(left)
                    with self.engine.connect().execution_options(isolation_level='REPEATABLE READ') as right:
                        with right.begin():
                            right.execute(sa.text('SET TRANSACTION SNAPSHOT :snapshot'), {'snapshot': snapshot})
                            restored = digest(right)
                    metadata = {key: 'b' * 64 for key in COVERAGE - {'tables'}}
                    manifest = Manifest(snapshot, 'a' * 64, True, False, VERSION, COVERAGE,
                                        {'synthetic-table': baseline}, metadata)
                    pair = replace(manifest, tables={'synthetic-table': restored})
                    self.assertEqual(compare(manifest, pair), 'pass')
                    self.assertEqual(compare(manifest, replace(pair, snapshot='different-synthetic-snapshot')), 'unknown')
                    self.assertEqual(compare(manifest, replace(pair, snapshot_lost=True)), 'unknown')
                    self.assertEqual(compare(manifest, replace(pair, tables={'synthetic-table': table_digest([])})), 'error')
        finally:
            with self.engine.begin() as db:
                db.execute(sa.schema.DropSchema(schema, cascade=True, if_exists=True))
